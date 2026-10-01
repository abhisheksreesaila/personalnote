#!/bin/sh
# Builds "Personal Note.app" with PyInstaller. Run on a Mac from the repo root:
#   npm run desktop:mac-app
# Also builds dist-app/personal-note-macos-<arch>.zip (ditto, keeps the bundle intact), which the release workflow attaches.
# Environment: PYTHON (default .venv/bin/python), SKIP_FRONTEND=1 to reuse an existing dist/ (CI builds it first),
# APP_VERSION (default: package.json version).
# UNVERIFIED on macOS at the time of writing: check the result on a Mac.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || { echo "This script builds a macOS app; run it on a Mac." >&2; exit 1; }

PY="${PYTHON:-.venv/bin/python}"
[ -x "$PY" ] || { echo "Create the virtualenv first: python3 -m venv .venv" >&2; exit 1; }
"$PY" -m pip install -q -r requirements-build.txt

if [ "${SKIP_FRONTEND:-}" != "1" ]; then
  npm ci
  npm run build
fi
[ -f dist/index.html ] || { echo "dist/ is missing; run npm run build first." >&2; exit 1; }
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
export APP_VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}"

rm -rf build/pyinstaller dist-app
printf '%s\n' "$APP_VERSION" > app_version.txt # the app finds its voice engine on the release with this version
"$PY" -m PyInstaller desktop.py \
  --noconfirm --clean --windowed \
  --name "Personal Note" \
  --osx-bundle-identifier "app.personalnote.desktop" \
  --distpath dist-app --workpath build/pyinstaller --specpath build/pyinstaller \
  --paths . \
  --add-data "$PWD/dist:dist" \
  --add-data "$PWD/app_version.txt:." \
  --collect-all fasthtml --collect-all fastcore --collect-submodules uvicorn \
  --collect-submodules webview \
  --hidden-import routes --hidden-import services --hidden-import portability \
  --hidden-import app_schema --hidden-import note_text --hidden-import app_paths --hidden-import migration \
  --hidden-import plugin_manifest --hidden-import startup --hidden-import voice_runtime \
  --hidden-import desktop_menu --hidden-import AppKit --hidden-import Foundation --hidden-import PyObjCTools.AppHelper

# WKWebView only prompts for the microphone if the bundle says why it wants it.
"$PY" - <<'PY'
import os
import plistlib
path = "dist-app/Personal Note.app/Contents/Info.plist"
with open(path, "rb") as f:
    info = plistlib.load(f)
info["NSMicrophoneUsageDescription"] = "Personal Note uses the microphone only while you hold the voice button, to turn speech into text on this Mac. Audio is never stored."
info["NSHighResolutionCapable"] = True
info["LSMinimumSystemVersion"] = "13.0"  # the voice engine (Metal) is built for macOS 13 and newer too
info["CFBundleShortVersionString"] = os.environ["APP_VERSION"]
with open(path, "wb") as f:
    plistlib.dump(info, f)
PY

# Ad-hoc signature so macOS accepts the edited Info.plist; use a Developer ID to distribute.
codesign --force --deep --sign - "dist-app/Personal Note.app"
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] || ARCH="x86_64"
rm -f "dist-app/personal-note-macos-$ARCH.zip"
ditto -c -k --keepParent "dist-app/Personal Note.app" "dist-app/personal-note-macos-$ARCH.zip"
echo "Built dist-app/Personal Note.app and dist-app/personal-note-macos-$ARCH.zip (drag the app to /Applications). First launch: right-click > Open."
