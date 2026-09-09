[CmdletBinding()]
param()

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VoiceDir = Join-Path $ProjectRoot '.genesis\voice'
. (Join-Path $PSScriptRoot 'voice\python-runtime.ps1')
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
$vcRuntime = Join-Path $env:WINDIR 'System32\msvcp140.dll'
$vcVersion = if (Test-Path -LiteralPath $vcRuntime -PathType Leaf) { (Get-Item -LiteralPath $vcRuntime).VersionInfo } else { $null }
if ($vcVersion -and ($vcVersion.FileMajorPart -gt 14 -or ($vcVersion.FileMajorPart -eq 14 -and $vcVersion.FileMinorPart -ge 40))) {
  Write-Host "[OK] Visual C++ x64 · $($vcVersion.FileVersion)"
} else {
  Write-Host '[FALHA] Visual C++ x64 ausente ou anterior a 14.40; o ONNX Runtime do Piper pode falhar ao carregar uma DLL.'
  Write-Host 'Instale o redistribuível x64 oficial: https://aka.ms/vc14/vc_redist.x64.exe e reinicie o Genesis.'
}
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($nvidia) { & $nvidia.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader }
else {
  Write-Host 'GPU NVIDIA/CUDA: não detectada.'
  Write-Host 'O binário oficial instalado do whisper.cpp é CPU. Vulkan exige build separado e benchmark antes de ser promovido.'
}

foreach ($check in $Checks) {
  if (Test-Path -LiteralPath $check.Path -PathType Leaf) {
    $file = Get-Item -LiteralPath $check.Path
    if ($check.Name.StartsWith('Python isolado')) {
      $info = Get-VoicePythonInfo $check.Path -RequirePip
      if ($info.Available) { Write-Host "[OK] $($check.Name) · Python $($info.Version), pip operacional" }
      else {
        Write-Host "[FALHA] $($check.Name) · $($info.Error)"
        Write-Host 'Reexecute scripts/setup-voice.ps1 com -Component correspondente, -PythonExecutable apontando para Python válido e -AcceptDownload. O ambiente anterior será preservado em backup.'
      }
    } else { Write-Host ('[OK] {0} · {1:N1} MB' -f $check.Name, ($file.Length / 1MB)) }
  } else { Write-Host "[--] $($check.Name)" }
}

$recommendation = if ($logicalProcessors -le 4) { 'rápido' } elseif ($logicalProcessors -le 8) { 'rápido ou balanceado, conforme o benchmark' } else { 'balanceado; avalie alta precisão somente após benchmark' }
Write-Host "Recomendação conservadora de STT: $recommendation. A escolha final depende do benchmark no seu microfone."
Write-Host 'Kokoro e Piper usam workers persistentes; whisper-server mantém o modelo STT carregado. O primeiro uso inclui aquecimento.'
Write-Host 'Execute: npm start; abra Voz; use “Testar microfone” e “Testar voz do Genesis”. Essas ações pedem permissão ao usuário.'
