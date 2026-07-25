# YouTube Module - Tài liệu API dành cho Frontend/Client

> **Base URL:** `http://localhost:8000/api/v1/youtube`
>
> **Swagger UI:** `http://localhost:8000/api/docs` (tag: `Youtube`)

---

## Mục lục

1. [Cơ chế Xác thực & Quản lý Kênh YouTube](#cơ-chế-xác-thực--quản-lý-kênh-youtube)
   - [Lấy URL đăng nhập Google OAuth2](#1-lấy-url-đăng-nhập-google-oauth2)
   - [Callback kết nối kênh YouTube](#2-callback-kết-nối-kênh-youtube)
   - [Lấy danh sách kênh đã kết nối](#3-lấy-danh-sách-kênh-đã-kết-nối)
   - [Hủy kết nối một kênh](#4-hủy-kết-nối-một-kênh)
   - [Kiểm tra trạng thái token của kênh](#5-kiểm-tra-trạng-thái-token-của-kênh)
   - [Lấy tất cả video của kênh đã liên kết](#51-lấy-tất-cả-video-của-kênh-đã-liên-kết)
2. [Lên lịch đăng video (Schedule)](#lên-lịch-đăng-video-schedule)
   - [Hẹn giờ công chiếu video](#6-hẹn-giờ-công-chiếu-video)
   - [Cập nhật thông tin chi tiết (Metadata) cho Video](#61-cập-nhật-thông-tin-chi-tiết-metadata-cho-video)
   - [Cập nhật ảnh Thumbnail cho Video](#62-cập-nhật-ảnh-thumbnail-cho-video)
3. [Công cụ Tiện ích YouTube (Download & Transcript)](#công-cụ-tiện-ích-youtube-download--transcript)
   - [Lấy transcript của 1 video](#7-lấy-transcript-của-1-video)
   - [Lấy transcript của nhiều video (Batch)](#8-lấy-transcript-của-nhiều-video-batch)
   - [Tải âm thanh (Stream Audio) từ video](#9-tải-âm-thanh-stream-audio-từ-video)
   - [Tải video chất lượng cao](#10-tải-video-chất-lượng-cao)
   - [Lấy danh sách video từ URL kênh](#11-lấy-danh-sách-video-từ-url-kênh)
   - [Tải xuống ảnh từ URL bất kỳ](#12-tải-xuống-ảnh-từ-url-bất-kỳ)
   - [Chuyển file âm thanh thành file phụ đề SRT](#13-chuyển-file-âm-thanh-thành-file-phụ-đề-srt)
   - [Chuyển file âm thanh thành kịch bản văn bản](#14-chuyển-file-âm-thanh-thành-kịch-bản-văn-bản)
4. [Kiến trúc & Cơ chế hoạt động](#kiến-trúc--cơ-chế-hoạt-động)
5. [Mã lỗi thường gặp](#mã-lỗi-thường-gặp)

---

## Cấu hình Environment (.env) ở Backend
Để các API OAuth2 Google/YouTube hoạt động chính xác, Backend cần các biến môi trường sau:
```env
# YouTube OAuth2 (Ưu tiên)
YOUTUBE_CLIENT_ID=your_youtube_client_id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=your_youtube_client_secret
YOUTUBE_REDIRECT_URI=http://localhost:3000/youtube/callback

# Google OAuth2 (Dự phòng nếu không cấu hình các biến YOUTUBE_ phía trên)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=https://developers.google.com/oauthplayground
```
*Lưu ý:* `YOUTUBE_REDIRECT_URI` mặc định là `http://localhost:3000/youtube/callback` (Trang callback ở phía Client/Frontend). Sau khi user đồng ý cấp quyền trên Google Consent Screen, Google sẽ redirect về địa chỉ này kèm theo query `?code=xxxx`.

---

## Cơ chế Xác thực & Quản lý Kênh YouTube

Hệ thống quản lý các tài khoản YouTube đã kết nối bằng cách lưu thông tin vào file JSON cục bộ (`data/youtube/channels.json`). Token truy cập (`accessToken`) sẽ được **tự động làm mới (refresh)** bằng `refreshToken` khi gần hết hạn (dưới 5 phút trước khi hết hạn) mỗi khi hệ thống thực hiện tác vụ liên quan đến kênh đó (ví dụ: lên lịch đăng bài).

### 1. Direct Login (Redirect trực tiếp)

Client chuyển hướng trình duyệt của người dùng đến endpoint này để đi thẳng tới giao diện đăng nhập Google Consent Screen.

#### Request
```http
GET /api/v1/youtube/login
```

#### Response (302 Redirect)
Redirect trực tiếp đến Google OAuth2 login page với các scope:
- `https://www.googleapis.com/auth/youtube.force-ssl`
- `https://www.googleapis.com/auth/youtube.readonly`
Kèm theo cấu hình `access_type=offline` và `prompt=consent` để đảm bảo Google luôn trả về `refresh_token` mới.

---

### 1.1. Lấy URL đăng nhập Google OAuth2 (JSON format)

Nếu không muốn redirect trực tiếp từ phía Backend, Client có thể gọi API này để lấy chuỗi URL rồi tự chuyển hướng.

#### Request
```http
GET /api/v1/youtube/auth/url
```

#### Response (200)
```json
{
  "success": true,
  "url": "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.force-ssl..."
}
```

---

### 2. Callback nhận refresh_token trực tiếp (GET)

Địa chỉ Backend xử lý callback (hoặc Client nhận `code` từ Google Redirect, sau đó gọi GET tới endpoint này để lấy trực tiếp `refresh_token`).

#### Request
```http
GET /api/v1/youtube/callback?code=4/0AX4XfWg...
```

#### Response (200)
```json
{
  "success": true,
  "message": "YouTube authentication successful",
  "refresh_token": "1//0eXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

---

### 2.1. Callback kết nối kênh YouTube (POST - Tương thích ngược)

Gửi Authorization Code nhận được từ Google Redirect lên Backend để tiến hành đổi lấy tokens và lưu trữ kết nối kênh.

#### Request
```http
POST /api/v1/youtube/auth/callback
```
**Headers:**
- `Content-Type: application/json`

**Body:**
```json
{
  "code": "4/0AX4XfWg..."
}
```

#### Cách hoạt động ở Backend:
1. Nhận `code` từ Client, gửi yêu cầu sang Google API để đổi lấy `accessToken` và `refreshToken`.
2. Dùng token đó gọi YouTube API `channels.list` (mine=true) để lấy thông tin kênh (ID, tên kênh, ảnh đại diện).
3. Đóng gói dữ liệu và ghi vào file `data/youtube/channels.json`. Nếu kênh đã tồn tại, tự động cập nhật token mới.

#### Response (200)
```json
{
  "success": true,
  "message": "YouTube channel connected successfully.",
  "channel": {
    "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
    "channelTitle": "Tên Kênh YouTube Của Tôi",
    "thumbnailUrl": "https://lh3.googleusercontent.com/a/default-avatar=s88-c",
    "connectedAt": 1721644800000
  }
}
```

---

### 3. Lấy danh sách kênh đã kết nối

Liệt kê toàn bộ các kênh YouTube đã liên kết thành công để hiển thị trên giao diện quản lý.

#### Request
```http
GET /api/v1/youtube/channels
```

#### Response (200)
*Các thông tin nhạy cảm như `refreshToken` và `accessToken` đã được loại bỏ trước khi trả về Client.*
```json
{
  "success": true,
  "count": 1,
  "channels": [
    {
      "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
      "channelTitle": "Tên Kênh YouTube Của Tôi",
      "thumbnailUrl": "https://lh3.googleusercontent.com/a/default-avatar=s88-c",
      "connectedAt": 1721644800000,
      "expiresAt": 1721648400000,
      "isExpired": false
    }
  ]
}
```

---

### 4. Hủy kết nối một kênh

Hủy liên kết và xóa hoàn toàn thông tin kênh YouTube khỏi hệ thống.

#### Request
```http
DELETE /api/v1/youtube/channels/:channelId
```
**Ví dụ:** `DELETE /api/v1/youtube/channels/UCxxxxxxxxxxxxxxxxxxxxxxx`

#### Response (200)
```json
{
  "success": true,
  "message": "YouTube channel \"UCxxxxxxxxxxxxxxxxxxxxxxx\" has been disconnected."
}
```

---

### 5. Kiểm tra trạng thái token của kênh

Kiểm tra thủ công xem token của kênh đó còn hạn không và có hoạt động được không (gọi test API YouTube).

#### Request
```http
GET /api/v1/youtube/channels/:channelId/check-token
```
**Ví dụ:** `GET /api/v1/youtube/channels/UCxxxxxxxxxxxxxxxxxxxxxxx/check-token`

#### Response (200)
```json
{
  "success": true,
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
  "channelTitle": "Tên Kênh YouTube Của Tôi",
  "isExpired": false,
  "timeLeftSeconds": 3540,
  "isWorking": true,
  "errorMessage": null
}
```
*Lưu ý:* Nếu `isWorking` là `false`, hệ thống sẽ trả về lỗi chi tiết trong `errorMessage` (ví dụ: User đã thu hồi quyền trên Google Account).

---

### 5.1. Lấy tất cả video của kênh đã liên kết

Lấy toàn bộ danh sách các video đã đăng hoặc tải lên của kênh (bao gồm cả video ở trạng thái **Private**, **Public**, **Unlisted**). API này sử dụng Playlist `uploads` đặc biệt của kênh để duyệt, rất thích hợp cho việc hiển thị danh sách video quản trị.

#### Request
```http
GET /api/v1/youtube/videos?channelId=UCxxxxxxxxxxxxxxxxxxxxxxx&maxResults=10
```

**Query Parameters:**
* `channelId` (string, bắt buộc): ID kênh đã liên kết.
* `maxResults` (number, tùy chọn, mặc định: 10, tối đa: 50): Số video trên 1 trang.
* `pageToken` (string, tùy chọn): Token để lấy trang tiếp theo (`nextPageToken`).
* `privacyStatus` (string, tùy chọn): Lọc trạng thái quyền riêng tư của video. Nhận các giá trị: `public`, `private`, hoặc `unlisted`.

#### Response (200)
```json
{
  "success": true,
  "channelId": "UCrI78yQm7H9ZTihuVs5nPLg",
  "totalResults": 45,
  "resultsPerPage": 10,
  "nextPageToken": "CAUQAA",
  "prevPageToken": null,
  "videos": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up",
      "description": "The official video for...",
      "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      "publishedAt": "2009-10-25T06:57:33Z",
      "privacyStatus": "public"
    }
  ]
}
```

---

## Lên lịch đăng video (Schedule)

### 6. Hẹn giờ công chiếu video

Lên lịch tự động chuyển một video từ trạng thái **Private** sang **Public** theo giờ hẹn. API này trực tiếp cập nhật cài đặt `publishAt` của YouTube.

#### Request
```http
POST /api/v1/youtube/schedule
```
**Headers:**
- `Content-Type: application/json`

**Body:**
| Trường | Kiểu dữ liệu | Bắt buộc | Validate | Mô tả |
| :--- | :--- | :--- | :--- | :--- |
| `channelId` | `string` | **Có** | Kênh phải tồn tại trong database JSON | ID kênh YouTube đã kết nối |
| `videoId` | `string` | **Có** | Không được để trống | ID video đã được upload lên kênh dưới dạng Private |
| `publishTime` | `string` | **Có** | Định dạng ISO 8601, cách hiện tại ít nhất **15 phút** | Thời điểm tự động Public video |

**Ví dụ Body:**
```json
{
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
  "videoId": "dQw4w9WgXcQ",
  "publishTime": "2026-08-01T14:30:00.000Z"
}
```

#### Cách hoạt động:
1. Backend kiểm tra kênh `channelId` đã liên kết chưa. Nếu chưa -> Lỗi `404`.
2. Backend lấy `refreshToken` của kênh đó, khởi tạo client Google Auth và tự động làm mới `accessToken` nếu cần.
3. Gọi API của Google: `youtube.videos.update` để thiết lập `status.privacyStatus = "private"` cùng `status.publishAt = publishTime`. Không cần cập nhật snippet nên hoàn toàn tránh được các lỗi về Category ID.

#### Response (200)
```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
  "channelTitle": "Tên Kênh YouTube Của Tôi",
  "publishAt": "2026-08-01T14:30:00.000Z",
  "privacyStatus": "private"
}
```

---

### 6.1. Cập nhật thông tin chi tiết (Metadata) cho Video

Cập nhật thông tin chi tiết của video bao gồm tiêu đề, mô tả, tags và cấu hình dán nhãn nội dung AI (Synthetic Media).

#### Request
```http
POST /api/v1/youtube/update-metadata
```
**Headers:**
- `Content-Type: application/json`

**Body:**
| Trường | Kiểu dữ liệu | Bắt buộc | Mô tả |
| :--- | :--- | :--- | :--- |
| `channelId` | `string` | **Có** | ID kênh YouTube đã kết nối |
| `videoId` | `string` | **Có** | ID video cần cập nhật thông tin |
| `title` | `string` | **Có** | Tiêu đề mới của video (Tối đa 100 ký tự) |
| `description` | `string` | **Có** | Mô tả mới của video (Tối đa 5000 ký tự) |
| `tags` | `array` | Không | Mảng các string làm tags từ khóa cho video |
| `containsSyntheticMedia` | `boolean` | Không | Cho biết video có chứa nội dung do AI tạo ra (Altered or synthetic content) |

**Ví dụ Body:**
```json
{
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
  "videoId": "dQw4w9WgXcQ",
  "title": "10 Mẹo Hay Cho Cuộc Sống | Life Hacks",
  "description": "Trong video này mình chia sẻ 10 mẹo hay...",
  "tags": ["mẹo hay", "life hacks"],
  "containsSyntheticMedia": true
}
```

#### Response (200)
```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "title": "10 Mẹo Hay Cho Cuộc Sống | Life Hacks",
  "description": "Trong video này mình chia sẻ 10 mẹo hay...",
  "tags": ["mẹo hay", "life hacks"],
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
  "channelTitle": "Tên Kênh YouTube Của Tôi",
  "hasAlteredOrSyntheticContent": true
}
```

---

### 6.2. Cập nhật ảnh Thumbnail cho Video

Cập nhật ảnh đại diện (Thumbnail) cho video YouTube bằng file upload trực tiếp từ client.

*Lưu ý:* Định dạng ảnh bắt buộc là **JPEG** hoặc **PNG**, dung lượng nhỏ hơn **2MB**, tỷ lệ khuyến nghị là **16:9** (1280x720).

#### Request
```http
POST /api/v1/youtube/thumbnail
```
**Headers:**
- `Content-Type: multipart/form-data`

**Body:**
| Trường | Kiểu dữ liệu | Bắt buộc | Mô tả |
| :--- | :--- | :--- | :--- |
| `channelId` | `string` | **Có** | ID kênh YouTube đã kết nối |
| `videoId` | `string` | **Có** | ID video cần đổi ảnh đại diện |
| `file` | `file (binary)` | **Có** | File ảnh tải lên trực tiếp (JPEG/PNG, < 2MB) |

**Ví dụ gửi bằng FormData:**
Frontend sử dụng `FormData` để gửi request với định dạng `multipart/form-data` đính kèm file ảnh trong trường `file`.

#### Response (200)
```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxxx",
  "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg"
}
```

---

## Công cụ Tiện ích YouTube (Download & Transcript)

Các API trong nhóm này là tiện ích công cộng, **không yêu cầu đăng nhập/OAuth2 token**.

### 7. Lấy transcript của 1 video

Lấy nội dung phụ đề (transcript) của video kèm thông tin metadata.

#### Request
```http
POST /api/v1/youtube/transcript
```
**Body:**
```json
{
  "videoId": "dQw4w9WgXcQ"
}
```

#### Response (200)
```json
{
  "success": true,
  "videoId": "dQw4w9WgXcQ",
  "transcript": [
    {
      "text": "Hello world",
      "start": 1.2,
      "duration": 2.5
    }
  ],
  "transcriptLanguage": "en",
  "metadata": {
    "title": "Rick Astley - Never Gonna Give You Up",
    "description": "The official video for...",
    "author": "Rick Astley",
    "channelId": "UCuAXFUrg5c2c5c5...",
    "durationSeconds": 212
  }
}
```

---

### 8. Lấy transcript của nhiều video (Batch)

Lấy transcript cho một mảng gồm nhiều video IDs cùng lúc (chạy xử lý song song tối đa 15 request).

#### Request
```http
POST /api/v1/youtube/transcripts
```
**Body:**
```json
{
  "videoIds": ["dQw4w9WgXcQ", "anotherId123"]
}
```

#### Response (200)
```json
[
  {
    "success": true,
    "videoId": "dQw4w9WgXcQ",
    "transcript": [...],
    "metadata": {...}
  },
  {
    "success": false,
    "videoId": "anotherId123",
    "error": "Transcript not available"
  }
]
```

---

### 9. Tải âm thanh (Stream Audio) từ video

Tải âm thanh của video YouTube dưới định dạng `.m4a` (hoặc `.mp3` nếu không có M4A gốc). File được stream trực tiếp về máy Client.

#### Request
```http
POST /api/v1/youtube/audio
```
**Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

#### Response (200)
Trả về file binary dạng `audio/mp4` hoặc `audio/mpeg` cùng với header `Content-Disposition: attachment; filename="..."`. Browser sẽ tự động tải xuống.

---

### 10. Tải video chất lượng cao

Tải video YouTube kèm re-encoding tương thích tốt với CapCut/Canva (codec H.264/AAC, pixel format yuv420p).

#### Request
```http
POST /api/v1/youtube/video
```
**Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "quality": "1080p"
}
```
*Lưu ý về `quality`:* Hỗ trợ các giá trị: `360p`, `480p`, `720p`, `1080p`, `1440p`, `2160p` (hoặc `4k`). Mặc định là `1080p`.

#### Response (200)
Trả về file binary video dạng `video/mp4` tải xuống trực tiếp.

---

### 11. Lấy danh sách video từ URL kênh

Lấy toàn bộ danh sách các video công khai từ một kênh YouTube (quét danh sách nhanh qua yt-dlp và lấy metadata chi tiết qua youtubei.js).

#### Request
```http
POST /api/v1/youtube/urls
```
**Body:**
```json
{
  "url": "https://www.youtube.com/@RickAstleyYT"
}
```

#### Response (200)
```json
{
  "type": "Youtube",
  "channelId": "UCuAXFUr...",
  "channel": "Rick Astley",
  "channelUrl": "https://www.youtube.com/@RickAstleyYT",
  "totalVideos": 145,
  "videos": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "duration": 212,
      "view_count": 1400000000,
      "created_at": "2009-10-25T06:57:33Z"
    }
  ]
}
```

---

### 12. Tải xuống ảnh từ URL bất kỳ

Tải ảnh từ một link URL bất kỳ và tự động re-format WebP sang JPG để tương thích tốt với Canva.

#### Request
```http
POST /api/v1/youtube/download-image
```
**Body:**
```json
{
  "imageUrl": "https://example.com/some-image.webp"
}
```

#### Response (200)
Trả về file binary dạng `image/jpeg` tải xuống trực tiếp.

---

### 13. Chuyển file âm thanh thành file phụ đề SRT

Upload một file âm thanh bất kỳ, hệ thống sẽ chuyển sang định dạng chuẩn WAV và chạy nhận diện giọng nói (Whisper AI) để xuất ra file phụ đề SRT.

#### Request
```http
POST /api/v1/youtube/srt
```
**Headers:**
- `Content-Type: multipart/form-data`

**Body (Form Data):**
- `file`: Chọn file audio từ thiết bị (mp3, wav, m4a, etc.)

#### Response (200)
Trả về file text chứa cấu trúc phụ đề `.srt` (Có mốc thời gian chi tiết). Header: `Content-Type: text/plain; charset=utf-8`.

---

### 14. Chuyển file âm thanh thành kịch bản văn bản

Tương tự API SRT nhưng sẽ gộp văn bản lại thành một kịch bản đọc liền mạch (loại bỏ toàn bộ mốc thời gian và khoảng ngắt dòng).

#### Request
```http
POST /api/v1/youtube/script
```
**Headers:**
- `Content-Type: multipart/form-data`

**Body (Form Data):**
- `file`: Chọn file audio từ thiết bị

#### Response (200)
Trả về file văn bản `.txt` kịch bản. Header: `Content-Type: text/plain; charset=utf-8`.

---

## Kiến trúc & Cơ chế hoạt động

```
src/modules/youtube/
├── dto/
│   ├── downloadImage.dto.ts
│   ├── getChannelVideos.dto.ts
│   ├── getTranscript.dto.ts
│   ├── getTranscripts.dto.ts
│   ├── schedule-youtube.dto.ts      # DTO Hẹn giờ công chiếu (Updated)
│   ├── streamAudio.dto.ts
│   ├── streamVideo.dto.ts
│   └── youtube-auth.dto.ts          # DTO Callback OAuth2 (New)
├── youtube.module.ts
├── youtube.controller.ts            # Khai báo các endpoints router
└── youtube.service.ts               # Xử lý Logic & Đọc ghi JSON, API Google
```

### Cơ chế Auto-Refresh Access Token (Backend Tự Động Xử Lý)
```
          Client gửi yêu cầu Schedule / Check Token
                             │
                             v
           [Đọc database channels.json cục bộ]
                             │
               Không tìm thấy ├─► Trả về 404 (Kênh chưa kết nối)
                             │
              Kênh đã kết nối └──► [Kiểm tra expiresAt của token]
                                            │
                    Hạn còn > 5 phút        ├─► Dùng luôn Access Token hiện tại
                                            │
                    Hạn còn < 5 phút        └─► [Gửi Refresh Token sang Google]
                                                            │
                                                   Nhận Access Token mới
                                                            │
                                                   [Ghi đè tokens mới vào JSON]
                                                            │
                                                            v
                                                   [Thực hiện gọi API YouTube]
```

---

## Mã lỗi thường gặp

| HTTP Status | Lỗi thường gặp | Nguyên nhân & Hướng giải quyết |
| :--- | :--- | :--- |
| `400` | `publishTime must be ... at least 15 minutes in the future` | YouTube API yêu cầu thời điểm công chiếu phải lớn hơn thời gian hiện tại ít nhất 15 phút. Điều chỉnh lại `publishTime` gửi lên. |
| `400` | `No refresh_token received...` | Xảy ra khi kết nối kênh đã có sẵn từ trước. Cần đảm bảo khi tạo URL đăng nhập có tham số `prompt=consent` để Google bắt buộc trả về `refresh_token`. |
| `400` | `Missing GOOGLE_CLIENT_ID...` | Backend chưa được cấu hình đầy đủ biến môi trường Google OAuth2 trong file `.env`. |
| `404` | `YouTube channel "UC..." is not connected.` | Kênh này chưa được liên kết thông qua quy trình đăng nhập OAuth2. Yêu cầu user kết nối tài khoản trước. |
| `500` | `Audio download/processing failed` | Lỗi xảy ra do video YouTube bị khóa quốc gia hoặc bị xóa, hoặc lỗi re-encode ffmpeg trên server. |
