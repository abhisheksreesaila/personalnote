#!/bin/sh
# Builds the local voice engine (NVIDIA NeMo-Speech.cpp, ASR + loopback HTTP/WebSocket server only) at the pinned
# commit and packs it as dist-app/personal-note-voice-engine-<os>-<arch>.tar.gz (+ .sha256), the file the app's
# "Download voice" button fetches from the matching release.
#   sh scripts/build-voice-engine.sh
# Linux x86_64: CPU, built for generic x86-64 with AVX2 (not -march=native, which would tie the engine to the build
# machine's CPU and crash with SIGILL elsewhere). macOS arm64: Metal, minimum macOS 13 (MACOSX_DEPLOYMENT_TARGET). Needs git, cmake >= 3.26, ninja, a C++17 compiler (GCC 13+ on Linux).
# Environment: ENGINE_COMMIT (default: the pin below), WORK (default build/voice-engine), JOBS.
# Not part of the app bundle: the engine is a separate download, and the model is fetched from Hugging Face at
# install time, never from the release.
set -eu
cd "$(dirname "$0")/.."
ROOT="$PWD"

ENGINE_COMMIT="${ENGINE_COMMIT:-b00a5537c71059cf49c1d8e11609af7abd6b4b0b}"
SENTENCEPIECE_COMMIT=17d7580d6407802f85855d2cc9190634e2c95624 # what NeMo-Speech.cpp's own static build uses
WORK="${WORK:-$ROOT/build/voice-engine}"
SYSTEM="$(uname -s)"
MACHINE="$(uname -m)"
case "$SYSTEM-$MACHINE" in
  Linux-x86_64) KEY=linux-x86_64 ;;
  Darwin-arm64) KEY=macos-arm64 ;;
  *) echo "No voice engine is built for $SYSTEM $MACHINE (Linux x86_64 and macOS arm64 only)." >&2; exit 1 ;;
esac
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
NAME="personal-note-voice-engine-$KEY"
OUT="$ROOT/dist-app"

# Newer compilers need <cstdint> in SentencePiece's header; CMake 4 refuses its old minimum-version policy.
export CXXFLAGS="${CXXFLAGS:-} -include cstdint"
export CMAKE_POLICY_VERSION_MINIMUM=3.5
MACOS_MIN="${MACOSX_DEPLOYMENT_TARGET:-13.0}" # keep in step with LSMinimumSystemVersion in scripts/build-mac-app.sh
OSX_FLAG=""
[ "$SYSTEM" = Darwin ] && OSX_FLAG="-DCMAKE_OSX_DEPLOYMENT_TARGET=$MACOS_MIN"

mkdir -p "$WORK" "$OUT"

# 1. The engine sources, at the pinned commit.
SRC="$WORK/NeMo-Speech.cpp"
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://github.com/NVIDIA/NeMo-Speech.cpp.git
fi
git -C "$SRC" fetch -q --depth 1 origin "$ENGINE_COMMIT"
git -C "$SRC" checkout -q --detach FETCH_HEAD
git -C "$SRC" submodule update --init --depth 1 ggml third_party/cpp-httplib

# 2. SentencePiece as a static library (its bundled protobuf stays private to the engine; no Homebrew or apt dependency).
SP="$WORK/sentencepiece"
if [ ! -d "$SP/source/.git" ]; then
  git init -q "$SP/source"
  git -C "$SP/source" remote add origin https://github.com/google/sentencepiece.git
fi
git -C "$SP/source" fetch -q --depth 1 origin "$SENTENCEPIECE_COMMIT"
git -C "$SP/source" checkout -q --detach FETCH_HEAD
cmake -G Ninja -S "$SP/source" -B "$SP/build" -DCMAKE_BUILD_TYPE=Release $OSX_FLAG \
  -DSPM_BUILD_TEST=OFF -DSPM_ENABLE_SHARED=OFF -DSPM_ENABLE_TCMALLOC=OFF
cmake --build "$SP/build" --target sentencepiece-static -j "$JOBS"

