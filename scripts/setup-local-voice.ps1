[CmdletBinding()]
param(
    [int]$Jobs = [Math]::Max(1, [Environment]::ProcessorCount),
    [switch]$ForceModelDownload
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$runtimeCommit = 'b00a5537c71059cf49c1d8e11609af7abd6b4b0b'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'PersonalNote\runtime'
$runtimeDir = Join-Path $runtimeRoot 'NeMo-Speech.cpp'
$vcpkgDir = Join-Path $runtimeRoot 'vcpkg'
$buildDir = Join-Path $runtimeDir 'build-cpu-http'
$modelDir = Join-Path $env:LOCALAPPDATA 'PersonalNote\models'
$modelName = 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf'
$modelPath = Join-Path $modelDir $modelName
$expectedModelBytes = 741548352

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH."
    }
}

function Import-MsvcEnvironment {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw 'Visual Studio Build Tools with the Desktop development with C++ workload is required.'
    }

    $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installationPath) {
        throw 'MSVC x64 build tools were not found.'
    }

    $vcvars = Join-Path $installationPath 'VC\Auxiliary\Build\vcvars64.bat'
    $environment = & cmd.exe /d /s /c "`"$vcvars`" >nul && set"
    foreach ($line in $environment) {
        if ($line -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
}

Assert-Command git
Assert-Command cmake
Assert-Command ninja
Assert-Command hf
Import-MsvcEnvironment

New-Item -ItemType Directory -Force -Path $runtimeRoot, $modelDir | Out-Null

if (-not (Test-Path (Join-Path $runtimeDir '.git'))) {
    git clone --filter=blob:none --recurse-submodules https://github.com/NVIDIA/NeMo-Speech.cpp.git $runtimeDir
}

git -C $runtimeDir fetch origin $runtimeCommit --depth 1
git -C $runtimeDir checkout --detach $runtimeCommit
git -C $runtimeDir submodule update --init --recursive --depth 1

if (-not (Test-Path (Join-Path $vcpkgDir '.git'))) {
    git clone --depth 1 https://github.com/microsoft/vcpkg.git $vcpkgDir
}
& (Join-Path $vcpkgDir 'bootstrap-vcpkg.bat') -disableMetrics
& (Join-Path $vcpkgDir 'vcpkg.exe') install sentencepiece:x64-windows --disable-metrics

$asrCmakePath = Join-Path $runtimeDir 'src\asr\CMakeLists.txt'
$asrCmake = Get-Content $asrCmakePath -Raw
if ($asrCmake -notmatch 'absl::flags') {
    $oldLinkLine = 'absl::flat_hash_map absl::flat_hash_set absl::strings absl::str_format absl::hash)'
    $newLinkLines = "absl::flat_hash_map absl::flat_hash_set absl::strings absl::str_format absl::hash`r`n            absl::flags)"
    if (-not $asrCmake.Contains($oldLinkLine)) {
        throw 'The pinned runtime no longer contains the expected Abseil link block.'
    }
    Set-Content -Path $asrCmakePath -Value $asrCmake.Replace($oldLinkLine, $newLinkLines) -NoNewline
}

$toolchain = Join-Path $vcpkgDir 'scripts\buildsystems\vcpkg.cmake'
cmake -S $runtimeDir -B $buildDir -G Ninja `
    -DCMAKE_BUILD_TYPE=Release `
    -DNEMO_SPEECH_GGML_PATCHED=OFF `
    -DNEMO_SPEECH_BUILD_ASR=ON `
    -DNEMO_SPEECH_BUILD_DIAR=OFF `
    -DNEMO_SPEECH_BUILD_TTS=OFF `
    -DNEMO_SPEECH_BUILD_NMT=OFF `
    -DNEMO_SPEECH_BUILD_HTTP=ON `
    -DNEMO_SPEECH_BUILD_GRPC=OFF `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    -DVCPKG_TARGET_TRIPLET=x64-windows
cmake --build $buildDir --parallel $Jobs

if ($ForceModelDownload -or -not (Test-Path $modelPath) -or (Get-Item $modelPath).Length -ne $expectedModelBytes) {
    hf download nvidia/nemotron-3.5-asr-streaming-0.6b $modelName --local-dir $modelDir
}

if ((Get-Item $modelPath).Length -ne $expectedModelBytes) {
    throw "Model size verification failed for '$modelPath'."
}

$binary = Join-Path $buildDir 'bin\nemo-speech.exe'
& $binary doctor --json
& $binary model info $modelPath --json

Write-Host "Local voice runtime is ready: $binary"
Write-Host 'Start it with: npm run voice:start'