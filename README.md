# 🎙️ VieNeu Studio

> **Ứng dụng Desktop Text-to-Speech (TTS) chuyên nghiệp cho VieNeu-TTS v3 Turbo & Piper TTS**  
> *Chạy hoàn toàn Offline trên máy tính cá nhân • Giọng đọc tự nhiên • Tối ưu CPU/ONNX • Giao diện Sơn mài thuần Việt*

---

## ✨ Điểm nổi bật (Features)

- 🚀 **VieNeu-TTS v3 Turbo**: Tích hợp mô hình TTS tiếng Việt tiên tiến nhất với tần số lấy mẫu **48 kHz**, âm thanh trong trẻo, tự nhiên, giàu sắc thái cảm xúc (giọng Bắc, Nam, phong cách tin tức, tự nhiên, kể chuyện).
- 🧬 **Nhân bản giọng nói (Voice Cloning)**: Clone giọng nói tức thì chỉ với một file âm thanh mẫu (tham chiếu từ vài giây audio).
- 🌐 **Piper TTS Đa ngôn ngữ**: Tích hợp sẵn engine phụ trợ siêu nhẹ, hỗ trợ đọc văn bản đa ngôn ngữ (Tiếng Việt, Anh, Nhật, Trung, Pháp, Tây Ban Nha,...).
- ⚡ **Tối ưu hóa đa luồng ONNX Runtime**: Cho phép điều chỉnh số luồng CPU (Thread count) trong cài đặt và **áp dụng ngay lập tức** giúp tăng tốc độ sinh giọng theo cấu hình máy tính.
- 🎛️ **Không gian làm việc linh hoạt**:
  - **Phòng thu (Studio)**: Tạo giọng nói cho câu ngắn, đoạn văn với khả năng tùy biến giọng, tốc độ, hạt giống (seed).
  - **Bản ghi gần đây**: Kéo thả tùy chỉnh độ cao bảng lịch sử mượt mà, hỗ trợ nghe lại và **tải trực tiếp file `.wav`** cho từng lần tạo.
  - **Truyện & Sách nói**: Hỗ trợ phân đoạn và xử lý văn bản dài.
  - **Lồng tiếng & Video / Hội thoại**: Hỗ trợ kịch bản nhiều người nói (đối thoại đa nhân vật).
- 🎨 **Giao diện thuần Việt độc đáo**: Phong cách thiết kế lấy cảm hứng từ nghệ thuật **Sơn mài truyền thống** (Đỏ son `#B23A2E`, Dát vàng `#C9A227`, Giấy điệp `#EDE6D8`, Mực mun `#12181B`) cùng nút kích hoạt dạng **Triện ấn**.

---

## 📁 Cấu trúc dự án (Project Structure)

```
vieneu-studio/
├── electron/                 # Mã nguồn Electron (main process & preload bridge)
│   ├── main.js               # Quản lý vòng đời app, tự động gọi backend Python
│   └── preload.js            # Cầu nối IPC an toàn giữa Node.js và Renderer
├── backend/                  # Dịch vụ Backend FastAPI điều khiển các engine TTS
│   ├── server.py             # API Endpoint xử lý TTS, ONNX Runtime, Voice Clone
│   ├── requirements.txt      # Thư viện Python cần thiết (vieneu, onnxruntime, fastapi...)
│   ├── voices_meta.json      # Metadata phân loại giọng đọc (vùng miền, giới tính, phong cách)
│   ├── setup_backend.bat     # Script tự động tạo venv & cài thư viện trên Windows
│   └── setup_backend.sh      # Script cài đặt cho Linux/macOS
├── renderer/                 # Giao diện người dùng (Frontend)
│   ├── index.html            # Cấu trúc giao diện các tab chức năng
│   ├── style.css             # Hệ thống thiết kế & hiệu ứng chuyển động
│   └── app.js                # Logic tương tác, audio player, lưu lịch sử, kéo thả resize
├── package.json              # Cấu hình dự án Electron & kịch bản build
└── .gitignore                # Bỏ qua node_modules, cache và các file model nặng
```

---

## 🛠️ Hướng dẫn cài đặt & Khởi chạy (Quick Start)

### Yêu cầu hệ thống:
- **Hệ điều hành**: Windows 10/11 (64-bit), macOS hoặc Linux.
- **Node.js**: Phiên bản 18 trở lên ([Tải tại đây](https://nodejs.org/)).
- **Python**: Phiên bản 3.10 hoặc 3.11 ([Tải tại đây](https://www.python.org/)).

---

### Bước 1: Thiết lập môi trường Python Backend

1. Di chuyển vào thư mục dự án:
   ```bash
   cd vieneu-studio/backend
   ```
2. Chạy kịch bản cài đặt tự động:
   - **Trên Windows**: Nhấp đúp vào file `setup_backend.bat` (hoặc chạy trong CMD/PowerShell):
     ```cmd
     setup_backend.bat
     ```
   - **Trên Linux/macOS**:
     ```bash
     bash setup_backend.sh
     ```
   *Script sẽ tự tạo môi trường ảo `.venv` và cài đặt các thư viện cần thiết như `vieneu`, `fastapi`, `onnxruntime`, `uvicorn`...*

---

### Bước 2: Cài đặt Node.js dependencies & Khởi chạy ứng dụng

Quay lại thư mục gốc dự án và chạy:

```bash
cd ..
npm install
npm start
```

Ứng dụng Electron sẽ tự động khởi chạy, đồng thời kích hoạt service Python ở chế độ nền. Trong lần đầu khởi chạy mô hình, hệ thống sẽ tải các trọng số mô hình cần thiết từ Hugging Face về lưu trữ cục bộ để sử dụng ngoại tuyến cho các lần tiếp theo.

---

## 📦 Đóng gói ứng dụng (.exe Installer)

Dự án đã được cấu hình sẵn với `electron-builder`:

- **Tạo bản cài đặt Windows (NSIS Setup .exe)**:
  ```bash
  npm run dist
  ```
- **Tạo bản Portable (Chạy ngay không cần cài đặt)**:
  ```bash
  npm run dist:portable
  ```
- **Tạo thư mục giải nén để kiểm tra**:
  ```bash
  npm run dist:dir
  ```

File đầu ra sẽ nằm trong thư mục `dist/`.

---

## ⚙️ Cấu hình luồng xử lý (ONNX Performance)

Trong menu **Cài đặt**:
- Người dùng có thể kéo chọn số luồng xử lý ONNX (1 - 16 luồng tùy thuộc vào số lõi CPU của máy).
- Khi thay đổi, hệ thống sẽ **áp dụng tức thì** vào phiên làm việc hiện tại, tối ưu tốc độ render giọng nói theo thời gian thực mà không làm gián đoạn trải nghiệm.

---

## 📜 Bản quyền & Lời cảm ơn (Credits)

Dự án được xây dựng dựa trên công trình mã nguồn mở tuyệt vời:
- **VieNeu-TTS**: Phát triển bởi tác giả **Phạm Nguyễn Ngọc Bảo** ([pnnbao97/VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS)).
- Trọng số mô hình chính thức: [pnnbao-ump/VieNeu-TTS-v3-Turbo](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo).
- Codec: **MOSS-Audio-Tokenizer** · Phonemizer: **sea-g2p** · **Piper TTS**.

Giấy phép: **Apache-2.0 License**.
