#!/bin/sh
# Installs a Personal Note launcher entry for this checkout (~/.local/share/applications).
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$dir"
sed "s|@REPO@|$repo|g" "$repo/packaging/personal-note.desktop" > "$dir/personal-note.desktop"
echo "Installed $dir/personal-note.desktop"
