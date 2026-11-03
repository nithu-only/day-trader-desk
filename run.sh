#!/bin/bash
# Day Trader Desk - start script
set -e

# Run from wherever this script lives, so ./run.sh works from any directory.
cd "$(dirname "$0")"

# Load .env if present (set -a so values with spaces survive).
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# python3 is not always on PATH (notably on Windows); fall back to python.
PY=python3
command -v python3 >/dev/null 2>&1 || PY=python

# Install Python dependencies if needed
if ! "$PY" -c "import fastapi" 2>/dev/null; then
  echo "Installing Python dependencies..."
  "$PY" -m pip install "fastapi" "uvicorn[standard]"
fi

# Start the app
echo "Starting Day Trader Desk (mode: ${DESK_MODE:-saved setting, demo by default})..."
echo "Open http://127.0.0.1:8000"
cd backend
exec "$PY" main.py
