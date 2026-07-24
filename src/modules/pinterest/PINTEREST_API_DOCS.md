# Pinterest Module - Tài liệu API

> **Base URL:** `http://localhost:8000/api/v1/pinterest`
>
> **Swagger UI:** `http://localhost:8000/api/docs` (tag: `Pinterest`)

---

## Mục lục

1. [Cơ chế Xác thực & Quản lý kênh](#cơ-chế-xác-thực--quản-lý-kênh)
   - [Lấy URL đăng nhập OAuth2](#1-lấy-url-đăng-nhập-oauth2)
   - [Callback kết nối tài khoản](#2-callback-kết-nối-tài-khoản)
   - [Lấy danh sách kênh đã kết nối](#3-lấy-danh-sách-kênh-đã-kết-nối)
   - [Hủy kết nối một kênh](#4-hủy-kết-nối-một-kênh)
   - [Kiểm tra trạng thái token của kênh](#5-kiểm-tra-trạng-thái-token-của-kênh)
2. [Hẹn giờ đăng pin (Schedule)](#6-hẹn-giờ-đăng-pin-schedule)
3. [Xem danh sách job đã hẹn](#7-xem-danh-sách-job-đã-hẹn)
4. [Huỷ job hẹn giờ](#8-huỷ-job-hẹn-giờ)
5. [Crawl dữ liệu Pinterest (Công khai)](#crawl-dữ-liệu-pinterest-công-khai)
   - [Lấy danh sách pin từ kênh](#9-lấy-danh-sách-pin-từ-kênh)
   - [Xuất dữ liệu kênh ra Excel](#10-xuất-dữ-liệu-kênh-ra-excel)
   - [Tải toàn bộ ảnh kênh dạng ZIP](#11-tải-toàn-bộ-ảnh-kênh-dạng-zip)
   - [Xoá cache kênh](#12-xoá-cache-kênh)
6. [Tải nội dung từ 1 Pin đơn lẻ](#tải-nội-dung-từ-1-pin-đơn-lẻ)
   - [Tải video từ 1 pin](#13-tải-video-từ-1-pin)
   - [Tải ảnh từ 1 pin](#14-tải-ảnh-từ-1-pin)
   - [Tải audio từ 1 pin video](#15-tải-audio-từ-1-pin-video)
7. [Kiến trúc & Cơ chế hoạt động](#kiến-trúc--cơ-chế-hoạt-động)
8. [Mã lỗi thường gặp](#mã-lỗi-thường-gặp)

---

## Cấu hình Environment (.env)
Để tính năng OAuth2 hoạt động, bạn cần cấu hình các thông số sau trong file `.env` ở BE:
```env
PINTEREST_CLIENT_ID=your_client_id
PINTEREST_CLIENT_SECRET=your_client_secret
PINTEREST_REDIRECT_URI=http://localhost:3000/auth/pinterest/callback
```
*Lưu ý:* `PINTEREST_REDIRECT_URI` là địa chỉ trang callback ở phía Client (Frontend) của bạn. Sau khi người dùng đồng ý cấp quyền trên Pinterest, Pinterest sẽ chuyển hướng về địa chỉ này kèm theo query `?code=xxxx`.

---

## Cơ chế Xác thực & Quản lý kênh

Hệ thống quản lý các tài khoản Pinterest đã kết nối bằng cách lưu thông tin vào file JSON cục bộ (`data/pinterest/accounts.json`). Token truy cập (`access_token`) sẽ được **tự động làm mới (refresh)** bằng `refresh_token` khi gần hết hạn (dưới 5 phút trước khi hết hạn) mỗi khi hệ thống thực hiện tác vụ liên quan đến tài khoản đó (ví dụ như đăng Pin).

### 1. Lấy URL đăng nhập OAuth2

Lấy đường dẫn để hướng người dùng sang Pinterest chấp nhận liên kết tài khoản.

#### Request
```
GET /api/v1/pinterest/auth/url
```

#### Response (200)
```json
{
  "success": true,
  "url": "https://www.pinterest.com/oauth/?consumer_id=12345&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fpinterest%2Fcallback&response_type=code&scope=pins:read,pins:write,boards:read,user_accounts:read&state=abcxyz",
  "state": "abcxyz"
}
```

---

### 2. Callback kết nối tài khoản

Gửi Authorization Code nhận được từ Pinterest lên Backend để tiến hành đổi lấy tokens và lưu trữ kết nối kênh.

#### Request
```
POST /api/v1/pinterest/auth/callback
```
**Body:**
```json
{
  "code": "pina_code_from_pinterest_redirect"
}
```

#### Cách hoạt động
1. BE tiếp nhận `code`, gửi request POST sử dụng Basic Auth Header (clientId:clientSecret) tới Pinterest OAuth API để lấy `access_token` và `refresh_token`.
2. Dùng `access_token` vừa nhận được gọi API `GET /v5/user_account` của Pinterest để lấy thông tin profile (username, business name, avatar).
3. Đóng gói dữ liệu và ghi vào file `data/pinterest/accounts.json`. Nếu tài khoản trùng username đã tồn tại trước đó, BE sẽ cập nhật token mới.

#### Response (200)
```json
{
  "success": true,
  "message": "Account connected successfully.",
  "account": {
    "username": "my_pinterest_username",
    "fullName": "My Brand Name",
    "avatarUrl": "https://a.pinimg.com/...jpg",
    "connectedAt": 1719900000000
  }
}
```

---

### 3. Lấy danh sách kênh đã kết nối

Liệt kê toàn bộ các tài khoản Pinterest đã liên kết thành công để hiển thị trên Dashboard quản lý.

#### Request
```
GET /api/v1/pinterest/accounts
```

#### Response (200)
- Các trường nhạy cảm như `accessToken`, `refreshToken` đã được loại bỏ để bảo mật thông tin.
```json
{
  "success": true,
  "count": 1,
  "channels": [
    {
      "username": "my_pinterest_username",
      "fullName": "My Brand Name",
      "avatarUrl": "https://a.pinimg.com/...jpg",
      "connectedAt": 1719900000000,
      "expiresAt": 1722492000000,
      "isExpired": false
    }
  ]
}
```

---

### 4. Hủy kết nối một kênh

Hủy liên kết và xóa hoàn toàn thông tin tài khoản Pinterest khỏi hệ thống.

#### Request
```
DELETE /api/v1/pinterest/accounts/:username
```

#### Response (200)
```json
{
  "success": true,
  "message": "Pinterest account \"my_pinterest_username\" has been disconnected."
}
```

---

### 5. Kiểm tra trạng thái token của kênh

Kiểm tra thủ công xem token của tài khoản đó còn hạn không và có hoạt động được không (gọi test API Pinterest).

#### Request
```
GET /api/v1/pinterest/accounts/:username/check-token
```

#### Response (200)
```json
{
  "success": true,
  "username": "my_pinterest_username",
  "isExpired": false,
  "timeLeftSeconds": 2592000,
  "isWorking": true,
  "errorMessage": null
}
```
*Lưu ý:* Nếu `isWorking` là `false`, hệ thống sẽ trả về lỗi chi tiết trong `errorMessage` (ví dụ: User đã thu hồi quyền trên Pinterest của ứng dụng).

---

## Hẹn giờ đăng pin (Schedule)

### 6. Hẹn giờ đăng pin (Schedule)

Hẹn giờ tự động đăng pin lên Pinterest thông qua **Pinterest v5 REST API** (`POST /v5/pins`). Hệ thống sẽ tự động dùng token lưu trong JSON của `username` truyền vào, và tự làm mới token nếu nó đã hết hạn khi đến giờ gửi bài.

#### Request
```
POST /api/v1/pinterest/schedule
```
**Body:**
| Trường         | Kiểu     | Bắt buộc | Validate                                      | Mô tả                                    |
| -------------- | -------- | -------- | --------------------------------------------- | ----------------------------------------- |
| `username`     | `string` | **Có**   | Kênh đã kết nối trong hệ thống                | Username tài khoản đã kết nối             |
| `boardId`      | `string` | **Có**   | Không rỗng                                    | ID board Pinterest (chuỗi số)             |
| `title`        | `string` | **Có**   | Không rỗng, tối đa 100 ký tự                 | Tiêu đề pin                               |
| `description`  | `string` | **Có**   | Không rỗng, tối đa 800 ký tự                 | Mô tả nội dung pin                        |
| `imageUrl`     | `string` | **Có**   | URL hợp lệ                                   | URL ảnh công khai để làm media cho pin     |
| `scheduleTime` | `string` | **Có**   | ISO 8601, phải >= 60 giây trong tương lai     | Thời điểm đăng pin (UTC hoặc múi giờ ISO)|
| `link`         | `string` | Không    | URL hợp lệ (nếu có)                          | Link đích khi bấm vào pin                 |
| `altText`      | `string` | Không    | Tối đa 500 ký tự (nếu có)                    | Mô tả ảnh cho người dùng hỗ trợ tiếp cận  |

```json
{
  "username": "my_pinterest_username",
  "boardId": "1234567890123456789",
  "title": "10 ý tưởng phòng khách hiện đại",
  "description": "Khám phá xu hướng thiết kế nội thất mới nhất...",
  "imageUrl": "https://example.com/images/living-room.jpg",
  "scheduleTime": "2026-08-01T14:30:00.000Z",
  "link": "https://myblog.com/living-room-guide",
  "altText": "Phòng khách hiện đại với nội thất trắng"
}
```

#### Cách hoạt động
1. BE check nhanh xem `username` gửi lên đã kết nối chưa. Nếu chưa -> Báo lỗi 404 lập tức.
2. Dùng `SchedulerRegistry` của NestJS để thiết lập một CronJob một lần (one-shot) định giờ chạy lúc `scheduleTime`.
3. Khi đến giờ chạy:
   - BE lấy token hợp lệ của `username` (tự động Refresh bằng refresh_token nếu token đã hết hạn).
   - Gửi yêu cầu đăng bài lên Pinterest v5 API.
   - Khi hoàn thành (hoặc khi gặp lỗi), job sẽ tự hủy khỏi registry để giải phóng bộ nhớ.

#### Response (201)
```json
{
  "success": true,
  "jobName": "pin-1234567890123456789-1753969800000",
  "scheduledFor": "2026-08-01T14:30:00.000Z",
  "boardId": "1234567890123456789",
  "title": "10 ý tưởng phòng khách hiện đại"
}
```

---

### 7. Xem danh sách job đã hẹn

Liệt kê tất cả các job đăng pin đang chờ trong bộ nhớ RAM của server.

#### Request
```
GET /api/v1/pinterest/schedule
```

#### Response (200)
```json
{
  "success": true,
  "count": 1,
  "jobs": [
    {
      "jobName": "pin-1234567890123456789-1753969800000",
      "nextFireTime": "2026-08-01T14:30:00.000+00:00"
    }
  ]
}
```

---

### 8. Huỷ job hẹn giờ

Hủy và xóa hoàn toàn lịch trình đăng pin của một công việc đang chờ.

#### Request
```
DELETE /api/v1/pinterest/schedule/:jobName
```

#### Response (200)
```json
{
  "success": true,
  "message": "Job \"pin-1234567890123456789-1753969800000\" has been cancelled."
}
```

---

## Crawl dữ liệu Pinterest (Công khai)

Nhóm API này sử dụng Pinterest Web API nội bộ qua Proxy, hoàn toàn **không yêu cầu đăng nhập/token**.

### 9. Lấy danh sách pin từ kênh

Crawl toàn bộ pin từ một profile / board / `_created` / `_saved` của Pinterest, lưu vào cache JSON trên server, sau đó trả về dữ liệu phân trang cho client.

#### Request
```
POST /api/v1/pinterest/channel?type=video&page=1&pageSize=10
```
**Body:**
```json
{
  "url": "https://www.pinterest.com/username/board-name/"
}
```

#### Response (200)
```json
{
  "success": true,
  "user": {
    "username": "username",
    "follower_count": 5000,
    "pin_count": 320
  },
  "items": [
    {
      "id": "111222333",
      "title": "Tiêu đề pin",
      "type": "image",
      "pin_url": "https://www.pinterest.com/pin/111222333/",
      "image_url": "https://i.pinimg.com/originals/...",
      "like_count": 120,
      "save_count": 30
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "totalCount": 45,
    "hasMore": true
  }
}
```

---

### 10. Xuất dữ liệu kênh ra Excel

Xuất toàn bộ pin đã crawl (từ cache) ra file `.xlsx`.

#### Request
```
POST /api/v1/pinterest/channel/export?type=image
```
**Body:**
```json
{
  "url": "https://www.pinterest.com/username/board-name/"
}
```

#### Response (200)
Trả về file binary `.xlsx` — trình duyệt sẽ tự động tải xuống.

---

### 11. Tải toàn bộ ảnh kênh dạng ZIP

Tải tất cả ảnh gốc (original) từ cache kênh Pinterest, đóng gói thành file `.zip`.

#### Request
```
POST /api/v1/pinterest/channel/export-images?type=image
```
**Body:**
```json
{
  "url": "https://www.pinterest.com/username/board-name/"
}
```

---

### 12. Xoá cache kênh

Xoá các file JSON đã lưu trong thư mục `data/pinterest/`.

#### Request
```
POST /api/v1/pinterest/channel/clear-cache
```

---

## Tải nội dung từ 1 Pin đơn lẻ

### 13. Tải video từ 1 pin

Tải video chất lượng cao nhất từ một pin Pinterest. Tự động kiểm tra codec và re-encode về định dạng chuẩn H.264/AAC nếu cần để tăng tính tương thích.

#### Request
```
POST /api/v1/pinterest/video
```
**Body:**
```json
{
  "url": "https://www.pinterest.com/pin/123456789/"
}
```

---

### 14. Tải ảnh từ 1 pin

Tải ảnh chất lượng gốc (original) từ một pin Pinterest.

#### Request
```
POST /api/v1/pinterest/image
```
**Body:**
```json
{
  "url": "https://www.pinterest.com/pin/123456789/"
}
```

---

### 15. Tải audio từ 1 pin video

Trích xuất âm thanh (MP3, 192 kbps) từ video của một pin Pinterest.

#### Request
```
POST /api/v1/pinterest/audio
```
**Body:**
```json
{
  "url": "https://www.pinterest.com/pin/123456789/"
}
```

---

## Kiến trúc & Cơ chế hoạt động

```
src/modules/pinterest/
├── dto/
│   ├── pinterest-channel.dto.ts        # DTO cho API crawl kênh
│   ├── download-pinterest-video.dto.ts # DTO tải video
│   ├── download-pinterest-image.dto.ts # DTO tải ảnh
│   ├── download-pinterest-audio.dto.ts # DTO tải audio
│   ├── pinterest-auth.dto.ts           # DTO đón authorization code (New)
│   └── schedule-pin.dto.ts             # DTO hẹn giờ đăng pin (v5 API) (Updated)
├── pinterest.module.ts                 # Đăng ký ScheduleModule.forRoot()
├── pinterest.controller.ts             # Cung cấp 14 endpoints API
└── pinterest.service.ts                # Xử lý logic, lưu trữ JSON, điều phối CronJob
```

### Cơ chế Tự động Làm mới Token (Auto-Refresh Token)

```
        Yêu cầu tác vụ (Đăng bài / check-token)
                      │
                      v
        [Đọc accounts.json bằng username]
                      │
                      ├─► Không tìm thấy -> Trả về lỗi 404 (Chưa kết nối)
                      │
                      v
       [Kiểm tra thời gian hiện tại vs expiresAt]
                      │
                      ├─► Còn hạn (> 5 phút) ───────┐
                      │                            │
                      ├─► Sắp/Đã hết hạn (< 5 phút) │
                      │                            │
                      v                            │
       [Gửi Refresh Token sang Pinterest]           │
                      │                            │
             Thành công / Trả về tokens mới         │
                      │                            │
                      v                            │
        [Cập nhật tokens mới vào JSON]              │
                      │                            │
                      v                            │
            [Trả về Access Token] ◄────────────────┘
                      │
                      v
             [Thực hiện API Call]
```

---

## Mã lỗi thường gặp

| HTTP Status | Nguyên nhân | Cách xử lý |
| ----------- | ----------- | ---------- |
| `400` | URL Pinterest không hợp lệ | Kiểm tra lại định dạng link gửi lên |
| `400` | Pin không chứa video khi gọi tải video/audio | Chỉ sử dụng video/audio API đối với các pin là Video |
| `400` | Chưa có dữ liệu cache khi xuất Excel/ZIP | Cần gọi API `/channel` tối thiểu 1 lần trước để quét dữ liệu |
| `400` | `scheduleTime` là thời gian quá khứ hoặc < 60s | Chọn thời gian xa hơn trong tương lai |
| `400` | OAuth exchange code bị lỗi hoặc hết hạn | Thực hiện đăng nhập lại từ đầu để lấy authorization code mới |
| `400` | Trùng lặp job (cùng Board ID và cùng thời điểm) | Hủy job cũ trước hoặc đổi thời gian đăng bài khác |
| `404` | Kênh (`username`) chưa được liên kết | Gọi luồng OAuth2 để kết nối tài khoản trước khi thực hiện các tác vụ của tài khoản đó |
