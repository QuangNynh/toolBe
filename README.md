# YouTube & Media Translation API

Dự án NestJS cung cấp các công cụ xử lý video, tải xuống audio/video từ YouTube, trích xuất phụ đề (Whisper SRT), dịch thuật (Gemini), thuyết minh giọng nói tiếng Việt (VieNeu-TTS) và ghép phụ đề song ngữ vào video MP4.

---

## 🛠️ Yêu cầu Hệ thống (Prerequisites)

Trước khi khởi chạy dự án, hãy đảm bảo máy tính của bạn đã cài đặt các công cụ sau:

1. **Node.js** (Phiên bản v18 trở lên)
2. **Python** (Phiên bản 3.9 - 3.11 khuyến nghị cho TTS và Whisper)
3. **FFmpeg**: Yêu cầu để xử lý, cắt ghép audio và video.
   - **macOS**: `brew install ffmpeg`
   - **Ubuntu/Debian**: `sudo apt update && sudo apt install ffmpeg`
4. **Whisper CLI**: Cài đặt Whisper cục bộ để trích xuất phụ đề tự động từ giọng nói.
   - Cài đặt qua pip: `pip install openai-whisper`
5. **eSpeak NG**: Cần thiết cho bộ máy phonemization của VieNeu-TTS.
   - **macOS**: `brew install espeak`
   - **Ubuntu/Debian**: `sudo apt install espeak-ng`

---

## 🚀 Hướng dẫn Cài đặt & Khởi chạy

Dự án gồm 2 phần độc lập cần chạy song song: **Python TTS Server** và **NestJS Backend**.

### Bước 1: Cài đặt và chạy Python TTS Server
1. Di chuyển vào thư mục dịch vụ TTS:
   ```bash
   cd python-tts-service
   ```
2. Tạo môi trường ảo và cài đặt thư viện phụ thuộc:
   - **Sử dụng pip thông thường:**
     ```bash
     python -m venv venv
     source venv/bin/activate  # Trên Linux/macOS
     # Hoặc venv\Scripts\activate trên Windows (cmd)
     pip install -r requirements.txt
     ```
   - **Sử dụng uv (khuyến nghị cho tốc độ nhanh):**
     ```bash
     uv venv
     uv pip install -r requirements.txt
     ```
3. Khởi chạy máy chủ TTS:
   ```bash
   python server.py
   ```
   *Máy chủ TTS cục bộ sẽ chạy tại địa chỉ: `http://localhost:8020`*

### Bước 2: Cài đặt và chạy NestJS Backend
1. Quay lại thư mục gốc của dự án:
   ```bash
   cd ..
   ```
2. Cài đặt các package của Node.js:
   ```bash
   npm install
   ```
3. Tạo và chỉnh sửa file cấu hình `.env` ở thư mục gốc:
   ```env
   PORT=8000
   NODE_ENV=development
   
   # Cấu hình khóa Gemini API để dịch SRT phụ đề
   GEMINI_API_KEY=AIzaSy... (Khóa API của bạn)
   
   # URL kết nối tới Python TTS Server cục bộ
   VIENEU_SERVER_URL=http://localhost:8020
   ```
4. Khởi chạy ứng dụng NestJS ở chế độ phát triển:
   ```bash
   npm run dev
   ```
   *Máy chủ sẽ chạy tại địa chỉ: `http://localhost:8000`*

---

## 📖 Tài liệu API (Swagger)

