FROM ubuntu:24.04 AS builder

ARG NEMO_SPEECH_COMMIT=b00a5537c71059cf49c1d8e11609af7abd6b4b0b

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    g++ \
    git \
    libsentencepiece-dev \
    ninja-build \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/NVIDIA/NeMo-Speech.cpp.git /src \
    && git -C /src checkout "${NEMO_SPEECH_COMMIT}" \
    && git -C /src submodule update --init ggml third_party/cpp-httplib

RUN cmake -G Ninja -S /src -B /src/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_NATIVE=OFF \
      -DNEMO_SPEECH_GGML_PATCHED=OFF \
      -DNEMO_SPEECH_BUILD_ASR=ON \
      -DNEMO_SPEECH_BUILD_DIAR=OFF \
      -DNEMO_SPEECH_BUILD_TTS=OFF \
      -DNEMO_SPEECH_BUILD_NMT=OFF \
      -DNEMO_SPEECH_BUILD_CLI=ON \
      -DNEMO_SPEECH_BUILD_HTTP=ON \
      -DNEMO_SPEECH_BUILD_GRPC=OFF \
      -DNEMO_SPEECH_BUILD_EXAMPLES=OFF \
      -DNEMO_SPEECH_BUILD_TESTS=OFF \
      -DNEMO_SPEECH_BUILD_TOOLS=OFF \
      -DNEMO_SPEECH_WITH_FLASHLIGHT=OFF \
      -DNEMO_SPEECH_WITH_NORM=OFF \
    && cmake --build /src/build --parallel 2 \
    && cmake --install /src/build --prefix /opt/nemo-speech

FROM ubuntu:24.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gosu \
    libgomp1 \
    libsentencepiece0 \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/nemo-speech/bin:${PATH} \
    MODEL_DIR=/models \
    MODEL_FILE=nemotron-3.5-asr-streaming-0.6b.q8_0.gguf \
    MODEL_URL=https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/main/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf \
    MODEL_SIZE_BYTES=741548352 \
    ASR_CORS_ORIGIN=https://www.personalnote.app

COPY --from=builder /opt/nemo-speech /opt/nemo-speech
COPY start-nemotron.sh /usr/local/bin/start-nemotron

RUN chmod +x /usr/local/bin/start-nemotron \
    && mkdir -p /models \
    && chown ubuntu:ubuntu /models

EXPOSE 8080

ENTRYPOINT ["start-nemotron"]