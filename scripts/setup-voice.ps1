[CmdletBinding()]
param(
  [ValidateSet('whisper', 'piper', 'kokoro', 'chatterbox', 'all')]
  [string]$Component = 'whisper',
  [ValidateSet('rapid', 'balanced', 'accurate')]
  [string]$Profile = 'balanced',
  [ValidateSet('cpu', 'cuda128')]
  [string]$TorchBackend = 'cpu',
  [Alias('PythonPath')]
  [string]$PythonExecutable = '',
  [switch]$AcceptDownload,
  [switch]$AcceptLargeDownload,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VoiceDir = Join-Path $ProjectRoot '.genesis\voice'
$ModelDir = Join-Path $VoiceDir 'models\whisper'
$BinDir = Join-Path $VoiceDir 'bin'

$WhisperProfiles = @{
  rapid = @{ File = 'ggml-base-q5_1.bin'; Bytes = 59721011; Sha256 = '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' }
  balanced = @{ File = 'ggml-small-q5_1.bin'; Bytes = 190085487; Sha256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' }
  accurate = @{ File = 'ggml-medium-q5_0.bin'; Bytes = 539212467; Sha256 = '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f' }
}

function Assert-VoiceTarget {
  $resolvedRoot = [IO.Path]::GetFullPath($ProjectRoot)
  $resolvedVoice = [IO.Path]::GetFullPath($VoiceDir)
  if (-not $resolvedVoice.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedVoice -Leaf) -ne 'voice') {
    throw "Diretório de voz inseguro: $resolvedVoice"
  }
}

function Download-Verified([string]$Uri, [string]$Destination, [string]$Sha256) {
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (Test-Path -LiteralPath $Destination) {
    $current = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($current -eq $Sha256) { Write-Host "Já verificado: $Destination"; return }
    throw "Arquivo existente possui SHA-256 inesperado: $Destination"
  }
  $partial = "$Destination.download"
  Invoke-WebRequest -Uri $Uri -OutFile $partial -UseBasicParsing
  $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { Remove-Item -LiteralPath $partial -Force; throw "SHA-256 inválido para $Uri" }
  Move-Item -LiteralPath $partial -Destination $Destination
}

function Find-Python([string[]]$Versions) {
  $accepted = $Versions | ForEach-Object { $_.TrimStart('-') }
  if ($PythonExecutable) {
    $explicit = [IO.Path]::GetFullPath($PythonExecutable)
    if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { throw "Python explícito não encontrado: $explicit" }
    $detected = (& $explicit -c 'import sys;print(sys.version_info[0],sys.version_info[1],sep=chr(46))' 2>$null | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -eq 0 -and $detected -in $accepted) { return @{ Command = $explicit; Prefix = @() } }
    throw "Python explícito incompatível ($detected). Versões aceitas: $($accepted -join ', ')."
  }
  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($launcher) {
    foreach ($version in $Versions) {
      & $launcher.Source $version -c 'import sys' 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return @{ Command = $launcher.Source; Prefix = @($version) } }
    }
  }
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($python) {
    $detected = (& $python.Source -c 'import sys;print(sys.version_info[0],sys.version_info[1],sep=chr(46))' 2>$null | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -eq 0 -and $detected -in $accepted) { return @{ Command = $python.Source; Prefix = @() } }
  }
  throw "Nenhum Python compatível foi encontrado. Versões aceitas para este componente: $($accepted -join ', ')."
}

function Ensure-Venv([ValidateSet('piper', 'kokoro', 'chatterbox')][string]$Kind) {
  $venvDir = Join-Path $VoiceDir "venv-$Kind"
  $venvPython = Join-Path $venvDir 'Scripts\python.exe'
  if (Test-Path -LiteralPath $venvPython) { return $venvPython }
  $versions = if ($Kind -in @('chatterbox', 'kokoro')) { @('-3.12', '-3.11', '-3.10') } else { @('-3.14', '-3.13', '-3.12', '-3.11', '-3.10') }
  $python = Find-Python $versions
  & $python.Command @($python.Prefix) -m venv $venvDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) { throw 'Falha ao criar o ambiente virtual isolado.' }
  & $venvPython -m pip install --disable-pip-version-check --upgrade pip | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar o pip no ambiente virtual isolado.' }
  return $venvPython
}

