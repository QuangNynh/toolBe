# TTS API Setup Guide

## Cài đặt Python Dependencies

1. Tạo virtual environment (nếu chưa có):

```bash
python3 -m venv venv
```

2. Kích hoạt virtual environment:

```bash
source venv/bin/activate
```

3. Cài đặt dependencies:

```bash
pip install -r requirements.txt
```

## Chạy API

1. Khởi động server:

```bash
npm run dev
```

2. API sẽ chạy tại: `http://localhost:8000`
3. Swagger docs: `http://localhost:8000/api/docs`

## Test API

### Sử dụng curl (text ngắn):

```bash
curl -X POST http://localhost:8000/api/v1/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test message"}' \
  --output speech.wav
```

### Text dài (150,000 ký tự):

```bash
curl -X POST http://localhost:8000/api/v1/tts/generate \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$(cat your-long-text-file.txt)\"}" \
  --output speech.wav \
  --max-time 1800
```

### Sử dụng Swagger UI:

1. Mở `http://localhost:8000/api/docs`
2. Tìm endpoint `POST /api/v1/tts/generate`
3. Click "Try it out"
4. Nhập text vào body (tối đa 200,000 ký tự)
5. Click "Execute"
6. Download file audio từ response

## Tính năng

### Xử lý Text Dài

- Hỗ trợ tối đa 200,000 ký tự
- Tự động chia text thành các đoạn nhỏ (~400 ký tự/đoạn, ~150 từ)
- Mỗi đoạn được xử lý riêng biệt và lưu thành file tạm
- Sử dụng FFmpeg để ghép các file audio lại thành một file hoàn chỉnh
- Tự động thêm khoảng lặng 200ms giữa các đoạn
- Tự động cleanup các file tạm sau khi hoàn thành

### Ước tính thời gian xử lý:

- 1,000 ký tự: **~2-3 giây** ⚡
- 10,000 ký tự: **~20-30 giây** ⚡
- 150,000 ký tự: **~5-7 phút** ⚡ (nhanh gấp 3-4 lần!)

### Yêu cầu hệ thống:

- Python 3.9+
- FFmpeg phải được cài đặt trên hệ thống
- Cài đặt FFmpeg trên macOS: `brew install ffmpeg`
- Cài đặt FFmpeg trên Ubuntu: `sudo apt-get install ffmpeg`
- RAM: Tối thiểu 2GB (khuyến nghị 4GB+)
- Không cần GPU!

## Model Information

API sử dụng **Piper TTS** - một TTS engine cực kỳ nhanh và nhẹ:

- Model: `en_US-lessac-medium` (giọng Anh chất lượng cao)
- Công nghệ: VITS-based, optimized với ONNX Runtime
- Miễn phí và open source (MIT License)
- **Cực kỳ nhanh**: Nhanh hơn 5-10x so với SpeechT5!
- **Cực kỳ nhẹ**: Chỉ ~15MB model size
- Chất lượng giọng nói tự nhiên
- Không cần GPU, chạy tốt trên CPU
- Tự động download model khi chạy lần đầu

### Ưu điểm của Piper:

- ✅ **Siêu nhanh**: ~500-1000 chars/s (nhanh nhất!)
- ✅ **Siêu nhẹ**: Model chỉ 15MB
- ✅ RAM thấp: ~500MB-1GB
- ✅ Chất lượng giọng xuất sắc
- ✅ Hỗ trợ 40+ ngôn ngữ
- ✅ Không cần GPU
- ✅ Production-ready

## Lưu ý

- Lần chạy đầu tiên sẽ download model (~15MB) - rất nhanh!
- Model sẽ được cache tại `~/.local/share/piper/`
- API tự động cleanup file tạm sau khi generate
- Text dài sẽ được chia thành các đoạn ~400 ký tự để xử lý
- Xử lý 5 chunks đồng thời để tối ưu tốc độ
- Piper chạy cực nhanh trên CPU, không cần GPU!

## Thay đổi giọng nói (nâng cao)

Bạn có thể thay đổi model trong `src/python/tts_vits.py`:

```python
# Tiếng Anh - giọng nam (mặc định)
model = "en_US-lessac-medium"

# Tiếng Anh - giọng nữ
model = "en_US-amy-medium"

# Tiếng Anh - giọng nam khác
model = "en_US-ryan-medium"

# Tiếng Việt
model = "vi_VN-vivos-medium"

# Xem tất cả models: https://github.com/rhasspy/piper/blob/master/VOICES.md
```
