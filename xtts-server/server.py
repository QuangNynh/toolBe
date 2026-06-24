"""
XTTS v2 Local TTS Server
FastAPI server wrapping Coqui XTTS v2 for text-to-speech with voice cloning.

Endpoints:
  GET  /speakers          - List built-in + cloned voices
  GET  /languages         - List supported languages
  POST /clone-voice       - Upload WAV to create a cloned voice
  POST /tts               - Synthesize speech from text
  GET  /health            - Health check
"""

import os
import shutil
import uuid
import json
from pathlib import Path
from typing import Optional

import torch
import torchaudio
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import Xtts

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────
VOICES_DIR = Path(__file__).parent / "voices"
OUTPUT_DIR = Path(__file__).parent / "output"
MODEL_DIR = Path(__file__).parent / "model"

VOICES_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

SUPPORTED_LANGUAGES = [
    {"code": "en", "name": "English"},
    {"code": "es", "name": "Spanish"},
    {"code": "fr", "name": "French"},
    {"code": "de", "name": "German"},
    {"code": "it", "name": "Italian"},
    {"code": "pt", "name": "Portuguese"},
    {"code": "pl", "name": "Polish"},
    {"code": "tr", "name": "Turkish"},
    {"code": "ru", "name": "Russian"},
    {"code": "nl", "name": "Dutch"},
    {"code": "cs", "name": "Czech"},
    {"code": "ar", "name": "Arabic"},
    {"code": "zh-cn", "name": "Chinese"},
    {"code": "ja", "name": "Japanese"},
    {"code": "hu", "name": "Hungarian"},
    {"code": "ko", "name": "Korean"},
    {"code": "hi", "name": "Hindi"},
    {"code": "vi", "name": "Vietnamese"},
]

# ──────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────
app = FastAPI(
    title="XTTS v2 TTS Server",
    description="Local XTTS v2 server for TTS and voice cloning",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# Model loading
# ──────────────────────────────────────────────
model: Optional[Xtts] = None
config: Optional[XttsConfig] = None


def get_device():
    if torch.cuda.is_available():
        return "cuda"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@app.on_event("startup")
async def load_model():
    """Load XTTS v2 model on server startup."""
    global model, config

    device = get_device()
    print(f"🔧 Loading XTTS v2 model on device: {device}")

    # Use the TTS library to download/load the model
    from TTS.utils.manage import ModelManager

    manager = ModelManager()
    model_path, config_path, _ = manager.download_model("tts_models/multilingual/multi-dataset/xtts_v2")

    print(f"📁 Model path: {model_path}")
    print(f"📁 Config path: {config_path}")

    config = XttsConfig()
    config.load_json(config_path)

    model = Xtts.init_from_config(config)
    model.load_checkpoint(config, checkpoint_dir=model_path, eval=True)
    model.to(device)

    print("✅ XTTS v2 model loaded successfully!")


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────
def get_cloned_voices():
    """Get list of cloned voices from the voices directory."""
    voices = []
    for wav_file in VOICES_DIR.glob("*.wav"):
        meta_file = wav_file.with_suffix(".json")
        name = wav_file.stem
        meta = {}
        if meta_file.exists():
            with open(meta_file, "r") as f:
                meta = json.load(f)
            name = meta.get("name", name)
        voices.append({
            "id": wav_file.stem,
            "name": name,
            "type": "cloned",
            "file": wav_file.name,
            "description": meta.get("description", ""),
        })
    return voices


def get_builtin_speakers():
    """Get list of built-in XTTS v2 speakers."""
    if model is None:
        return []

    speakers = []
    if hasattr(model, "speaker_manager") and model.speaker_manager is not None:
        speaker_names = list(model.speaker_manager.name_to_id.keys())
        for name in sorted(speaker_names):
            speakers.append({
                "id": name,
                "name": name,
                "type": "builtin",
            })
    return speakers


# ──────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────
@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "device": get_device(),
        "gpu_available": torch.cuda.is_available(),
    }


@app.get("/speakers")
async def list_speakers():
    """List all available voices: built-in speakers + cloned voices."""
    builtin = get_builtin_speakers()
    cloned = get_cloned_voices()
    return {
        "builtin": builtin,
        "cloned": cloned,
        "total": len(builtin) + len(cloned),
    }


@app.get("/languages")
async def list_languages():
    """List all supported languages."""
    return {"languages": SUPPORTED_LANGUAGES}


