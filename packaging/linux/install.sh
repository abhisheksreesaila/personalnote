#!/bin/sh
# Installs Personal Note for the current user: ~/.local/opt/personal-note plus a menu entry.
# Run it from the unpacked folder: ./install.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
prefix="${PERSONAL_NOTE_PREFIX:-$HOME/.local/opt/personal-note}"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

[ -x "$here/personal-note/personal-note" ] || { echo "Run this from the unpacked Personal Note folder." >&2; exit 1; }

mkdir -p "$(dirname "$prefix")" "$apps"
rm -rf "$prefix.new"
cp -R "$here/personal-note" "$prefix.new"
rm -rf "$prefix"
mv "$prefix.new" "$prefix"
sed "s|@PREFIX@|$prefix|g" "$here/personal-note.desktop.in" > "$apps/personal-note.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true

echo "Installed to $prefix"
echo "Start it from the application menu (Personal Note) or run $prefix/personal-note"
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 \
   && ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
  echo "Note: Personal Note opens in Chromium or Google Chrome, which was not found. Install one first." >&2
fi
echo "Your notes live in ${XDG_DATA_HOME:-$HOME/.local/share}/personal-note and are not touched by install or uninstall."
