#!/usr/bin/env bash
# Sets up local dictation for the desk panel: whisper.cpp and ffmpeg from
# Homebrew, and the base English model (~150 MB) in ~/.config/claude-panel/.
# Speech is transcribed on this Mac only.
set -euo pipefail

MODEL_DIR="$HOME/.config/claude-panel"
MODEL="$MODEL_DIR/ggml-base.en.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

command -v brew >/dev/null || { echo "Homebrew is needed: https://brew.sh"; exit 1; }

echo "Installing whisper.cpp and ffmpeg…"
brew install whisper-cpp ffmpeg

mkdir -p "$MODEL_DIR"
chmod 700 "$MODEL_DIR"
if [ -s "$MODEL" ]; then
  echo "Model already present: $MODEL"
else
  echo "Downloading the model to ${MODEL}…"
  curl -fL --progress-bar -o "$MODEL.part" "$MODEL_URL"
  mv "$MODEL.part" "$MODEL"
fi

command -v whisper-cli >/dev/null || { echo "whisper-cli is not on PATH after install; check 'brew info whisper-cpp'"; exit 1; }
echo "Dictation is ready. Restart the Mac service if it is running."
