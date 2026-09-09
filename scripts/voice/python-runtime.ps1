function Get-VoicePythonInfo([string]$Executable, [string[]]$Prefix = @(), [switch]$RequirePip) {
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return @{ Available = $false; Version = ''; Error = 'Executável Python ausente.' } }
  $probe = if ($RequirePip) { 'import sys,pip;print(str(sys.version_info[0])+chr(46)+str(sys.version_info[1]))' } else { 'import sys;print(str(sys.version_info[0])+chr(46)+str(sys.version_info[1]))' }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
  $process.StartInfo.FileName = $Executable
  $process.StartInfo.Arguments = (($Prefix + @('-I', '-c', ('"' + $probe + '"'))) -join ' ')
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  try {
    if (-not $process.Start()) { throw 'Não foi possível iniciar o Python.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'O Python não respondeu ao diagnóstico em 10 segundos.' }
    $version = $stdout.GetAwaiter().GetResult().Trim()
    $detail = $stderr.GetAwaiter().GetResult().Trim()
    if ($process.ExitCode -ne 0 -or $version -notmatch '^3\.\d+$') {
      return @{ Available = $false; Version = ''; Error = if ($detail) { $detail } else { 'O Python não concluiu o diagnóstico.' } }
    }
    return @{ Available = $true; Version = $version; Error = '' }
  } catch {
    return @{ Available = $false; Version = ''; Error = $_.Exception.Message }
  } finally { $process.Dispose() }
}
