#!/bin/sh
# Builds "Personal Note.app" with PyInstaller. Run on a Mac from the repo root:
#   npm run desktop:mac-app
# UNVERIFIED on macOS at the time of writing: check the result on a Mac.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || { echo "This script builds a macOS app; run it on a Mac." >&2; exit 1; }

PY=".venv/bin/python"
[ -x "$PY" ] || { echo "Create the virtualenv first: python3 -m venv .venv" >&2; exit 1; }
"$PY" -m pip install -q -r requirements-build.txt

npm install
npm run build

rm -rf build/pyinstaller dist-app
"$PY" -m PyInstaller desktop.py \
  --noconfirm --clean --windowed \
  --name "Personal Note" \
  --osx-bundle-identifier "app.personalnote.desktop" \
  --distpath dist-app --workpath build/pyinstaller --specpath build/pyinstaller \
  --paths . \
  --add-data "$PWD/dist:dist" \
  --collect-all fasthtml --collect-all fastcore --collect-submodules uvicorn \
  --collect-submodules webview \
  --hidden-import routes --hidden-import services --hidden-import portability \
  --hidden-import app_schema --hidden-import note_text --hidden-import app_paths \
  --hidden-import plugin_manifest --hidden-import startup

# WKWebView only prompts for the microphone if the bundle says why it wants it.
"$PY" - <<'PY'
import plistlib
path = "dist-app/Personal Note.app/Contents/Info.plist"
with open(path, "rb") as f:
    info = plistlib.load(f)
info["NSMicrophoneUsageDescription"] = "Personal Note uses the microphone only while you hold the voice button, to turn speech into text on this Mac. Audio is never stored."
info["NSHighResolutionCapable"] = True
info["CFBundleShortVersionString"] = "1.0"
with open(path, "wb") as f:
    plistlib.dump(info, f)
PY

# Ad-hoc signature so macOS accepts the edited Info.plist; use a Developer ID to distribute.
codesign --force --deep --sign - "dist-app/Personal Note.app"
echo "Built dist-app/Personal Note.app (drag it to /Applications). First launch: right-click > Open."
