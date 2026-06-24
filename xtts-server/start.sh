#!/bin/bash
# Start XTTS v2 TTS Server
# Usage: ./start.sh [port]
# Default port: 8888

PORT=${1:-8888}

echo "🎤 Starting XTTS v2 Server on port $PORT..."
echo "📁 Voices directory: $(dirname "$0")/voices"
echo "📁 Output directory: $(dirname "$0")/output"

cd "$(dirname "$0")"

# Create directories
mkdir -p voices output

# Set port via environment variable
export XTTS_PORT=$PORT

# Run server
python server.py
