[CmdletBinding()]
param(
  [ValidateSet('whisper', 'piper', 'chatterbox', 'all')]
  [string]$Component = 'whisper',
  [ValidateSet('rapid', 'balanced', 'accurate')]
  [string]$Profile = 'balanced',
  [ValidateSet('cpu', 'cuda128')]
  [string]$TorchBackend = 'cpu',
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
  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($launcher) {
    foreach ($version in $Versions) {
      & $launcher.Source $version -c 'import sys' 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return @{ Command = $launcher.Source; Prefix = @($version) } }
    }
  }
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($python) {
    $detected = (& $python.Source -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>$null | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -eq 0 -and $detected -in $accepted) { return @{ Command = $python.Source; Prefix = @() } }
  }
  throw "Nenhum Python compatível foi encontrado. Versões aceitas para este componente: $($accepted -join ', ')."
}

function Ensure-Venv([ValidateSet('piper', 'chatterbox')][string]$Kind) {
  $venvDir = Join-Path $VoiceDir "venv-$Kind"
  $pythonPath = Join-Path $venvDir 'Scripts\python.exe'
  if (Test-Path -LiteralPath $pythonPath) { return $pythonPath }
  $versions = if ($Kind -eq 'chatterbox') { @('-3.11', '-3.10') } else { @('-3.14', '-3.13', '-3.12', '-3.11', '-3.10') }
  $python = Find-Python $versions
  & $python.Command @($python.Prefix) -m venv $venvDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonPath)) { throw 'Falha ao criar o ambiente virtual isolado.' }
  & $pythonPath -m pip install --disable-pip-version-check --upgrade pip | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar o pip no ambiente virtual isolado.' }
  return $pythonPath
}

function Write-Manifest {
  $manifest = @{
    schemaVersion = 1
    whisper = @{
      version = '1.8.6'; binary = 'bin/whisper-cli.exe'; vadModel = 'models/whisper/ggml-silero-v6.2.0.bin'
      profiles = @{
        rapid = @{ model = 'models/whisper/ggml-base-q5_1.bin'; downloadBytes = 59721011 }
        balanced = @{ model = 'models/whisper/ggml-small-q5_1.bin'; downloadBytes = 190085487 }
        accurate = @{ model = 'models/whisper/ggml-medium-q5_0.bin'; downloadBytes = 539212467 }
      }
    }
    chatterbox = @{ version = 'v3-pt-br'; python = 'venv-chatterbox/Scripts/python.exe'; model = 'ResembleAI/Chatterbox-Multilingual-pt-br'; source = 'chatterbox-space/chatterbox/src'; readyMarker = 'chatterbox.ready'; hfHome = 'hf-cache' }
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
  Write-Host 'Runtime e modelos opcionais removidos de .genesis\voice. O core e o fallback do navegador permanecem intactos.'
  return
}

$profileBytes = $WhisperProfiles[$Profile].Bytes + 4093849 + 885098
Write-Host "Plano solicitado: componente=$Component; perfil=$Profile."
if ($Component -in @('whisper', 'all')) { Write-Host ("Whisper + Silero: {0:N1} MB." -f ($profileBytes / 1MB)) }
if ($Component -in @('piper', 'all')) { Write-Host 'Piper: modelo pt_BR-cadu-medium de 62.950.044 bytes, além dos wheels do engine.' }
if ($Component -in @('chatterbox', 'all')) { Write-Host 'Chatterbox pt-BR: 3.200.893.990 bytes em pesos principais, além do PyTorch e dependências.' }
if (-not $AcceptDownload) {
  Write-Host 'Nada foi baixado. Revise os tamanhos e repita com -AcceptDownload. Para Chatterbox, acrescente -AcceptLargeDownload.'
  return
}

New-Item -ItemType Directory -Force -Path $VoiceDir | Out-Null
if ($Component -in @('whisper', 'all')) { Install-Whisper }
if ($Component -in @('piper', 'all')) { Install-Piper }
if ($Component -in @('chatterbox', 'all')) { Install-Chatterbox }
Write-Manifest
Write-Host 'Instalação concluída. Reinicie o NewGenesis e execute scripts\diagnose-voice.ps1.'
