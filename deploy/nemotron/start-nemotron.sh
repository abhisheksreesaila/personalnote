#!/bin/sh
set -eu

model_path="${MODEL_DIR}/${MODEL_FILE}"
temporary_path="${model_path}.download"

mkdir -p "${MODEL_DIR}"

if [ "$(id -u)" -eq 0 ]; then
    chown ubuntu:ubuntu "${MODEL_DIR}"
    exec gosu ubuntu "$0" "$@"
fi

if [ ! -f "${model_path}" ] || [ "$(wc -c < "${model_path}")" -ne "${MODEL_SIZE_BYTES}" ]; then
    rm -f "${temporary_path}"
    curl --fail --location --retry 5 --retry-all-errors \
        --output "${temporary_path}" "${MODEL_URL}"

    actual_size="$(wc -c < "${temporary_path}")"
    if [ "${actual_size}" -ne "${MODEL_SIZE_BYTES}" ]; then
        echo "Nemotron model size mismatch: expected ${MODEL_SIZE_BYTES}, got ${actual_size}" >&2
        rm -f "${temporary_path}"
        exit 1
    fi

    mv "${temporary_path}" "${model_path}"
fi

exec nemo-speech serve \
    --asr-model "${model_path}" \
    --device cpu \
    --host 0.0.0.0 \
    --port "${PORT:-8080}" \
    --cors-origin "${ASR_CORS_ORIGIN}" \
    --no-ui