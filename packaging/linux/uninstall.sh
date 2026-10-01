#!/bin/sh
# Removes the app and its menu entry. Your notes (~/.local/share/personal-note) are kept.
set -eu
prefix="${PERSONAL_NOTE_PREFIX:-$HOME/.local/opt/personal-note}"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
rm -rf "$prefix"
rm -f "$apps/personal-note.desktop"
echo "Removed Personal Note. Your notes in ${XDG_DATA_HOME:-$HOME/.local/share}/personal-note were kept."
