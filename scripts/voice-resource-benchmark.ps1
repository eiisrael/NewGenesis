[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:7331')

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$uri = [Uri]$BaseUrl
if ($uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
  throw 'O benchmark de recursos aceita somente uma URL HTTP de loopback.'
}
$listener = Get-NetTCPConnection -State Listen -LocalPort $uri.Port -ErrorAction Stop | Select-Object -First 1
if (-not $listener) { throw "NewGenesis não está escutando em $BaseUrl." }
$serverProcessId = $listener.OwningProcess
$node = (Get-Command node.exe -ErrorAction Stop).Source

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.WorkingDirectory = $ProjectRoot
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$benchmarkScript = Join-Path $ProjectRoot 'scripts\voice-loopback-benchmark.mjs'
$startInfo.Arguments = ('"{0}" "{1}"' -f $benchmarkScript.Replace('"', '\"'), $BaseUrl)
$benchmark = [Diagnostics.Process]::new()
$benchmark.StartInfo = $startInfo
if (-not $benchmark.Start()) { throw 'Não foi possível iniciar o benchmark de loopback.' }
$stdoutTask = $benchmark.StandardOutput.ReadToEndAsync()
$stderrTask = $benchmark.StandardError.ReadToEndAsync()
$samples = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()

function Measure-NativeChildren {
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $directIds = @($allProcesses | Where-Object { $_.ParentProcessId -eq $serverProcessId } | ForEach-Object { $_.ProcessId })
  $children = $allProcesses | Where-Object { $_.ProcessId -in $directIds -or $_.ParentProcessId -in $directIds }
  foreach ($child in $children) {
    $kind = if ($child.Name -like 'whisper-cli*') { 'whisper.cpp' } elseif ($child.Name -like 'python*' -or $child.Name -like 'piper*') { 'piper' } else { continue }
    try { $process = Get-Process -Id $child.ProcessId -ErrorAction Stop } catch { continue }
    $key = "$kind/$($child.ProcessId)"
    if (-not $samples.ContainsKey($key)) {
      $samples[$key] = @{ Kind = $kind; Name = $child.Name; Pid = $child.ProcessId; FirstMs = $clock.Elapsed.TotalMilliseconds; LastMs = $clock.Elapsed.TotalMilliseconds; PeakWorkingSetBytes = 0; LastCpuSeconds = 0 }
    }
    $sample = $samples[$key]
    $sample.LastMs = $clock.Elapsed.TotalMilliseconds
    $sample.PeakWorkingSetBytes = [Math]::Max($sample.PeakWorkingSetBytes, $process.WorkingSet64)
    $cpuValue = if ($null -eq $process.CPU) { 0 } else { [double]$process.CPU }
    $sample.LastCpuSeconds = [Math]::Max($sample.LastCpuSeconds, $cpuValue)
  }
}

do {
  Measure-NativeChildren
} while (-not $benchmark.WaitForExit(100))
Measure-NativeChildren
$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result
if ($benchmark.ExitCode -ne 0) { throw "Benchmark falhou: $stderr" }
Write-Output $stdout.TrimEnd()

$logicalProcessors = [Environment]::ProcessorCount
$resources = $samples.Values | Group-Object { $_['Kind'] } | ForEach-Object {
  $wallSeconds = ($_.Group | ForEach-Object { [Math]::Max(0.1, ($_['LastMs'] - $_['FirstMs'] + 100) / 1000) } | Measure-Object -Sum).Sum
  $cpuSeconds = ($_.Group | ForEach-Object { $_['LastCpuSeconds'] } | Measure-Object -Sum).Sum
  [ordered]@{
    engine = $_.Name
    processNames = @($_.Group | ForEach-Object { $_['Name'] } | Sort-Object -Unique)
    processCount = $_.Count
    peakWorkingSetBytes = ($_.Group | ForEach-Object { $_['PeakWorkingSetBytes'] } | Measure-Object -Maximum).Maximum
    cpuSeconds = [Math]::Round($cpuSeconds, 3)
    observedProcessSeconds = [Math]::Round($wallSeconds, 3)
    averageCpuPercentOfMachine = if ($wallSeconds) { [Math]::Round(($cpuSeconds / $wallSeconds) * 100 / $logicalProcessors, 1) } else { $null }
  }
}
Write-Output ([ordered]@{
  kind = 'sampled-native-resources'
  warning = 'Amostragem a cada 100 ms. Working set é o pico observado do processo nativo; CPU é média aproximada da máquina durante a vida observada dos processos.'
  serverPid = $serverProcessId
  logicalProcessors = $logicalProcessors
  resources = @($resources)
} | ConvertTo-Json -Depth 5)
