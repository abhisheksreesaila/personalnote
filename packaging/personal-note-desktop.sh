#!/bin/sh
# Runs the desktop app from this checkout, preferring its virtualenv.
repo="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$repo/.venv/bin/python" ]; then py="$repo/.venv/bin/python"; else py="$(command -v python3 || command -v python)"; fi
exec "$py" "$repo/desktop.py" "$@"
