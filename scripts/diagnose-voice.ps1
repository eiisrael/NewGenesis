[CmdletBinding()]
param()

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VoiceDir = Join-Path $ProjectRoot '.genesis\voice'
$Checks = @(
  @{ Name = 'whisper.cpp 1.8.6'; Path = (Join-Path $VoiceDir 'bin\whisper-cli.exe') },
  @{ Name = 'Silero VAD 6.2.0'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-silero-v6.2.0.bin') },
  @{ Name = 'Whisper rápido'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-base-q5_1.bin') },
  @{ Name = 'Whisper balanceado'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-small-q5_1.bin') },
  @{ Name = 'Whisper alta precisão'; Path = (Join-Path $VoiceDir 'models\whisper\ggml-medium-q5_0.bin') },
  @{ Name = 'Piper pt_BR-cadu-medium'; Path = (Join-Path $VoiceDir 'models\piper\pt_BR-cadu-medium.onnx') },
  @{ Name = 'Chatterbox pt-BR'; Path = (Join-Path $VoiceDir 'chatterbox.ready') },
  @{ Name = 'Python isolado do Piper'; Path = (Join-Path $VoiceDir 'venv-piper\Scripts\python.exe') },
  @{ Name = 'Python isolado do Chatterbox'; Path = (Join-Path $VoiceDir 'venv-chatterbox\Scripts\python.exe') }
)

Write-Host 'Diagnóstico local de voz do NewGenesis (nenhum áudio será capturado).'
$computer = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$processor = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($processor) { Write-Host "CPU: $($processor.Name) · $($processor.NumberOfCores) núcleos / $($processor.NumberOfLogicalProcessors) threads" }
if ($computer) { Write-Host ('RAM instalada: {0:N1} GB' -f ($computer.TotalPhysicalMemory / 1GB)) }
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidia) { & $nvidia.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader }
else { Write-Host 'GPU NVIDIA/CUDA: não detectada. whisper.cpp CPU permanece suportado; Vulkan exige build manual auditado.' }

foreach ($check in $Checks) {
  if (Test-Path -LiteralPath $check.Path -PathType Leaf) {
    $file = Get-Item -LiteralPath $check.Path
    Write-Host ('[OK] {0} · {1:N1} MB' -f $check.Name, ($file.Length / 1MB))
  } else { Write-Host "[--] $($check.Name)" }
}

$ram = if ($computer) { $computer.TotalPhysicalMemory / 1GB } else { 0 }
$recommendation = if ($ram -ge 24) { 'balanceado; avalie alta precisão somente após benchmark' } elseif ($ram -ge 12) { 'balanceado' } else { 'rápido' }
Write-Host "Recomendação conservadora de STT: $recommendation. A escolha final depende do benchmark no seu microfone."
Write-Host 'Execute: npm start; abra Voz; use “Testar microfone” e “Testar voz do Genesis”.'
