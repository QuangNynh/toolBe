import sys
import os
import subprocess
from pathlib import Path

def generate_speech(text: str, output_file: str):
    """Generate speech using Piper TTS"""
    
    # Model path
    model_path = Path.home() / ".local" / "share" / "piper" / "en_US-lessac-medium.onnx"
    
    if not model_path.exists():
        raise Exception(f"Model not found at {model_path}. Please download it first.")
    
    try:
        # Run piper command
        process = subprocess.run(
            ['piper', '--model', str(model_path), '--output_file', output_file],
            input=text,
            text=True,
            capture_output=True,
            check=True
        )
        
        if not os.path.exists(output_file):
            raise Exception("Output file was not created")
            
    except FileNotFoundError:
        raise Exception("Piper TTS not installed. Install with: pip install piper-tts")
    except subprocess.CalledProcessError as e:
        raise Exception(f"Piper failed: {e.stderr}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Error: Text and output file required", file=sys.stderr)
        sys.exit(1)
    
    text = sys.argv[1]
    output_file = sys.argv[2]
    
    try:
        generate_speech(text, output_file)
        print(f"Generated: {output_file}", file=sys.stderr)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)
