#!/bin/sh
# Builds the Linux release bundle: dist-app/personal-note-linux-<arch>.tar.gz
#   npm run desktop:linux-bundle
# The bundle is a PyInstaller one-folder app (server + built frontend + launcher) with install.sh and
# uninstall.sh beside it. It needs no repo, npm or virtualenv at run time, only a system Chromium or Chrome.
# Environment: PYTHON (default .venv/bin/python), SKIP_FRONTEND=1 to reuse an existing dist/ (CI builds it first).
set -eu
cd "$(dirname "$0")/.."

[ "$(uname)" = "Linux" ] || { echo "This script builds a Linux bundle; run it on Linux." >&2; exit 1; }

PY="${PYTHON:-.venv/bin/python}"
"$PY" -c "import PyInstaller" 2>/dev/null || { echo "Install the build tools first: $PY -m pip install -r requirements.txt pyinstaller" >&2; exit 1; }

if [ "${SKIP_FRONTEND:-}" != "1" ]; then
  npm ci
  npm run build
fi
[ -f dist/index.html ] || { echo "dist/ is missing; run npm run build first." >&2; exit 1; }

# The app looks for its voice engine on the release with this version (empty or 0.0.0 in a checkout).
APP_VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}"
printf '%s\n' "$APP_VERSION" > app_version.txt

ARCH="$(uname -m)"
NAME="personal-note-linux-$ARCH"
rm -rf build/pyinstaller dist-app/personal-note "dist-app/$NAME" "dist-app/$NAME.tar.gz"

# No pywebview here: it needs system GTK libraries. The window is Chromium's app mode (chromium_app.py).
"$PY" -m PyInstaller desktop.py \
  --noconfirm --clean \
  --name personal-note \
  --distpath dist-app --workpath build/pyinstaller --specpath build/pyinstaller \
  --paths . \
  --add-data "$PWD/dist:dist" \
  --add-data "$PWD/app_version.txt:." \
  --collect-all fasthtml --collect-all fastcore --collect-submodules uvicorn \
  --exclude-module webview \
  --hidden-import routes --hidden-import services --hidden-import portability \
  --hidden-import app_schema --hidden-import note_text --hidden-import app_paths --hidden-import migration \
  --hidden-import document_model --hidden-import json_canvas --hidden-import media_store --hidden-import vault \
  --hidden-import plugin_manifest --hidden-import startup --hidden-import voice_runtime --hidden-import chromium_app --hidden-import desktop_menu

STAGE="dist-app/$NAME"
mkdir -p "$STAGE"
mv dist-app/personal-note "$STAGE/personal-note"
cp public/favicon.svg "$STAGE/personal-note/personal-note.svg"
cp packaging/linux/install.sh packaging/linux/uninstall.sh packaging/linux/personal-note.desktop.in "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"
tar -C dist-app -czf "dist-app/$NAME.tar.gz" "$NAME"
echo "Built dist-app/$NAME.tar.gz"