function Write-Manifest {
  $manifest = @{
    schemaVersion = 1
    whisper = @{
      version = '1.8.6'; binary = 'bin/whisper-cli.exe'; serverBinary = 'bin/whisper-server.exe'; vadModel = 'models/whisper/ggml-silero-v6.2.0.bin'
      profiles = @{
        rapid = @{ model = 'models/whisper/ggml-base-q5_1.bin'; downloadBytes = 59721011 }
        balanced = @{ model = 'models/whisper/ggml-small-q5_1.bin'; downloadBytes = 190085487 }
        accurate = @{ model = 'models/whisper/ggml-medium-q5_0.bin'; downloadBytes = 539212467 }
      }
    }
    chatterbox = @{ version = 'v3-pt-br'; python = 'venv-chatterbox/Scripts/python.exe'; model = 'ResembleAI/Chatterbox-Multilingual-pt-br'; source = 'chatterbox-space/chatterbox/src'; readyMarker = 'chatterbox.ready'; hfHome = 'hf-cache' }
    kokoro = @{ version = '1.0'; python = 'venv-kokoro/Scripts/python.exe'; modelId = 'hexgrad/Kokoro-82M'; model = 'models/kokoro/kokoro-v1_0.pth'; config = 'models/kokoro/config.json'; voices = 'models/kokoro/voices'; voiceNames = @('pf_dora', 'pm_alex', 'pm_santa') }
    piper = @{ version = '1.4.2'; python = 'venv-piper/Scripts/python.exe'; voice = 'pt_BR-cadu-medium'; model = 'models/piper/pt_BR-cadu-medium.onnx'; config = 'models/piper/pt_BR-cadu-medium.onnx.json' }
  }
  $json = $manifest | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path $VoiceDir 'voice-manifest.json'), $json, [Text.UTF8Encoding]::new($false))
}

function Install-Whisper {
  $binaryZip = Join-Path $VoiceDir 'downloads\whisper-bin-x64-v1.8.6.zip'
  Download-Verified 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip' $binaryZip 'b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822'
  $extractDir = Join-Path $VoiceDir 'extract-whisper-v1.8.6'
  if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
  Expand-Archive -LiteralPath $binaryZip -DestinationPath $extractDir
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Get-ChildItem -LiteralPath $extractDir -Recurse -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BinDir $_.Name) -Force }
  Remove-Item -LiteralPath $extractDir -Recurse -Force

  $selected = $WhisperProfiles[$Profile]
  Download-Verified "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$($selected.File)" (Join-Path $ModelDir $selected.File) $selected.Sha256
  Download-Verified 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin' (Join-Path $ModelDir 'ggml-silero-v6.2.0.bin') '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'
}

