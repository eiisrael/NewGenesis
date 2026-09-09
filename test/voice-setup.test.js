import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('setup Windows preserva venv quebrado, reutiliza saudável e restaura após falha', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-voice-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
. ./scripts/setup-voice.ps1 -Component piper
$testRoot = $env:GENESIS_VOICE_SETUP_TEST_ROOT
$stub = Join-Path $testRoot 'python-test.exe'
Add-Type -OutputAssembly $stub -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public class TestPython {
  public static int Main(string[] args) {
    string exe = Assembly.GetExecutingAssembly().Location;
    string cfg = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(exe)), "pyvenv.cfg");
    if (File.Exists(cfg) && File.ReadAllText(cfg) == "broken") {
      Console.Error.WriteLine("No Python at missing-base-python");
      return 103;
    }
    if (Array.IndexOf(args, "venv") >= 0) {
      string target = args[args.Length - 1];
      Directory.CreateDirectory(Path.Combine(target, "Scripts"));
      File.WriteAllText(Path.Combine(target, "pyvenv.cfg"), "healthy");
      File.Copy(exe, Path.Combine(target, "Scripts", "python.exe"));
      if (Environment.GetEnvironmentVariable("GENESIS_TEST_FAIL_VENV") == "1") return 9;
    } else if (Array.IndexOf(args, "-c") >= 0) Console.WriteLine("3.12");
    return 0;
  }
}
'@

function New-TestEnvironment([string]$Name, [string]$State) {
  $script:ProjectRoot = Join-Path $testRoot $Name
  $script:VoiceDir = Join-Path $script:ProjectRoot '.genesis\voice'
  $script:PythonExecutable = $stub
  $script:venv = Join-Path $script:VoiceDir 'venv-piper'
  New-Item -ItemType Directory -Force -Path (Join-Path $script:venv 'Scripts') | Out-Null
  Copy-Item -LiteralPath $stub -Destination (Join-Path $script:venv 'Scripts\python.exe')
  [IO.File]::WriteAllText((Join-Path $script:venv 'pyvenv.cfg'), $State)
  [IO.File]::WriteAllText((Join-Path $script:venv 'keep.txt'), 'user content')
}

New-TestEnvironment 'healthy' 'healthy'
$healthy = Ensure-Venv 'piper'
if (-not (Get-VoicePythonInfo $healthy -RequirePip).Available) { throw 'Healthy environment must remain operational' }
if (@(Get-ChildItem -LiteralPath $VoiceDir -Directory).Count -ne 1) { throw 'Healthy environment must not be moved' }

New-TestEnvironment 'broken' 'broken'
$repaired = Ensure-Venv 'piper'
if (-not (Get-VoicePythonInfo $repaired -RequirePip).Available) { throw 'Repaired environment must be operational' }
$backups = @(Get-ChildItem -LiteralPath $VoiceDir -Directory -Filter 'venv-piper.backup-*')
if ($backups.Count -ne 1 -or [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'keep.txt')) -ne 'user content') { throw 'Original contents must survive in backup' }
if ([IO.File]::ReadAllText((Join-Path $backups[0].FullName 'pyvenv.cfg')) -ne 'broken') { throw 'Original configuration must remain unchanged' }

New-TestEnvironment 'rollback' 'broken'
$env:GENESIS_TEST_FAIL_VENV = '1'
$failed = $false
try { Ensure-Venv 'piper' | Out-Null } catch { $failed = $true }
$env:GENESIS_TEST_FAIL_VENV = ''
if (-not $failed) { throw 'Creation failure must be reported' }
if ([IO.File]::ReadAllText((Join-Path $venv 'pyvenv.cfg')) -ne 'broken') { throw 'Original environment must be restored on creation failure' }
if ([IO.File]::ReadAllText((Join-Path $venv 'keep.txt')) -ne 'user content') { throw 'Rollback must preserve user content' }
if (@(Get-ChildItem -LiteralPath $VoiceDir -Directory -Filter 'venv-piper.failed-*').Count -ne 1) { throw 'Incomplete environment must be preserved for diagnosis' }

New-TestEnvironment 'missing-host-python' 'broken'
$PythonExecutable = Join-Path $testRoot 'missing-python.exe'
$failed = $false
try { Ensure-Venv 'piper' | Out-Null } catch { $failed = $true }
if (-not $failed -or @(Get-ChildItem -LiteralPath $VoiceDir -Directory).Count -ne 1) { throw 'Missing host Python must fail before moving anything' }
if ([IO.File]::ReadAllText((Join-Path $venv 'keep.txt')) -ne 'user content') { throw 'Original contents must survive invalid host Python' }
$failed = $false
try { Assert-VoicePath (Join-Path $testRoot 'outside-voice') } catch { $failed = $true }
if (-not $failed) { throw 'Paths outside voice must be rejected' }
Write-Output 'voice-setup-regressions-ok'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, GENESIS_VOICE_SETUP_TEST_ROOT: root },
    windowsHide: true, encoding: 'utf8', timeout: 30_000
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /voice-setup-regressions-ok/);
});
