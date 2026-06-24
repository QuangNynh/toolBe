# 🛠️ ToolBe — Backend API Toolkit

Backend API đa năng xây dựng trên **NestJS** — tích hợp YouTube, dịch thuật AI, xử lý media, và TTS (Text-to-Speech) với XTTS v2.

---

## 📑 Mục lục

- [Yêu cầu hệ thống](#-yêu-cầu-hệ-thống)
- [Cài đặt nhanh](#-cài-đặt-nhanh)
- [Biến môi trường](#-biến-môi-trường)
- [Chạy ứng dụng](#-chạy-ứng-dụng)
- [Cấu trúc dự án](#-cấu-trúc-dự-án)
- [Các Module](#-các-module)
  - [YouTube Module](#1-youtube-module)
  - [Translation Module](#2-translation-module)
  - [Media Module](#3-media-module)
  - [Audio TTS Module](#4-audio-tts-module)
  - [Proxy Module](#5-proxy-module)
- [XTTS v2 Server (Python)](#-xtts-v2-server-python)
- [API Reference](#-api-reference)
- [Lưu ý quan trọng](#-lưu-ý-quan-trọng)

---

## 💻 Yêu cầu hệ thống

### Bắt buộc

| Tool | Phiên bản | Mục đích |
|------|-----------|----------|
| **Node.js** | >= 18.x | Runtime cho NestJS |
| **npm** | >= 9.x | Quản lý package |
| **FFmpeg** | >= 6.x | Xử lý audio/video (trích xuất, encode, stretch, concat) |

### Tuỳ chọn (theo module sử dụng)

| Tool | Module | Mục đích |
|------|--------|----------|
| **yt-dlp** | YouTube | Tải audio/video từ YouTube |
| **whisper** (OpenAI) | YouTube | Chuyển audio → SRT subtitle |
| **Python 3** | Audio TTS | Chạy XTTS v2 server |
| **CUDA / MPS** | Audio TTS | GPU tăng tốc TTS (khuyến nghị) |

### Cài đặt system dependencies

#### macOS (Homebrew)

```bash
# FFmpeg (bắt buộc)
brew install ffmpeg

# yt-dlp (cho YouTube module)
brew install yt-dlp

# Whisper (cho audio → SRT)
pip3 install openai-whisper

# Python 3 (cho XTTS server — macOS thường có sẵn)
brew install python@3.11
```

#### Ubuntu / Debian

```bash
# FFmpeg
sudo apt update && sudo apt install ffmpeg

# yt-dlp
sudo apt install yt-dlp
# hoặc
pip3 install yt-dlp

# Whisper
pip3 install openai-whisper

# Python 3
sudo apt install python3 python3-pip python3-venv
```

#### Windows

```powershell
# Sử dụng Chocolatey hoặc Scoop
choco install ffmpeg yt-dlp python3

# Whisper
pip install openai-whisper
```

---

## 🚀 Cài đặt nhanh

### 1. Clone repository

```bash
git clone <repository-url>
cd toolBe
```

### 2. Cài đặt dependencies (NestJS)

```bash
npm install
```

### 3. Tạo file `.env`

```bash
cp .env.example .env
# Hoặc tạo thủ công (xem phần Biến môi trường)
```

### 4. Chạy ứng dụng

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm run start:prod
```

### 5. Truy cập

- **API Base:** `http://localhost:8000/api/v1/`
- **Swagger Docs:** `http://localhost:8000/api/docs`

---

## 🔐 Biến môi trường

Tạo file `.env` ở thư mục gốc dự án:

```env
# ────────────────────────────────────────────
# Server
# ────────────────────────────────────────────
PORT=8000

# ────────────────────────────────────────────
# Google Gemini AI (Translation module)
# ────────────────────────────────────────────
# Lấy API key tại: https://aistudio.google.com/apikey
# Có thể bỏ trống nếu truyền apiKey trong mỗi request
GEMINI_API_KEY=your_gemini_api_key_here

# ────────────────────────────────────────────
# XTTS v2 Server (Audio TTS module)
# ────────────────────────────────────────────
# URL của Python XTTS server (phải chạy riêng)
XTTS_SERVER_URL=http://localhost:8888
```

| Biến | Bắt buộc | Mặc định | Mô tả |
|------|----------|----------|-------|
| `PORT` | ❌ | `8000` | Port NestJS server |
| `GEMINI_API_KEY` | ❌* | — | API key Google Gemini (* có thể truyền per-request) |
| `XTTS_SERVER_URL` | ❌ | `http://localhost:8888` | URL Python XTTS v2 server |

---

## ▶️ Chạy ứng dụng

### NestJS Backend

```bash
# Development (auto-reload khi thay đổi code)
npm run dev

# Production build
npm run build
npm run start:prod

# Debug mode
npm run start:debug
```

### XTTS v2 Python Server (nếu dùng TTS module)

Xem chi tiết tại [mục XTTS v2 Server](#-xtts-v2-server-python).

```bash
cd xtts-server
pip install -r requirements.txt
./start.sh
```

---

## 📁 Cấu trúc dự án

```
toolBe/
├── src/
│   ├── main.ts                          # Entry point, Swagger config
│   ├── app.module.ts                    # Root module
│   ├── app.controller.ts               # Health check endpoint
│   ├── app.service.ts                   # App service
│   ├── types/
│   │   └── ffmpeg-installer.d.ts        # FFmpeg type declarations
│   └── modules/
│       ├── youtube/                     # YouTube module
│       │   ├── youtube.module.ts
│       │   ├── youtube.controller.ts
│       │   ├── youtube.service.ts
│       │   └── dto/                     # 7 DTO files
│       ├── translation/                 # Translation module
│       │   ├── translation.module.ts
│       │   ├── translation.controller.ts
│       │   ├── translation.service.ts
│       │   └── dto/                     # 3 DTO files
│       ├── media/                       # Media module
│       │   ├── media.module.ts
│       │   ├── media.controller.ts
│       │   ├── media.service.ts
│       │   └── dto/                     # 1 DTO file
│       ├── audio-tts/                   # Audio TTS module
│       │   ├── audio-tts.module.ts
│       │   ├── audio-tts.controller.ts
│       │   ├── audio-tts.service.ts
│       │   └── dto/                     # 2 DTO files
│       └── proxy/                       # Proxy module (internal)
│           ├── proxy.module.ts
│           └── proxy.service.ts
├── xtts-server/                         # Python XTTS v2 server
│   ├── server.py
│   ├── requirements.txt
│   ├── start.sh
│   ├── voices/                          # Cloned voice storage
│   └── output/                          # TTS output cache
├── uploads/                             # Temp upload directory
├── package.json
├── tsconfig.json
├── nest-cli.json
├── .env                                 # Environment variables
└── .gitignore
```

---

## 📦 Các Module

### 1. YouTube Module

> Quản lý YouTube: lấy transcript, tải audio/video, tải ảnh, chuyển audio → SRT.

**Prefix:** `/api/v1/youtube/`

| Method | Endpoint | Mô tả | Body/Params |
|--------|----------|--------|-------------|
| `POST` | `/youtube/transcript` | Lấy transcript 1 video | `{ videoId }` |
| `POST` | `/youtube/transcripts` | Lấy transcript nhiều video (15 concurrent) | `{ videoIds: [] }` |
| `POST` | `/youtube/audio` | Tải audio MP3 từ YouTube | `{ url }` |
| `POST` | `/youtube/video` | Tải video MP4 (chọn chất lượng) | `{ url, quality? }` |
| `POST` | `/youtube/urls` | Lấy tất cả video từ channel | `{ url }` |
| `POST` | `/youtube/download-image` | Tải ảnh (auto convert WebP→JPG) | `{ imageUrl }` |
| `POST` | `/youtube/srt` | Upload audio → chuyển SRT (Whisper) | `multipart: file` |

**Yêu cầu:**
- `yt-dlp` — phải cài trên PATH (cho tải audio/video)
- `ffmpeg` — cho re-encode video (H.264 + AAC)
- `whisper` — cho chuyển audio → SRT

**Chi tiết xử lý:**
- Transcript: retry tới 10 lần, backoff mũ, delay random 2-6s chống rate-limit
- Video: tải → re-encode FFmpeg (libx264, CRF 23, fast preset, yuv420p) → stream
- Audio → SRT: convert 16kHz mono WAV → chạy Whisper (model `tiny`)

---

### 2. Translation Module

> Dịch văn bản và file SRT bằng Google Gemini AI.

**Prefix:** `/api/v1/translate/`

| Method | Endpoint | Mô tả | Body/Params |
|--------|----------|--------|-------------|
| `GET` | `/translate/models` | Liệt kê các model Gemini | `?apiKey=` |
| `GET` | `/translate/model-info` | Thông tin chi tiết 1 model | `?model=&apiKey=` |
| `POST` | `/translate` | Dịch văn bản | `{ text, targetLanguage, apiKey?, model? }` |
| `POST` | `/translate/srt` | Upload SRT → dịch → tải SRT mới | `multipart: file + { targetLanguage, model?, apiKey? }` |

**Yêu cầu:**
- `GEMINI_API_KEY` trong `.env` **hoặc** truyền `apiKey` trong mỗi request

**Chi tiết xử lý:**
- Model mặc định: `gemini-2.5-flash`
- SRT: chia thành chunk 50 block → dịch từng chunk → ghép lại
- Retry: 5 lần, backoff 2s → 4s → 8s... khi gặp 503/429
- Temperature: 0.3

---

### 3. Media Module

> Trích xuất audio từ file video.

**Prefix:** `/api/v1/media/`

| Method | Endpoint | Mô tả | Body/Params |
|--------|----------|--------|-------------|
| `POST` | `/media/extract-audio` | Trích xuất audio từ video | `multipart: file + { format?, bitrate? }` |

**Hỗ trợ:**
- **Input:** .mp4, .mkv, .avi, .mov, .wmv, .flv, .webm, .m4v, .ts, .mts, .3gp (tối đa 500MB)
- **Output:** mp3, wav, aac, flac, ogg
- **Bitrate:** 64, 128, 192 (mặc định), 256, 320 kbps

**Yêu cầu:** `ffmpeg` trên PATH

---

### 4. Audio TTS Module

> Text-to-Speech sử dụng XTTS v2 model local — TTS từ file SRT với timeline alignment.

**Prefix:** `/api/v1/tts/`

| Method | Endpoint | Mô tả | Body/Params |
|--------|----------|--------|-------------|
| `GET` | `/tts/voices` | Liệt kê giọng (58 built-in + cloned) | — |
| `GET` | `/tts/languages` | Liệt kê 18 ngôn ngữ hỗ trợ | — |
| `POST` | `/tts/clone-voice` | Clone giọng từ audio tham chiếu | `multipart: file + { name, description? }` |
| `POST` | `/tts/srt` | ⭐ TTS từ SRT, khớp timeline | `multipart: file + { speaker|voice_id, language, format? }` |

**Pipeline xử lý SRT:**

```
Upload SRT → Parse segments → TTS từng câu (XTTS v2)
→ Đo duration (ffprobe) → Tính tempo ratio
→ Stretch/Compress (ffmpeg atempo) → Tạo silence cho gaps
→ Concat tất cả → Trả file WAV/MP3
```

**Yêu cầu:**
- Python XTTS v2 Server phải đang chạy (xem [mục bên dưới](#-xtts-v2-server-python))
- `ffmpeg` trên PATH

**Ngôn ngữ hỗ trợ:** en, es, fr, de, it, pt, pl, tr, ru, nl, cs, ar, zh-cn, ja, hu, ko, hi, **vi**

---

### 5. Proxy Module

> Module nội bộ — tạo local proxy server cho YouTube module dùng để bypass rate limit.

**Không có HTTP endpoint** — chỉ dùng internal bởi YouTube module.

**Chi tiết:**
- Chạy proxy server local trên port `8888`
- Route requests qua upstream proxy (cần cấu hình proxy thật trong `proxy.service.ts`)
- Random chọn proxy từ danh sách

> ⚠️ **Lưu ý:** Proxy URLs hiện đang là **placeholder** (`http://user:pass@ip1:port`). Cần thay bằng proxy thật nếu muốn sử dụng.

---

## 🐍 XTTS v2 Server (Python)

Server Python chạy XTTS v2 model local cho TTS và voice cloning.

### Cài đặt

```bash
cd xtts-server

# (Khuyến nghị) Tạo virtual environment
python3 -m venv venv
source venv/bin/activate   # macOS/Linux
# venv\Scripts\activate    # Windows

# Cài dependencies
pip install -r requirements.txt
```

> ⚠️ **Lần đầu chạy** sẽ tự động tải XTTS v2 model (~1.8GB).

### Chạy server

```bash
# Port mặc định: 8888
./start.sh

# Hoặc chỉ định port khác
./start.sh 9000

# Hoặc chạy trực tiếp
XTTS_PORT=8888 python server.py
```

### API Endpoints

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| `GET` | `/health` | Health check (model loaded, device, GPU) |
| `GET` | `/speakers` | Liệt kê giọng built-in (58) + cloned |
| `GET` | `/languages` | Liệt kê 18 ngôn ngữ |
| `POST` | `/clone-voice` | Upload audio → clone giọng |
| `POST` | `/tts` | TTS text → WAV |
| `DELETE` | `/clone-voice/{id}` | Xóa giọng đã clone |

### Yêu cầu phần cứng

| | Tối thiểu | Khuyến nghị |
|---|---|---|
| **CPU** | Any x86_64 / ARM64 | — |
| **RAM** | 8GB | 16GB+ |
| **GPU** | Không bắt buộc | NVIDIA với CUDA (tăng tốc 5-10x) |
| **Disk** | 5GB (cho model) | 10GB |

**Hỗ trợ tăng tốc:**
- ✅ NVIDIA CUDA (nhanh nhất)
- ✅ Apple Silicon MPS (macOS)
- ✅ CPU (chậm nhưng hoạt động)

### Voice Cloning

- Upload file audio (WAV/MP3/FLAC/OGG)
- Khuyến nghị: **6-10 giây**, giọng nói rõ ràng, không nhiễu
- Auto convert sang 22050Hz mono WAV
- Voice được lưu trong `xtts-server/voices/`

---

## 📖 API Reference

Tất cả endpoint đều có prefix `/api/v1/`.

### Tổng quan

```
GET  /api/v1/                          → Health check ("Hello World!")

# YouTube
POST /api/v1/youtube/transcript        → Lấy transcript 1 video
POST /api/v1/youtube/transcripts       → Lấy transcript nhiều video
POST /api/v1/youtube/audio             → Tải audio MP3
POST /api/v1/youtube/video             → Tải video MP4
POST /api/v1/youtube/urls              → Lấy video list từ channel
POST /api/v1/youtube/download-image    → Tải ảnh
POST /api/v1/youtube/srt               → Audio → SRT (Whisper)

# Translation
GET  /api/v1/translate/models          → Liệt kê Gemini models
GET  /api/v1/translate/model-info      → Thông tin model
POST /api/v1/translate                 → Dịch văn bản
POST /api/v1/translate/srt             → Dịch file SRT

# Media
POST /api/v1/media/extract-audio       → Trích xuất audio từ video

# TTS
GET  /api/v1/tts/voices                → Liệt kê giọng nói
GET  /api/v1/tts/languages             → Liệt kê ngôn ngữ
POST /api/v1/tts/clone-voice           → Clone giọng nói
POST /api/v1/tts/srt                   → TTS từ file SRT
```

### Swagger UI

Truy cập **`http://localhost:8000/api/docs`** để xem tài liệu API tương tác với đầy đủ schema, thử gọi trực tiếp.

---

## ⚙️ Scripts

```bash
npm run dev            # Chạy dev (auto-reload)
npm run build          # Build production
npm run start:prod     # Chạy production
npm run start:debug    # Chạy debug mode
npm run lint           # Lint & auto-fix
npm run format         # Format code (Prettier)
npm run test           # Chạy unit tests
npm run test:watch     # Chạy test (watch mode)
npm run test:cov       # Chạy test với coverage
npm run test:e2e       # Chạy e2e tests
```

---

## ⚠️ Lưu ý quan trọng

### 1. Xung đột Port

Proxy Module và XTTS Server **mặc định đều dùng port 8888**. Nếu chạy cả 2 trên cùng máy, cần đổi port XTTS:

```bash
# Đổi port XTTS server sang 9000
./start.sh 9000

# Và cập nhật biến môi trường
XTTS_SERVER_URL=http://localhost:9000
```

**Hoặc** đổi port proxy trong `src/modules/proxy/proxy.service.ts`.

### 2. Proxy Configuration

Proxy URLs trong `proxy.service.ts` hiện là **placeholder**. Nếu cần bypass rate-limit YouTube, phải thay bằng proxy thật:

```typescript
// src/modules/proxy/proxy.service.ts
private getProxy(): string {
  const proxies = [
    'http://real_user:real_pass@real_ip:real_port',
    // Thêm proxy khác...
  ];
  return proxies[Math.floor(Math.random() * proxies.length)];
}
```

### 3. Thư mục uploads/

- Thư mục `uploads/` được tự động tạo bởi Multer
- Chứa file upload tạm (tự động xóa sau khi xử lý)
- Đã được .gitignore

### 4. Giới hạn upload

| Module | Giới hạn |
|--------|----------|
| Media (video) | 500MB |
| TTS (voice clone) | 50MB |
| TTS (SRT file) | 10MB |

### 5. License XTTS v2

XTTS v2 sử dụng **Coqui Public Model License (CPML)** — **hạn chế sử dụng thương mại**. Xem chi tiết license trước khi deploy production.

---

## 🧪 Kiểm tra cài đặt

Chạy script sau để verify tất cả dependencies:

```bash
echo "=== Node.js ===" && node -v
echo "=== npm ===" && npm -v
echo "=== FFmpeg ===" && ffmpeg -version 2>/dev/null | head -1
echo "=== yt-dlp ===" && yt-dlp --version 2>/dev/null || echo "NOT INSTALLED"
echo "=== Whisper ===" && whisper --help 2>/dev/null | head -1 || echo "NOT INSTALLED"
echo "=== Python ===" && python3 --version 2>/dev/null || echo "NOT INSTALLED"
```

---

## 📜 License

UNLICENSED — Private project.
