"""
VieNeu-TTS Local REST API Server
================================
A lightweight Flask server wrapping VieNeu-TTS for local TTS generation.
Replaces the previous XTTS-v2 / Gemini TTS dependency.

Endpoints:
  GET  /health               → Server health check
  GET  /voices               → List available preset voices
  POST /tts/generate         → Generate speech from text (returns WAV audio)
  POST /tts/generate-from-srt → Generate speech from SRT subtitles with
                                 per-line speed adjustment to match timelines

Default port: 8020 (same as previous XTTS server for drop-in compatibility)
"""

import io
import os
import sys
import json
import tempfile
import re
import wave
import subprocess
import shutil
import logging
from pathlib import Path

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("vieneu-server")

# ──────────────────────────────────────────────────────────────────────────────
# Flask app
# ──────────────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# ──────────────────────────────────────────────────────────────────────────────
# Lazy-init VieNeu-TTS (model loads on first request or startup)
# ──────────────────────────────────────────────────────────────────────────────
_tts_engine = None


def get_tts_engine():
    """Lazy-load the VieNeu-TTS engine."""
    global _tts_engine
    if _tts_engine is None:
        logger.info("Loading VieNeu-TTS engine (first call)...")
        try:
            from vieneu import Vieneu

            # Default = v3 Turbo. CPU → ONNX (torch-free); GPU → PyTorch (auto).
            _tts_engine = Vieneu()
            logger.info("VieNeu-TTS engine loaded successfully!")
        except Exception as e:
            logger.error(f"Failed to load VieNeu-TTS: {e}")
            raise
    return _tts_engine


# ──────────────────────────────────────────────────────────────────────────────
# Cached voices list
# ──────────────────────────────────────────────────────────────────────────────
_cached_voices = None


def get_voices():
    """Fetch and cache the list of preset voices."""
    global _cached_voices
    if _cached_voices is None:
        tts = get_tts_engine()
        try:
            raw = tts.list_preset_voices()
            # raw is a list of (label, voice_id) tuples
            _cached_voices = [
                {"id": vid, "label": label, "gender": "Unknown", "character": label}
                for label, vid in raw
            ]
        except Exception as e:
            logger.error(f"Failed to list voices: {e}")
            _cached_voices = []
    return _cached_voices


# ──────────────────────────────────────────────────────────────────────────────
# SRT Parsing & Audio Processing Helpers
# ──────────────────────────────────────────────────────────────────────────────

def parse_srt(srt_content):
    """Parse SRT content into a list of subtitle entries sorted by start time."""
    entries = []
    blocks = re.split(r'\n\s*\n', srt_content.strip())
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 3:
            continue
        try:
            index = int(lines[0].strip())
        except ValueError:
            continue
        time_match = re.match(
            r'(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})',
            lines[1].strip(),
        )
        if not time_match:
            continue
        g = time_match.groups()
        start_ms = (int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2])) * 1000 + int(g[3])
        end_ms = (int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6])) * 1000 + int(g[7])
        text = '\n'.join(lines[2:]).strip()
        if text and end_ms > start_ms:
            entries.append({
                'index': index,
                'start_ms': start_ms,
                'end_ms': end_ms,
                'duration_ms': end_ms - start_ms,
                'text': text,
            })
    entries.sort(key=lambda e: e['start_ms'])
    return entries


def get_wav_duration_ms(wav_path):
    """Return the duration of a WAV file in milliseconds."""
    with wave.open(wav_path, 'rb') as wf:
        return int(wf.getnframes() / wf.getframerate() * 1000)


def get_wav_params(wav_path):
    """Return the parameters of a WAV file."""
    with wave.open(wav_path, 'rb') as wf:
        return wf.getparams()


def _build_atempo_filter(speed_factor):
    """
    Build an ffmpeg atempo filter string.

    Each individual ``atempo`` instance accepts [0.5, 100.0], so extreme
    values are handled by chaining multiple filters.

    * speed_factor > 1.0 → faster (shorter audio)
    * speed_factor < 1.0 → slower  (longer  audio)
    """
    filters = []
    remaining = speed_factor
    while remaining < 0.5:
        filters.append('atempo=0.5')
        remaining /= 0.5
    while remaining > 100.0:
        filters.append('atempo=100.0')
        remaining /= 100.0
    filters.append(f'atempo={remaining:.6f}')
    return ','.join(filters)


