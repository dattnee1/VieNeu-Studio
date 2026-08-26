# VieNeu Studio

A desktop UI for **VieNeu-TTS v3 Turbo**, built with Electron on the front end and a
small FastAPI service on the back end that wraps the official `vieneu` SDK
(`mode="v3turbo"` — 48 kHz, built-in speaker tokens, emotion cues, instant
cloning, batched Conversation mode).

## Design

- **Palette** — ink (`#12181B`), lacquer red (`#B23A2E`), gold leaf (`#C9A227`),
  parrot-feather green (`#3E7C59`), paper (`#EDE6D8`). Drawn from Vietnamese
  lacquerware and the parrot in VieNeu's own mark, not a generic dark-mode default.
- **Type** — Fraunces (display) + Be Vietnam Pro (body, built for Vietnamese
  diacritics) + JetBrains Mono (model/codec labels).
- **Signature element** — the "seal" (triện): a circular lacquer-red stamp is the
  Generate/Clone/Conversation control in every tab, with a gold ring that spins
  while audio renders — a nod to the wax/ink seal used to authenticate documents,
  here authenticating a voice.

## Project layout

```
vieneu-studio/
├── electron/        # main.js (spawns backend, opens window), preload.js
├── backend/         # FastAPI server wrapping the vieneu SDK
│   ├── server.py
│   ├── requirements.txt
│   ├── setup_backend.bat   (Windows)
│   └── setup_backend.sh    (macOS/Linux)
├── renderer/        # index.html, style.css, app.js (the UI itself)
└── package.json
```

## First-time setup

1. **Backend** (installs the `vieneu` SDK into a local venv):
   - Windows: double-click `backend/setup_backend.bat`
   - macOS/Linux: `bash backend/setup_backend.sh`

   This installs `vieneu` in **CPU/ONNX mode** by default (torch-free — runs
   v3 Turbo at 48 kHz on CPU). If you have a CUDA GPU and want the PyTorch
   engine instead, activate the venv and run `pip install "vieneu[gpu]"`.

2. **Electron shell**:
   ```
   npm install
   npm start
   ```

   On first launch the model weights (~1 GB) download from Hugging Face
   (`pnnbao-ump/VieNeu-TTS-v3-Turbo`) — this can take a minute.

## Packaging a distributable .exe / .app

```
npm run dist
```

This uses `electron-builder` (already in `devDependencies`) to produce a
Windows installer, macOS `.dmg`, or Linux `AppImage`, bundling the `backend/`
folder as an extra resource. End users still need Python available on their
machine the first time (or you can bundle a full Python distribution with
`electron-builder`'s `extraResources` + a portable Python — not included here
to keep the starter project light).

## Credits

Built on top of the open-source **VieNeu-TTS** project by Phạm Nguyễn Ngọc Bảo:
- GitHub: https://github.com/pnnbao97/VieNeu-TTS (Apache-2.0)
- Hugging Face: https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo
- Codec: MOSS-Audio-Tokenizer-Nano · Phonemizer: sea-g2p

This app is only a UI shell around that project — all credit for the model and
inference engine goes to the original authors.
"# VieNeu-Studio"  