function Install-Piper {
  $python = Ensure-Venv 'piper'
  & $python -m pip install --disable-pip-version-check 'piper-tts==1.4.2'
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar Piper 1.4.2.' }
  $piperDir = Join-Path $VoiceDir 'models\piper'
  Download-Verified 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/cadu/medium/pt_BR-cadu-medium.onnx' (Join-Path $piperDir 'pt_BR-cadu-medium.onnx') '765f0809a6ea9035d4a6d0d008dbf8876e68b2dd32029312672fa8f405bdb535'
  $configPath = Join-Path $piperDir 'pt_BR-cadu-medium.onnx.json'
  if (-not (Test-Path -LiteralPath $configPath)) { Invoke-WebRequest -Uri 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/cadu/medium/pt_BR-cadu-medium.onnx.json' -OutFile $configPath -UseBasicParsing }
}

function Install-Kokoro {
  if (-not $AcceptLargeDownload) { throw 'Kokoro requer 328.782.506 bytes de modelo/vozes, além do PyTorch e dependências. Repita com -AcceptLargeDownload.' }
  $python = Ensure-Venv 'kokoro'
  & $python -m pip install --disable-pip-version-check --index-url 'https://download.pytorch.org/whl/cpu' 'torch==2.8.0'
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar PyTorch CPU isolado para Kokoro.' }
  & $python -m pip install --disable-pip-version-check 'kokoro==0.7.16' 'misaki[en]==0.7.16' 'soundfile==0.13.1'
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar Kokoro 0.7.16 e dependências pt-BR.' }
  $kokoroDir = Join-Path $VoiceDir 'models\kokoro'
  Download-Verified 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v1_0.pth' (Join-Path $kokoroDir 'kokoro-v1_0.pth') '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4'
  Download-Verified 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/config.json' (Join-Path $kokoroDir 'config.json') '5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f'
  $kokoroVoicesDir = Join-Path $kokoroDir 'voices'
  Download-Verified 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices/pf_dora.pt' (Join-Path $kokoroVoicesDir 'pf_dora.pt') '07e4ff987c5d5a8c3995efd15cc4f0db7c4c15e881b198d8ab7f67ecf51f5eb7'
  Download-Verified 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices/pm_alex.pt' (Join-Path $kokoroVoicesDir 'pm_alex.pt') 'cf0ba8c573c2480fc54123683a35cf1e2ae130428e441eb91f9149bdb188a526'
  Download-Verified 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices/pm_santa.pt' (Join-Path $kokoroVoicesDir 'pm_santa.pt') 'd42103169c5c872abbafb9129133af7e942bb9d272c3cc3b95c203e7d7198c29'
}

function Install-Chatterbox {
  if (-not $AcceptLargeDownload) { throw 'Chatterbox requer pelo menos 3,21 GB em pesos, além do PyTorch. Repita com -AcceptLargeDownload.' }
  $python = Ensure-Venv 'chatterbox'
  if ($TorchBackend -eq 'cuda128') {
    & $python -m pip install --disable-pip-version-check --extra-index-url 'https://download.pytorch.org/whl/cu128' 'torch==2.8.0' 'torchaudio==2.8.0'
  } else {
    & $python -m pip install --disable-pip-version-check --index-url 'https://download.pytorch.org/whl/cpu' 'torch==2.8.0' 'torchaudio==2.8.0'
  }
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar PyTorch isolado.' }
  & $python -m pip install --disable-pip-version-check 'huggingface-hub==0.36.0' 'numpy==1.26.0' 'resampy==0.4.3' 'librosa==0.10.0' 's3tokenizer' 'transformers==4.46.3' 'diffusers==0.29.0' 'omegaconf==2.3.0' 'resemble-perth==1.0.1' 'silero-vad==5.1.2' 'conformer==0.3.2' 'safetensors'
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar as dependências isoladas do Chatterbox.' }
  & $python (Join-Path $PSScriptRoot 'voice\prepare-chatterbox-assets.py') --voice-dir $VoiceDir
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar ou verificar os assets oficiais do Chatterbox pt-BR.' }
}

Assert-VoiceTarget
if ($Remove) {
  if (Test-Path -LiteralPath $VoiceDir) { Remove-Item -LiteralPath $VoiceDir -Recurse -Force }
  Write-Host 'Runtime e modelos opcionais removidos de .genesis\voice. O core permanece intacto.'
  return
}

$profileBytes = $WhisperProfiles[$Profile].Bytes + 4093849 + 885098
Write-Host "Plano solicitado: componente=$Component; perfil=$Profile."
if ($Component -in @('whisper', 'all')) { Write-Host ("Whisper + Silero: {0:N1} MB." -f ($profileBytes / 1MB)) }
if ($Component -in @('piper', 'all')) { Write-Host 'Piper: modelo pt_BR-cadu-medium de 62.950.044 bytes, além dos wheels do engine.' }
if ($Component -in @('kokoro', 'all')) { Write-Host 'Kokoro-82M: 327.212.226 bytes de pesos + 1.570.280 bytes em três vozes pt-BR + runtime Python/PyTorch (pode superar 1 GB instalado).' }
if ($Component -in @('chatterbox', 'all')) { Write-Host 'Chatterbox pt-BR: 3.200.893.990 bytes em pesos principais, além do PyTorch e dependências.' }
if (-not $AcceptDownload) {
  Write-Host 'Nada foi baixado. Revise os tamanhos e repita com -AcceptDownload. Para Kokoro ou Chatterbox, acrescente -AcceptLargeDownload.'
  return
}

New-Item -ItemType Directory -Force -Path $VoiceDir | Out-Null
if ($Component -in @('whisper', 'all')) { Install-Whisper }
if ($Component -in @('piper', 'all')) { Install-Piper }
if ($Component -in @('kokoro', 'all')) { Install-Kokoro }
if ($Component -in @('chatterbox', 'all')) { Install-Chatterbox }
Write-Manifest
Write-Host 'Instalação concluída. Reinicie o NewGenesis e execute scripts\diagnose-voice.ps1.'
