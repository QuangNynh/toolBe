# VieNeu-TTS Local Server

A local REST API server powered by [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) — Vietnamese TTS with instant voice cloning.

## Features

- 🇻🇳 High-quality Vietnamese & bilingual (Vi-En) TTS
- 🎙️ Instant voice cloning from 3-5s reference audio
- 🚀 48kHz audio output (v3 Turbo)
- 💻 Runs entirely offline on CPU (ONNX) or GPU (PyTorch)
- 🎭 Emotion cues: `[cười]`, `[thở dài]`, `[hắng giọng]`

## Setup

### 1. Install dependencies

```bash
cd python-tts-service

# Option A: Using uv (recommended for speed)
uv venv
uv pip install -r requirements.txt

# Option B: Using pip
python -m venv venv
source venv/bin/activate  # Linux/macOS
pip install -r requirements.txt
```

### 2. Install eSpeak NG (required for phonemization)

```bash
# macOS
brew install espeak

# Ubuntu/Debian
sudo apt install espeak-ng
```

### 3. Start the server

```bash
python server.py
```

Server runs at `http://localhost:8020` by default.

## API Endpoints

### `GET /health`
Health check.

### `GET /voices`
List available preset voices.

### `POST /tts/generate`
Generate speech from text.

**JSON Body:**
```json
{
  "text": "Xin chào, đây là VieNeu-TTS.",
  "voice": "Bình An",
  "ref_audio_path": null,
  "ref_text": null
}
```

**Response:** WAV audio file (`audio/wav`)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIENEU_PORT` | `8020` | Server port |