Khi ứng dụng NestJS đã được khởi chạy, bạn có thể truy cập tài liệu API tự động cùng bảng thử nghiệm Swagger tại đường dẫn:
👉 **[http://localhost:8000/api/docs](http://localhost:8000/api/docs)**

---

## ⚡ API Dịch Video & Thuyết Minh (`POST /api/v1/media/translate-video`)

API này tự động hóa toàn bộ quy trình dịch thuật video: **Tách Audio ➔ Chuyển giọng nói sang SRT gốc ➔ Dịch phụ đề sang Tiếng Việt ➔ Tạo file thuyết minh TTS ➔ Gộp phụ đề song ngữ và audio thuyết minh mới vào video MP4 gốc.**

### Yêu cầu Request
- **Endpoint:** `POST /api/v1/media/translate-video`
- **Content-Type:** `multipart/form-data`
- **Body parameters:**
  - `file` (Binary File - Bắt buộc): Video đầu vào cần dịch (.mp4, .mkv, .mov,...).
  - `voice` (String - Bắt buộc): Tên giọng đọc thuyết minh của VieNeu-TTS (Ví dụ: `Bình An`, `Ngọc Lan`, `Xuân Vĩnh`, `Mỹ Duyên`,...). Bạn có thể gọi `GET /api/v1/audio-tts/voices` để lấy danh sách giọng đọc.
  - `apiKey` (String - Tùy chọn): Khóa Gemini API để dịch phụ đề. Nếu để trống, hệ thống sẽ sử dụng khóa mặc định từ file `.env`.
  - `targetLanguage` (String - Tùy chọn): Ngôn ngữ đích để dịch phụ đề (Mặc định: `Vietnamese`).

### Cơ chế hoạt động
1. **Trích xuất âm thanh gốc:** Tách luồng âm thanh từ video sang định dạng MP3.
2. **Nhận dạng giọng nói (Whisper):** Chạy Whisper trên audio đã trích xuất để tạo file phụ đề SRT gốc.
3. **Dịch phụ đề (Gemini API):** Phân đoạn và dịch nội dung phụ đề sang Tiếng Việt thông qua mô hình Gemini 2.5 Flash tối ưu.
4. **Hợp nhất phụ đề song ngữ:** Trộn phụ đề gốc và phụ đề đã dịch thành một tệp phụ đề song song (Dòng 1: Ngôn ngữ gốc, Dòng 2: Tiếng Việt).
5. **Thuyết minh (TTS):** Chuyển đổi tệp phụ đề tiếng Việt thành luồng âm thanh khớp chính xác dòng thời gian của video bằng mô hình VieNeu-TTS.
6. **Tổng hợp Video:** Sử dụng FFmpeg ghép luồng âm thanh mới (thay thế âm thanh cũ) và burn (hardsub) phụ đề song ngữ trực tiếp vào tệp MP4 kết quả.

---

## 💬 API Chat Gemini Trực Tiếp (`POST /api/v1/chat`)

API này hoạt động như một hộp chat Gemini thông thường, không yêu cầu truyền vào ngôn ngữ đích. Hệ thống sẽ tự động trả lời bằng ngôn ngữ tương ứng với câu hỏi của bạn.

### Yêu cầu Request
- **Endpoint:** `POST /api/v1/chat`
- **Content-Type:** `application/json`
- **Body parameters:**
  - `prompt` (String - Bắt buộc): Nội dung câu hỏi/câu lệnh gửi tới Gemini.
  - `model` (String - Tùy chọn): Tên mô hình sử dụng (Mặc định: `gemini-2.5-flash`).
  - `apiKey` (String - Tùy chọn): Khóa Gemini API Key riêng. Nếu bỏ trống sẽ dùng khóa mặc định trong `.env`.

---

## 📝 API Xuất Kịch Bản Văn Bản (`POST /api/v1/youtube/script`)

API này chuyển đổi một tệp âm thanh (audio) bất kỳ thành văn bản kịch bản thuần túy (không chứa mốc thời gian hay số thứ tự dòng giống file SRT).

### Yêu cầu Request
- **Endpoint:** `POST /api/v1/youtube/script`
- **Content-Type:** `multipart/form-data`
- **Body parameters:**
  - `file` (Binary File - Bắt buộc): Tệp âm thanh đầu vào (mp3, wav, m4a, etc.).

### Định dạng đầu ra
- Trả về tệp tin `.txt` chứa toàn bộ nội dung kịch bản đã được ghép nối liền mạch và tự động download.

---

## 🎵 API Lấy Danh Sách Video TikTok (`POST /api/v1/tiktok/channel-videos`)

API này quét toàn bộ video từ một kênh TikTok thông qua công cụ `yt-dlp` và trả về thông tin chi tiết của từng video (lượt xem, lượt thích, lượt lưu, chia sẻ, thời lượng, mô tả, ảnh thu nhỏ,...).

### Yêu cầu Request
- **Endpoint:** `POST /api/v1/tiktok/channel-videos`
- **Content-Type:** `application/json`
- **Body parameters:**
  - `url` (String - Bắt buộc): Đường dẫn đến kênh TikTok cần lấy (Ví dụ: `https://www.tiktok.com/@gospelglow8`).
  - `limit` (Number - Tùy chọn): Giới hạn số lượng video mới nhất cần lấy. Nếu bỏ trống (hoặc không truyền), hệ thống sẽ quét và lấy **tất cả** video trên kênh.

### Định dạng phản hồi (JSON Response)
```json
{
  "channel": "gospelglow8",
  "title": "gospelglow8",
  "url": "https://www.tiktok.com/@gospelglow8",
  "video_count": 3,
  "videos": [
    {
      "id": "7348463423828725038",
      "title": "✝️🙏🏻#god #christian #christiantiktok...",
      "description": "✝️🙏🏻#god #christian #christiantiktok...",
      "url": "https://www.tiktok.com/@gospelglow8/video/7348463423828725038",
      "duration": 83,
      "view_count": 47300,
      "like_count": 7269,
      "comment_count": 1998,
      "repost_count": 2333,
      "save_count": 1493,
      "created_at": "2024-03-20T17:51:52.000Z",
      "uploader": "gospelglow8",
      "uploader_id": "7233415196562785322",
      "thumbnails": [...]
    }
  ]
}
```

---

## 💾 API Tải Video TikTok Chất Lượng Cao Nhất (`POST /api/v1/tiktok/video`)

API này tải xuống video TikTok riêng lẻ với chất lượng tốt nhất thông qua công cụ `yt-dlp` và truyền trực tiếp (stream) file MP4 về cho client tải xuống.

### Yêu cầu Request
- **Endpoint:** `POST /api/v1/tiktok/video`
- **Content-Type:** `application/json`
- **Body parameters:**
  - `url` (String - Bắt buộc): Đường dẫn đến video TikTok cần tải xuống (Ví dụ: `https://www.tiktok.com/@gospelglow8/video/7348463423828725038`).

### Định dạng đầu ra
- Trả về tệp tin `.mp4` của video và tự động download với tên tệp đã được chuẩn hóa theo tiêu đề của video TikTok.

---

## 🎵 API Tải Audio MP3 TikTok (`POST /api/v1/tiktok/audio`)

API này trích xuất âm thanh từ video TikTok với chất lượng âm thanh tốt nhất thông qua công cụ `yt-dlp` và truyền trực tiếp (stream) file MP3 về cho client tải xuống.

### Yêu cầu Request
- **Endpoint:** `POST /api/v1/tiktok/audio`
- **Content-Type:** `application/json`
- **Body parameters:**
  - `url` (String - Bắt buộc): Đường dẫn đến video TikTok cần tải audio (Ví dụ: `https://www.tiktok.com/@gospelglow8/video/7348463423828725038`).

### Định dạng đầu ra
- Trả về tệp tin `.mp3` của âm thanh và tự động download với tên tệp đã được chuẩn hóa theo tiêu đề của video TikTok.

---

## 🧪 Chạy thử nghiệm khác (Tests)

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## 📄 Bản quyền (License)

Dự án được cấp phép theo tiêu chuẩn [MIT licensed](LICENSE).
