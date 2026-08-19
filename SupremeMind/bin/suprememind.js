#!/usr/bin/env node
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCli } from '../src/suprememind.js';
import { startGuiServer } from '../src/gui-server.js';

const execFileAsync = promisify(execFile);

function flag(argv, name, fallback) {
  const index = argv.findIndex(value => value === `--${name}` || value.startsWith(`--${name}=`));
  if (index < 0) return fallback;
  const inline = argv[index].split('=', 2)[1];
  if (inline !== undefined) return inline;
  return argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : true;
}

async function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  await execFileAsync(command, args, { windowsHide: true }).catch(() => {});
}

function isSupremeMindStatus(status) {
  if (!status || typeof status !== 'object') return false;
  if (status.product === 'SupremeMind') return true;
  return typeof status.guiVersion === 'string'
    && typeof status.root === 'string'
    && typeof status.initialized === 'boolean'
    && typeof status.indexed === 'boolean'
    && status.acceleration?.cpuFallback === true;
}

async function probeSupremeMind(url) {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) });
    const status = await response.json();
    return response.ok && isSupremeMindStatus(status) ? status : null;
  } catch {
    return null;
  }
}

async function stopWindowsPort(port) {
  const script = [
    `$connections = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    '$pids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)',
    'if ($pids.Count -eq 0) { exit 3 }',
    'foreach ($processId in $pids) { Stop-Process -Id $processId -Force -ErrorAction Stop; Write-Output $processId }'
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  return stdout.trim().split(/\r?\n/).filter(Boolean);
}

async function stopUnixPort(port) {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']));
  } catch {
    ({ stdout } = await execFileAsync('fuser', [`${port}/tcp`]));
  }
  const pids = stdout.match(/\d+/g) ?? [];
  for (const pid of new Set(pids)) process.kill(Number(pid), 'SIGTERM');
  return [...new Set(pids)];
}

async function stopGui(host, port) {
  const url = `http://${host}:${port}`;
  const status = await probeSupremeMind(url);
  if (!status) {
    throw new Error(`Nenhuma instância identificada do SupremeMind está respondendo em ${url}.`);
  }
  const pids = process.platform === 'win32' ? await stopWindowsPort(port) : await stopUnixPort(port);
  console.log(`[SupremeMind GUI] Instância encerrada em ${url}. PID: ${pids.join(', ') || 'confirmado pelo sistema'}`);
}

async function startGui(argv) {
  const host = String(flag(argv, 'host', '127.0.0.1'));
  const port = Number(flag(argv, 'port', 7331));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Porta inválida: ${port}`);
  if (argv[1] === 'stop') return stopGui(host, port);

  const hostFlag = flag(argv, 'host');
  const portFlag = flag(argv, 'port');
  const rootArg = argv.slice(1).find(value => !value.startsWith('--') && value !== hostFlag && value !== portFlag);
  const root = path.resolve(rootArg ?? process.cwd());
  const open = !argv.includes('--no-open');
  const url = `http://${host}:${port}`;
  try {
    const started = await startGuiServer({ root, host, port, open });
    console.log(`[SupremeMind GUI] Control Core ativo em ${started.url}`);
    console.log(`[SupremeMind GUI] Projeto: ${root}`);
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    const status = await probeSupremeMind(url);
    if (!status) {
      throw new Error(`A porta ${port} está ocupada por outro programa. Use --port 7332 ou libere a porta.`);
    }
    console.log(`[SupremeMind GUI] Uma instância já está ativa em ${url}.`);
    console.log(`[SupremeMind GUI] Versão: ${status.guiVersion ?? 'desconhecida'} · Projeto: ${status.root ?? 'desconhecido'}`);
    console.log('[SupremeMind GUI] Para reiniciar com o código atualizado: suprememind gui stop && suprememind gui');
    if (open) await openBrowser(url);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'gui') return startGui(argv);
  await runCli(argv);
  if (argv.some(value => ['help', '-h', '--help'].includes(value)) || argv.length === 0) {
    console.log('  gui [diretório] [--host 127.0.0.1] [--port 7331] [--no-open]');
    console.log('  gui stop [--host 127.0.0.1] [--port 7331]');
  }
}

main().catch(error => {
  console.error(`[SupremeMind] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
