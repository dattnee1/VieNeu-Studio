const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const BACKEND_PORT = 8722;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let backendProcess = null;
let mainWindow = null;

function resolvePython() {
  // Prefer a bundled venv python if present (set up by setup_backend.bat/.sh),
  // otherwise fall back to whatever "python" is on PATH.
  const venvPy = process.platform === 'win32'
    ? path.join(__dirname, '..', 'backend', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python');
  const fs = require('fs');
  if (fs.existsSync(venvPy)) return venvPy;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function startBackend() {
  const pythonExe = resolvePython();
  const serverScript = path.join(__dirname, '..', 'backend', 'server.py');

  backendProcess = spawn(pythonExe, [serverScript, '--port', String(BACKEND_PORT)], {
    cwd: path.join(__dirname, '..', 'backend'),
    env: { ...process.env },
  });

  backendProcess.stdout.on('data', (d) => console.log(`[vieneu-backend] ${d}`));
  backendProcess.stderr.on('data', (d) => console.error(`[vieneu-backend] ${d}`));
  backendProcess.on('close', (code) => console.log(`[vieneu-backend] exited (${code})`));
}

// Step 1: wait for the HTTP server itself to come up (fast).
function waitForServerAlive(retries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`${BACKEND_URL}/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else retryOrFail(n);
      }).on('error', () => retryOrFail(n));
    };
    const retryOrFail = (n) => {
      if (n <= 0) return reject(new Error('Backend server did not start'));
      setTimeout(() => attempt(n - 1), 500);
    };
    attempt(retries);
  });
}

// Step 2: wait for the model itself to finish loading (slow on first run —
// this is when weights download from Hugging Face). Long timeout, and
// surfaces the real error instead of failing silently.
function waitForModelReady(retries = 600) { // up to 10 min on first download
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`${BACKEND_URL}/ready`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode === 200) resolve();
          else if (n <= 0) reject(new Error(body || 'Model failed to load'));
          else setTimeout(() => attempt(n - 1), 1000);
        });
      }).on('error', () => {
        if (n <= 0) reject(new Error('Backend stopped responding while loading the model'));
        else setTimeout(() => attempt(n - 1), 1000);
      });
    };
    attempt(retries);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#12181B',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  try {
    await waitForServerAlive();
    mainWindow.webContents.send('backend-status', {
      ready: false,
      loading: true,
      url: BACKEND_URL,
      message: 'Đang tải mô hình (lần đầu có thể mất vài phút)…',
    });

    await waitForModelReady();
    mainWindow.webContents.send('backend-status', { ready: true, url: BACKEND_URL });
  } catch (err) {
    mainWindow.webContents.send('backend-status', {
      ready: false,
      error: true,
      url: BACKEND_URL,
      message: String(err.message || err),
    });
    dialog.showErrorBox(
      'VieNeu model failed to load',
      String(err.message || err).slice(0, 1500)
    );
  }
}

ipcMain.handle('get-backend-url', () => BACKEND_URL);

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
