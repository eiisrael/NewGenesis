[CmdletBinding()]
param()

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VoiceDir = Join-Path $ProjectRoot '.genesis\voice'
$Checks = @(
  @{ Name = 'whisper.cpp 1.8.6'; Path = (Join-Path $VoiceDir 'bin\whisper-cli.exe') },
  @{ Name = 'whisper-server persistente 1.8.6'; Path = (Join-Path $VoiceDir 'bin\whisper-server.exe') },
  @{ Name = 'Silero VAD 6.2.0'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-silero-v6.2.0.bin') },
  @{ Name = 'Whisper rápido'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-base-q5_1.bin') },
  @{ Name = 'Whisper balanceado'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-small-q5_1.bin') },
  @{ Name = 'Whisper alta precisão'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-medium-q5_0.bin') },
  @{ Name = 'Piper pt_BR-cadu-medium'; Path = (Join-Path $VoiceDir 'models\piper\pt_BR-cadu-medium.onnx') },
  @{ Name = 'Kokoro-82M 1.0'; Path = (Join-Path $VoiceDir 'models\kokoro\kokoro-v1_0.pth') },
  @{ Name = 'Kokoro pf_dora'; Path = (Join-Path $VoiceDir 'models\kokoro\voices\pf_dora.pt') },
  @{ Name = 'Kokoro pm_alex'; Path = (Join-Path $VoiceDir 'models\kokoro\voices\pm_alex.pt') },
  @{ Name = 'Kokoro pm_santa'; Path = (Join-Path $VoiceDir 'models\kokoro\voices\pm_santa.pt') },
  @{ Name = 'Chatterbox pt-BR'; Path = (Join-Path $VoiceDir 'chatterbox.ready') },
  @{ Name = 'Python isolado do Piper'; Path = (Join-Path $VoiceDir 'venv-piper\Scripts\python.exe') },
  @{ Name = 'Python isolado do Kokoro'; Path = (Join-Path $VoiceDir 'venv-kokoro\Scripts\python.exe') },
  @{ Name = 'Python isolado do Chatterbox'; Path = (Join-Path $VoiceDir 'venv-chatterbox\Scripts\python.exe') }
)

Write-Host 'Diagnóstico local de voz do NewGenesis (nenhum áudio será capturado).'
$processorName = try { (Get-ItemProperty -LiteralPath 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -ErrorAction Stop).ProcessorNameString.Trim() } catch { $env:PROCESSOR_IDENTIFIER }
$logicalProcessors = [Environment]::ProcessorCount
Write-Host "CPU: $processorName · $logicalProcessors threads disponíveis"
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidia) { & $nvidia.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader }
else {
  Write-Host 'GPU NVIDIA/CUDA: não detectada.'
  Write-Host 'O binário oficial instalado do whisper.cpp é CPU. Vulkan exige build separado e benchmark antes de ser promovido.'
}

foreach ($check in $Checks) {
  if (Test-Path -LiteralPath $check.Path -PathType Leaf) {
    $file = Get-Item -LiteralPath $check.Path
    Write-Host ('[OK] {0} · {1:N1} MB' -f $check.Name, ($file.Length / 1MB))
  } else { Write-Host "[--] $($check.Name)" }
}

$recommendation = if ($logicalProcessors -le 4) { 'rápido' } elseif ($logicalProcessors -le 8) { 'rápido ou balanceado, conforme o benchmark' } else { 'balanceado; avalie alta precisão somente após benchmark' }
Write-Host "Recomendação conservadora de STT: $recommendation. A escolha final depende do benchmark no seu microfone."
Write-Host 'Kokoro e Piper usam workers persistentes; whisper-server mantém o modelo STT carregado. O primeiro uso inclui aquecimento.'
Write-Host 'Execute: npm start; abra Voz; use “Testar microfone” e “Testar voz do Genesis”. Essas ações pedem permissão ao usuário.'