# 3. The engine: speech recognition and the HTTP/WebSocket server, nothing else.
LINK_FLAGS=""
SP_STATIC=""
X86_FLAGS=""
if [ "$SYSTEM" = Linux ]; then
  # Haswell (2013) and newer: fast enough for live dictation, runs on any current PC; never AVX-512.
  X86_FLAGS="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON"
  LINK_FLAGS="-static-libstdc++ -static-libgcc" # no newer libstdc++ needed on the user's machine
  SP_STATIC="-DSENTENCEPIECE_STATIC_LIB=$SP/build/src/libsentencepiece.a" # ELF-only private-archive branch
fi
BUILD="$WORK/build"
cmake -S "$SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release $OSX_FLAG \
  -DGGML_NATIVE=OFF -DGGML_AVX512=OFF $X86_FLAGS \
  -DNEMO_SPEECH_GGML_PATCHED=OFF \
  -DNEMO_SPEECH_BUILD_ASR=ON -DNEMO_SPEECH_BUILD_DIAR=OFF -DNEMO_SPEECH_BUILD_TTS=OFF -DNEMO_SPEECH_BUILD_NMT=OFF \
  -DNEMO_SPEECH_BUILD_HTTP=ON -DNEMO_SPEECH_BUILD_GRPC=OFF \
  -DGGML_METAL="$([ "$SYSTEM" = Darwin ] && echo ON || echo OFF)" \
  $SP_STATIC \
  -DSENTENCEPIECE_LIB="$SP/build/src/libsentencepiece.a" \
  -DSENTENCEPIECE_INCLUDE_DIR="$SP/source/src" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK_FLAGS" -DCMAKE_SHARED_LINKER_FLAGS="$LINK_FLAGS"
cmake --build "$BUILD" -j "$JOBS"

# 4. Stage the install tree (bin/nemo-speech + libraries + licences) and pack it.
STAGE="$WORK/stage"
rm -rf "$STAGE"
cmake --install "$BUILD" --prefix "$STAGE"
[ -x "$STAGE/bin/nemo-speech" ] || { echo "The build did not produce bin/nemo-speech." >&2; exit 1; }
rm -rf "$STAGE/include" "$STAGE/docs" "$STAGE/config" "$STAGE/lib/cmake" "$STAGE/lib/pkgconfig" "$STAGE/share/doc"
if [ "$SYSTEM" = Linux ]; then
  GOMP="$(${CC:-cc} -print-file-name=libgomp.so.1)"
  [ -f "$GOMP" ] && mkdir -p "$STAGE/lib" && cp -L "$GOMP" "$STAGE/lib/libgomp.so.1"
fi
# The app refuses archive links, so turn every library symlink (the versioned names the binary loads included)
# into a real file. They are small.
find "$STAGE" -type l | while read -r link; do target="$(readlink -f "$link")"; rm "$link"; cp "$target" "$link"; done
[ -z "$(find "$STAGE" -type l)" ] || { echo "Links remain in the engine folder." >&2; exit 1; }

if [ "$SYSTEM" = Darwin ]; then
  # Apple Silicon only runs signed code. The linker already signs ad hoc; do it again so every file is covered.
  find "$STAGE" -type f \( -name '*.dylib' -o -perm -u+x \) -exec codesign --force --sign - {} \;
fi
printf '{"engine":"NeMo-Speech.cpp","commit":"%s","platform":"%s"}\n' "$ENGINE_COMMIT" "$KEY" > "$STAGE/engine.json"


rm -f "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" .
if command -v sha256sum >/dev/null 2>&1; then SUM="$(sha256sum "$OUT/$NAME.tar.gz")"; else SUM="$(shasum -a 256 "$OUT/$NAME.tar.gz")"; fi
printf '%s  %s\n' "${SUM%% *}" "$NAME.tar.gz" > "$OUT/$NAME.tar.gz.sha256"
# Self-check: unpack the archive we are about to ship into an empty folder and start the engine from there, the
# way the app will. A binary that cannot find its libraries fails the job here, not on a user's machine.
CHECK="$(mktemp -d)"
tar -xzf "$OUT/$NAME.tar.gz" -C "$CHECK"
(cd "$CHECK" && env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH ./bin/nemo-speech --version) \
  || { echo "The packed engine does not start from a clean folder." >&2; rm -rf "$CHECK"; exit 1; }
rm -rf "$CHECK"
echo "Built dist-app/$NAME.tar.gz"