@app.post("/clone-voice")
async def clone_voice(
    name: str = Form(..., description="Name for the cloned voice"),
    description: str = Form("", description="Optional description"),
    file: UploadFile = File(..., description="WAV reference audio (6-10s, clean speech)"),
):
    """
    Upload a WAV file to create a new cloned voice.
    The reference audio should be 6-10 seconds of clean, single-speaker speech.
    """
    if not file.filename.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
        raise HTTPException(400, "Only WAV, MP3, FLAC, OGG files are supported.")

    voice_id = str(uuid.uuid4())[:8]
    voice_filename = f"{voice_id}.wav"
    voice_path = VOICES_DIR / voice_filename

    # Save uploaded file
    temp_path = VOICES_DIR / f"temp_{voice_filename}"
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Convert to proper WAV format (22050Hz, mono, 16-bit) using torchaudio
    try:
        waveform, sample_rate = torchaudio.load(str(temp_path))

        # Convert to mono if stereo
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)

        # Resample to 22050Hz
        if sample_rate != 22050:
            resampler = torchaudio.transforms.Resample(sample_rate, 22050)
            waveform = resampler(waveform)

        torchaudio.save(str(voice_path), waveform, 22050)
        temp_path.unlink(missing_ok=True)
    except Exception as e:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(400, f"Failed to process audio file: {str(e)}")

    # Save metadata
    meta_path = voice_path.with_suffix(".json")
    with open(meta_path, "w") as f:
        json.dump({
            "name": name,
            "description": description,
            "original_filename": file.filename,
        }, f, indent=2)

    return {
        "success": True,
        "voice": {
            "id": voice_id,
            "name": name,
            "type": "cloned",
            "file": voice_filename,
        },
    }


@app.delete("/clone-voice/{voice_id}")
async def delete_cloned_voice(voice_id: str):
    """Delete a cloned voice by its ID."""
    voice_path = VOICES_DIR / f"{voice_id}.wav"
    meta_path = VOICES_DIR / f"{voice_id}.json"

    if not voice_path.exists():
        raise HTTPException(404, f"Voice '{voice_id}' not found.")

    voice_path.unlink(missing_ok=True)
    meta_path.unlink(missing_ok=True)

    return {"success": True, "message": f"Voice '{voice_id}' deleted."}


@app.post("/tts")
async def text_to_speech(
    text: str = Form(..., description="Text to synthesize"),
    language: str = Form("vi", description="Language code (e.g., vi, en, zh-cn)"),
    speaker: str = Form("", description="Built-in speaker name (leave empty for cloned voice)"),
    voice_id: str = Form("", description="Cloned voice ID (leave empty for built-in speaker)"),
):
    """
    Synthesize speech from text.
    Either provide a built-in `speaker` name or a cloned `voice_id`.
    Returns a WAV audio file.
    """
    if model is None:
        raise HTTPException(503, "Model not loaded yet. Please wait.")

    if not text.strip():
        raise HTTPException(400, "Text cannot be empty.")

    device = get_device()
    output_id = str(uuid.uuid4())[:12]
    output_path = OUTPUT_DIR / f"{output_id}.wav"

    try:
        if voice_id:
            # Use cloned voice
            voice_path = VOICES_DIR / f"{voice_id}.wav"
            if not voice_path.exists():
                raise HTTPException(404, f"Cloned voice '{voice_id}' not found.")

            gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(
                audio_path=[str(voice_path)]
            )

            out = model.inference(
                text=text,
                language=language,
                gpt_cond_latent=gpt_cond_latent,
                speaker_embedding=speaker_embedding,
            )
        elif speaker:
            # Use built-in speaker
            if model.speaker_manager is None:
                raise HTTPException(400, "Model does not support built-in speakers.")

            if speaker not in model.speaker_manager.name_to_id:
                available = list(model.speaker_manager.name_to_id.keys())[:10]
                raise HTTPException(
                    404,
                    f"Speaker '{speaker}' not found. Available: {available}...",
                )

            gpt_cond_latent, speaker_embedding = model.speaker_manager.speakers[speaker].values()

            out = model.inference(
                text=text,
                language=language,
                gpt_cond_latent=gpt_cond_latent,
                speaker_embedding=speaker_embedding,
            )
        else:
            raise HTTPException(400, "Provide either 'speaker' (built-in) or 'voice_id' (cloned).")

        # Save output
        wav_tensor = torch.tensor(out["wav"]).unsqueeze(0)
        torchaudio.save(str(output_path), wav_tensor, 24000)

        return FileResponse(
            str(output_path),
            media_type="audio/wav",
            filename=f"tts_{output_id}.wav",
        )

    except HTTPException:
        raise
    except Exception as e:
        output_path.unlink(missing_ok=True)
        raise HTTPException(500, f"TTS synthesis failed: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("XTTS_PORT", "8888"))
    print(f"🚀 Starting XTTS v2 server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