def adjust_audio_speed(input_path, output_path, speed_factor):
    """
    Adjust audio playback speed using ffmpeg ``atempo`` filter.

    Pitch is preserved while the duration changes.
    """
    filter_str = _build_atempo_filter(speed_factor)
    cmd = [
        'ffmpeg', '-y', '-i', input_path,
        '-filter:a', filter_str,
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg atempo failed: {result.stderr}')


def create_silence_wav(output_path, duration_ms, sample_rate=48000,
                       channels=1, sampwidth=2):
    """Create a WAV file containing *duration_ms* of silence."""
    num_frames = int(sample_rate * duration_ms / 1000)
    with wave.open(output_path, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)
        wf.writeframes(b'\x00' * (num_frames * channels * sampwidth))


def concatenate_wav_files(wav_paths, output_path):
    """Concatenate multiple WAV files into a single output WAV."""
    if not wav_paths:
        raise ValueError('No WAV files to concatenate')
    with wave.open(wav_paths[0], 'rb') as wf:
        params = wf.getparams()
    with wave.open(output_path, 'wb') as out:
        out.setnchannels(params.nchannels)
        out.setsampwidth(params.sampwidth)
        out.setframerate(params.framerate)
        for path in wav_paths:
            with wave.open(path, 'rb') as inp:
                out.writeframes(inp.readframes(inp.getnframes()))


# ──────────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "engine": "VieNeu-TTS"})


@app.route("/voices", methods=["GET"])
def list_voices():
    """Return all available preset voices."""
    try:
        voices = get_voices()
        return jsonify({"voices": voices, "total": len(voices)})
    except Exception as e:
        logger.error(f"/voices error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/tts/generate", methods=["POST"])
def generate_tts():
    """
    Generate speech from text.

    JSON body:
      {
        "text": "Xin chào, đây là VieNeu-TTS.",
        "voice": "Bình An",         // optional, preset voice name or ID
        "ref_audio_path": null,     // optional, path to reference audio for cloning
        "ref_text": null            // optional, transcript of reference audio
      }

    Returns: WAV audio file (audio/wav)
    """
    # Parse request
    if request.content_type and "multipart/form-data" in request.content_type:
        text = request.form.get("text", "")
        voice = request.form.get("voice", None)
        ref_text = request.form.get("ref_text", None)
        ref_audio_file = request.files.get("ref_audio", None)
    else:
        data = request.get_json(force=True, silent=True) or {}
        text = data.get("text", "")
        voice = data.get("voice", None)
        ref_text = data.get("ref_text", None)
        ref_audio_file = None

    if not text or not text.strip():
        return jsonify({"error": "Missing or empty 'text' field."}), 400

    try:
        tts = get_tts_engine()
        infer_kwargs = {"text": text}

        # Voice selection
        if voice:
            infer_kwargs["voice"] = voice

        # Handle reference audio for voice cloning
        ref_audio_path = None
        if ref_audio_file:
            # Save uploaded reference audio to temp file
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
            ref_audio_file.save(tmp.name)
            ref_audio_path = tmp.name
            infer_kwargs["ref_audio"] = ref_audio_path
            if ref_text:
                infer_kwargs["ref_text"] = ref_text

        logger.info(
            f"Generating TTS: text={len(text)} chars, voice={voice or 'default'}"
        )

        # Run inference
        audio = tts.infer(**infer_kwargs)

        # Save to temp WAV file
        output_path = tempfile.mktemp(suffix=".wav")
        tts.save(audio, output_path)

        logger.info(f"TTS generated: {output_path}")

        # Stream the WAV file back
        response = send_file(
            output_path,
            mimetype="audio/wav",
            as_attachment=True,
            download_name="tts_output.wav",
        )

        # Clean up temp files after sending
        @response.call_on_close
        def cleanup():
            try:
                if os.path.exists(output_path):
                    os.unlink(output_path)
                if ref_audio_path and os.path.exists(ref_audio_path):
                    os.unlink(ref_audio_path)
            except Exception:
                pass

        return response

    except Exception as e:
        logger.error(f"TTS generation failed: {e}", exc_info=True)
        return jsonify({"error": f"TTS generation failed: {str(e)}"}), 500


@app.route("/tts/generate-from-srt", methods=["POST"])
def generate_tts_from_srt():
    """
    Generate speech from an SRT subtitle file.

    Each subtitle line is synthesised individually, then its playback speed is
    adjusted so that the audio duration exactly matches the SRT timeline:
      • audio too short → slow down (atempo < 1)
      • audio too long  → speed up  (atempo > 1)

    All adjusted segments are concatenated (with silence in the gaps between
    subtitles) into a single WAV file.

    Accepts JSON **or** multipart/form-data.

    JSON body example:
      {
        "srt": "1\n00:00:00,000 --> 00:00:02,500\nXin chào\n\n...",
        "voice": "Bình An",
        "speed_tolerance": 0.05
      }

    Multipart fields:
      srt_file       – .srt file upload
      voice          – preset voice name (optional)
      ref_audio      – reference audio file for cloning (optional)
      ref_text       – transcript of reference audio (optional)
      speed_tolerance – float, default 0.05 (5 %)

    Returns: WAV audio file (audio/wav)
    """
    # ------------------------------------------------------------------
    # Pre-flight: make sure ffmpeg is available
    # ------------------------------------------------------------------
    if shutil.which('ffmpeg') is None:
        return jsonify({
            'error': 'ffmpeg is not installed or not on PATH. '
                     'It is required for audio speed adjustment.'
        }), 500

    temp_files = []  # tracks every temp file for cleanup

    try:
        # --------------------------------------------------------------
        # 1. Parse the incoming request
        # --------------------------------------------------------------
        if request.content_type and 'multipart/form-data' in request.content_type:
            srt_file = request.files.get('srt_file')
            srt_content = (
                srt_file.read().decode('utf-8') if srt_file
                else request.form.get('srt', '')
            )
            voice = request.form.get('voice', None)
            ref_text = request.form.get('ref_text', None)
            ref_audio_file = request.files.get('ref_audio', None)
            speed_tolerance = float(request.form.get('speed_tolerance', 0.05))
        else:
            data = request.get_json(force=True, silent=True) or {}
            srt_content = data.get('srt', '')
            voice = data.get('voice', None)
            ref_text = data.get('ref_text', None)
            ref_audio_file = None
            speed_tolerance = float(data.get('speed_tolerance', 0.05))

        if not srt_content or not srt_content.strip():
            return jsonify({'error': 'Missing or empty SRT content.'}), 400

        # --------------------------------------------------------------
        # 2. Parse SRT
        # --------------------------------------------------------------
        entries = parse_srt(srt_content)
        if not entries:
            return jsonify({'error': 'No valid subtitle entries found in SRT.'}), 400

        logger.info(f'Parsed {len(entries)} subtitle entries from SRT')

        # --------------------------------------------------------------
        # 3. Prepare TTS engine & optional reference audio
        # --------------------------------------------------------------
        tts = get_tts_engine()

        ref_audio_path = None
        if ref_audio_file:
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
            ref_audio_file.save(tmp.name)
            ref_audio_path = tmp.name
            temp_files.append(ref_audio_path)

        # --------------------------------------------------------------
        # 4. Generate & speed-adjust each subtitle segment
        # --------------------------------------------------------------
        segment_info = []   # list of (start_ms, wav_path)
        wav_params = None   # filled from the first generated file

        for i, entry in enumerate(entries):
            logger.info(
                f"[{i+1}/{len(entries)}] Generating TTS for "
                f"[{entry['start_ms']}–{entry['end_ms']}ms] "
                f"({entry['duration_ms']}ms): "
                f"\"{entry['text'][:80]}\"{'…' if len(entry['text']) > 80 else ''}"
            )

            # -- build inference kwargs --
            infer_kwargs = {'text': entry['text']}
            if voice:
                infer_kwargs['voice'] = voice
            if ref_audio_path:
                infer_kwargs['ref_audio'] = ref_audio_path
                if ref_text:
                    infer_kwargs['ref_text'] = ref_text

            # -- run TTS --
            audio = tts.infer(**infer_kwargs)
            raw_wav = tempfile.mktemp(suffix='.wav')
            tts.save(audio, raw_wav)
            temp_files.append(raw_wav)

            # -- grab WAV params once --
            if wav_params is None:
                wav_params = get_wav_params(raw_wav)

            # -- compare durations --
            actual_ms = get_wav_duration_ms(raw_wav)
            target_ms = entry['duration_ms']
            speed_factor = actual_ms / target_ms

            logger.info(
                f"[{i+1}/{len(entries)}] actual={actual_ms}ms  "
                f"target={target_ms}ms  speed_factor={speed_factor:.3f}"
            )

            if abs(speed_factor - 1.0) > speed_tolerance:
                adjusted_wav = tempfile.mktemp(suffix='.wav')
                temp_files.append(adjusted_wav)
                direction = 'tăng tốc (speed up)' if speed_factor > 1.0 else 'giảm tốc (slow down)'
                logger.info(
                    f"[{i+1}/{len(entries)}] {direction} × {speed_factor:.3f}"
                )
                adjust_audio_speed(raw_wav, adjusted_wav, speed_factor)
                segment_info.append((entry['start_ms'], adjusted_wav))
            else:
                logger.info(f"[{i+1}/{len(entries)}] within tolerance – no adjustment")
                segment_info.append((entry['start_ms'], raw_wav))

        if not segment_info:
            return jsonify({'error': 'No audio segments were generated.'}), 500

        # --------------------------------------------------------------
        # 5. Assemble final audio (segments + silence gaps)
        # --------------------------------------------------------------
        logger.info('Assembling final audio with silence gaps…')
        segment_info.sort(key=lambda x: x[0])

        sample_rate = wav_params.framerate
        channels = wav_params.nchannels
        sampwidth = wav_params.sampwidth

        ordered_wavs = []
        current_pos_ms = 0

        for start_ms, wav_path in segment_info:
            # insert silence for the gap before this segment
            if start_ms > current_pos_ms:
                gap_ms = start_ms - current_pos_ms
                silence_path = tempfile.mktemp(suffix='.wav')
                temp_files.append(silence_path)
                create_silence_wav(silence_path, gap_ms, sample_rate,
                                   channels, sampwidth)
                ordered_wavs.append(silence_path)
                logger.info(f'Inserted {gap_ms}ms silence gap')

            ordered_wavs.append(wav_path)
            current_pos_ms = start_ms + get_wav_duration_ms(wav_path)

        # -- concatenate everything --
        output_path = tempfile.mktemp(suffix='.wav')
        temp_files.append(output_path)
        concatenate_wav_files(ordered_wavs, output_path)

        total_duration_ms = get_wav_duration_ms(output_path)
        logger.info(
            f'Final audio: {total_duration_ms}ms '
            f'({len(segment_info)} segments)'
        )

        # --------------------------------------------------------------
        # 6. Return the WAV file
        # --------------------------------------------------------------
        response = send_file(
            output_path,
            mimetype='audio/wav',
            as_attachment=True,
            download_name='tts_srt_output.wav',
        )

        @response.call_on_close
        def cleanup():
            for f in temp_files:
                try:
                    if os.path.exists(f):
                        os.unlink(f)
                except Exception:
                    pass

        return response

    except Exception as e:
        # best-effort cleanup on error
        for f in temp_files:
            try:
                if os.path.exists(f):
                    os.unlink(f)
            except Exception:
                pass
        logger.error(f'SRT TTS generation failed: {e}', exc_info=True)
        return jsonify({'error': f'SRT TTS generation failed: {str(e)}'}), 500


# ──────────────────────────────────────────────────────────────────────────────
# Startup
# ──────────────────────────────────────────────────────────────────────────────

def preload_model():
    """Pre-load the TTS engine at startup for faster first request."""
    try:
        get_tts_engine()
        logger.info("Model pre-loaded at startup.")
    except Exception as e:
        logger.warning(f"Could not pre-load model: {e}. Will load on first request.")


if __name__ == "__main__":
    port = int(os.environ.get("VIENEU_PORT", 8020))

    # Pre-load model
    preload_model()

    logger.info(f"Starting VieNeu-TTS server on port {port}...")
    app.run(host="0.0.0.0", port=port, debug=False)
