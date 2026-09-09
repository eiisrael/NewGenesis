import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const VOICE_ENGINES = Object.freeze({
  piper: ['piper', 'onnxruntime'],
  kokoro: ['kokoro', 'torch', 'misaki', 'phonemizer', 'soundfile', 'espeakng_loader'],
  chatterbox: ['torch', 'torchaudio', 'huggingface_hub']
});

const ROOT_CACHE_DIRS = Object.freeze([
  'node_modules', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.nyc_output', 'coverage'
]);
const SUPREMEMIND_CACHE_DIRS = Object.freeze([
  'SupremeMind/node_modules', 'SupremeMind/.cache', 'SupremeMind/.pytest_cache', 'SupremeMind/.mypy_cache',
  'SupremeMind/.ruff_cache', 'SupremeMind/.nyc_output', 'SupremeMind/coverage'
]);

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function normalizeRelative(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function lstatSafe(target) {
  try { return await fs.lstat(target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function directorySize(target) {
  const stat = await lstatSafe(target);
  if (!stat) return 0;
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  let entries = [];
  try { entries = await fs.readdir(target, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) total += await directorySize(path.join(target, entry.name));
  return total;
}

function trackedBelow(relativePath, trackedPaths) {
  const candidate = normalizeRelative(relativePath);
  if (!candidate) return trackedPaths.size > 0;
  const prefix = `${candidate}/`;
  for (const tracked of trackedPaths) {
    if (tracked === candidate || tracked.startsWith(prefix)) return true;
  }
  return false;
}

function gitTrackedPaths(root) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) return null;
  return new Set(String(result.stdout || '').split('\0').map(normalizeRelative).filter(Boolean));
}

function voicePython(root, engine) {
  const base = path.join(root, '.genesis', 'voice', `venv-${engine}`);
  return process.platform === 'win32'
    ? path.join(base, 'Scripts', 'python.exe')
    : path.join(base, 'bin', 'python');
}

export function probeVoiceEnvironment(root, engine) {
  const modules = VOICE_ENGINES[engine];
  if (!modules) return false;
  const executable = voicePython(root, engine);
  const source = `import importlib.util; missing=[m for m in ${JSON.stringify(modules)} if importlib.util.find_spec(m) is None]; raise SystemExit(1 if missing else 0)`;
  const result = spawnSync(executable, ['-I', '-c', source], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12_000
  });
  return result.status === 0;
}

async function addCandidate(plan, root, relativePath, reason, trackedPaths, options = {}) {
  const relative = normalizeRelative(relativePath);
  const absolute = path.resolve(root, relative);
  if (!relative || !insideRoot(root, absolute)) return;
  const stat = await lstatSafe(absolute);
  if (!stat || stat.isSymbolicLink()) return;
  if (trackedBelow(relative, trackedPaths)) {
    plan.protected.push({ path: relative, reason: 'contém arquivo versionado; preservado por segurança' });
    return;
  }
  const bytes = await directorySize(absolute);
  plan.candidates.push({ path: relative, reason, bytes, kind: stat.isDirectory() ? 'directory' : 'file', ...options });
}

async function walkVoiceResidue(plan, root, trackedPaths, probeVoiceEnv) {
  const voiceRelative = '.genesis/voice';
  const voiceRoot = path.join(root, '.genesis', 'voice');
  const voiceStat = await lstatSafe(voiceRoot);
  if (!voiceStat?.isDirectory() || voiceStat.isSymbolicLink()) return;

  for (const direct of ['tmp', 'downloads']) {
    await addCandidate(plan, root, `${voiceRelative}/${direct}`, `runtime temporário de voz (${direct})`, trackedPaths);
  }

  let entries = [];
  try { entries = await fs.readdir(voiceRoot, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    const relative = `${voiceRelative}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && /^extract-/i.test(entry.name)) {
      await addCandidate(plan, root, relative, 'extração temporária de instalador de voz', trackedPaths);
      continue;
    }
    const backup = entry.isDirectory() && entry.name.match(/^venv-(piper|kokoro|chatterbox)\.backup-/i);
    if (backup) {
      const engine = backup[1].toLowerCase();
      if (probeVoiceEnv(root, engine)) {
        await addCandidate(plan, root, relative, `backup obsoleto de venv-${engine}; ambiente ativo validado`, trackedPaths, { healthVerified: true });
      } else {
        plan.protected.push({ path: relative, reason: `backup de venv-${engine} mantido: ambiente ativo não passou na validação` });
      }
      continue;
    }
    if (entry.isDirectory() && /^venv-(?:piper|kokoro|chatterbox)\.failed-/i.test(entry.name)) {
      await addCandidate(plan, root, relative, 'ambiente virtual incompleto de tentativa já falhada', trackedPaths);
    }
  }

  const stack = [voiceRoot];
  while (stack.length) {
    const current = stack.pop();
    let children = [];
    try { children = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      const absolute = path.join(current, child.name);
      if (!insideRoot(voiceRoot, absolute) || child.isSymbolicLink()) continue;
      const relative = normalizeRelative(path.relative(root, absolute));
      if (plan.candidates.some(candidate => relative === candidate.path || relative.startsWith(`${candidate.path}/`))) continue;
      if (child.isDirectory()) {
        if (child.name === '__pycache__') {
          await addCandidate(plan, root, relative, 'cache Python recompilável', trackedPaths);
        } else {
          stack.push(absolute);
        }
      } else if (/\.(?:pyc|pyo|tmp|log|download)$/i.test(child.name)) {
        await addCandidate(plan, root, relative, 'arquivo temporário/cache de runtime de voz', trackedPaths);
      }
    }
  }
}

async function topLevelUsage(root) {
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const usage = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    usage.push({ path: entry.name, bytes: await directorySize(absolute) });
  }
  usage.sort((left, right) => right.bytes - left.bytes);
  return usage;
}

export async function collectCleanupPlan({ root = DEFAULT_ROOT, trackedPaths = undefined, probeVoiceEnv = probeVoiceEnvironment } = {}) {
  const resolvedRoot = path.resolve(root);
  const tracked = trackedPaths instanceof Set ? new Set([...trackedPaths].map(normalizeRelative)) : gitTrackedPaths(resolvedRoot);
  if (tracked === null) throw new Error('Não foi possível confirmar os arquivos versionados com git ls-files. A limpeza foi abortada por segurança.');

  const plan = {
    root: resolvedRoot,
    trackedCount: tracked.size,
    candidates: [],
    protected: [],
    usage: await topLevelUsage(resolvedRoot)
  };

  for (const relative of [...ROOT_CACHE_DIRS, ...SUPREMEMIND_CACHE_DIRS]) {
    await addCandidate(plan, resolvedRoot, relative, 'cache/dependência local recompilável e não versionada', tracked);
  }
  for (const relative of ['.DS_Store', 'Thumbs.db']) {
    await addCandidate(plan, resolvedRoot, relative, 'metadado do sistema operacional', tracked);
  }

  await walkVoiceResidue(plan, resolvedRoot, tracked, probeVoiceEnv);
  plan.candidates.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
  plan.reclaimableBytes = plan.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  return plan;
}

export async function applyCleanupPlan(plan, { trackedPaths = undefined } = {}) {
  const root = path.resolve(plan?.root || DEFAULT_ROOT);
  const tracked = trackedPaths instanceof Set ? new Set([...trackedPaths].map(normalizeRelative)) : gitTrackedPaths(root);
  if (tracked === null) throw new Error('Não foi possível reconfirmar os arquivos versionados. Nenhuma exclusão foi executada.');

  const removed = [];
  const skipped = [];
  for (const candidate of plan.candidates || []) {
    const relative = normalizeRelative(candidate.path);
    const absolute = path.resolve(root, relative);
    if (!relative || !insideRoot(root, absolute) || trackedBelow(relative, tracked)) {
      skipped.push({ ...candidate, reason: 'proteção de caminho/arquivo versionado acionada' });
      continue;
    }
    const stat = await lstatSafe(absolute);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      skipped.push({ ...candidate, reason: 'link simbólico preservado por segurança' });
      continue;
    }
    await fs.rm(absolute, { recursive: stat.isDirectory(), force: true, maxRetries: 2, retryDelay: 100 });
    removed.push(candidate);
  }
  return {
    removed,
    skipped,
    reclaimedBytes: removed.reduce((sum, item) => sum + (item.bytes || 0), 0)
  };
}

function printReport(plan, result = null) {
  console.log('\nGenesis · limpeza profissional segura');
  console.log(`Raiz: ${plan.root}`);
  console.log(`Arquivos versionados protegidos: ${plan.trackedCount}`);
  console.log('\nMaiores áreas locais:');
  for (const item of plan.usage.slice(0, 12)) console.log(`  ${formatBytes(item.bytes).padStart(10)}  ${item.path}`);

  console.log(`\nResíduos seguros identificados: ${plan.candidates.length} (${formatBytes(plan.reclaimableBytes)})`);
  for (const item of plan.candidates) console.log(`  ${formatBytes(item.bytes).padStart(10)}  ${item.path} — ${item.reason}`);

  if (plan.protected.length) {
    console.log('\nItens deliberadamente preservados:');
    for (const item of plan.protected) console.log(`  ${item.path} — ${item.reason}`);
  }
  console.log('\nProteções fixas: .git, código-fonte, arquivos rastreados, .suprememind e dados da .genesis fora dos resíduos de voz não são removidos.');
  console.log('Modelos ativos, hf-cache do Chatterbox, venvs ativos, memória, conversas, anexos e configurações permanecem intactos.');

  if (result) {
    console.log(`\nRemovidos: ${result.removed.length}; espaço recuperado: ${formatBytes(result.reclaimedBytes)}.`);
    if (result.skipped.length) console.log(`Ignorados pela barreira final de segurança: ${result.skipped.length}.`);
  } else {
    console.log('\nModo auditoria: nada foi excluído. Use npm run cleanup para aplicar somente os itens acima.');
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const json = args.has('--json');
  const plan = await collectCleanupPlan();
  const result = apply ? await applyCleanupPlan(plan) : null;
  if (json) console.log(JSON.stringify({ plan, result }, null, 2));
  else printReport(plan, result);
}

if (path.resolve(process.argv[1] || '') === SCRIPT_PATH) {
  main().catch(error => {
    console.error(`Falha segura na limpeza: ${error.message}`);
    process.exitCode = 1;
  });
}
