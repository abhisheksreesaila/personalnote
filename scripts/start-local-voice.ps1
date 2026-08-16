[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [ValidateSet('cpu')]
    [string]$Device = 'cpu'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$binary = Join-Path $env:LOCALAPPDATA 'PersonalNote\runtime\NeMo-Speech.cpp\build-cpu-http\bin\nemo-speech.exe'
$model = Join-Path $env:LOCALAPPDATA 'PersonalNote\models\nemotron-3.5-asr-streaming-0.6b.q8_0.gguf'

if (-not (Test-Path $binary) -or -not (Test-Path $model)) {
    throw 'The local voice runtime is not installed. Run npm run voice:setup first.'
}

& $binary doctor --json
if ($LASTEXITCODE -ne 0) {
    throw 'The local voice runtime failed its self-check.'
}

& $binary model info $model --json
if ($LASTEXITCODE -ne 0) {
    throw 'The local Nemotron model failed compatibility validation.'
}

Set-Location (Split-Path $binary)
& $binary serve --asr-model $model --device $Device --host 127.0.0.1 --port $Port --no-ui