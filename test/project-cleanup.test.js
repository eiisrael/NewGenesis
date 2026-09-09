import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCleanupPlan, collectCleanupPlan } from '../scripts/cleanup-project.mjs';

async function write(root, relative, content = 'x') {
  const target = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

test('limpeza remove somente resíduos seguros e preserva estado, modelos e memória', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await write(root, 'README.md', 'fonte rastreada');
  await write(root, '.genesis/state.json', '{"keep":true}');
  await write(root, '.genesis/conversations/history.json', '[]');
  await write(root, '.genesis/voice/models/kokoro/kokoro-v1_0.pth', 'modelo-ativo');
  await write(root, '.genesis/voice/hf-cache/models--active/blob', 'cache-ativo-do-chatterbox');
  await write(root, '.suprememind/memory.json', '{"keep":true}');

  await write(root, 'node_modules/old-package/index.js', 'obsoleto');
  await write(root, '.genesis/voice/tmp/audio.wav', 'temporario');
  await write(root, '.genesis/voice/downloads/archive.zip', 'download');
  await write(root, '.genesis/voice/extract-whisper-old/file.bin', 'extracao');
  await write(root, '.genesis/voice/venv-chatterbox.backup-20260101/Lib/site-packages/torch.bin', 'backup');
  await write(root, '.genesis/voice/venv-kokoro.failed-deadbeef/partial.bin', 'falhou');
  await write(root, '.genesis/voice/venv-piper/Lib/site-packages/pkg/__pycache__/module.pyc', 'cache');

  const tracked = new Set(['README.md']);
  const plan = await collectCleanupPlan({ root, trackedPaths: tracked, probeVoiceEnv: (_root, engine) => engine === 'chatterbox' });
  const paths = new Set(plan.candidates.map(item => item.path));
  assert.equal(paths.has('node_modules'), true);
  assert.equal(paths.has('.genesis/voice/tmp'), true);
  assert.equal(paths.has('.genesis/voice/downloads'), true);
  assert.equal(paths.has('.genesis/voice/extract-whisper-old'), true);
  assert.equal(paths.has('.genesis/voice/venv-chatterbox.backup-20260101'), true);
  assert.equal(paths.has('.genesis/voice/venv-kokoro.failed-deadbeef'), true);
  assert.equal([...paths].some(item => item.endsWith('__pycache__')), true);
  assert.equal(paths.has('.genesis/voice/hf-cache'), false);
  assert.equal(paths.has('.genesis/voice/models'), false);

  const result = await applyCleanupPlan(plan, { trackedPaths: tracked });
  assert.ok(result.reclaimedBytes > 0);
  assert.equal(await exists(path.join(root, 'node_modules')), false);
  assert.equal(await exists(path.join(root, '.genesis', 'voice', 'tmp')), false);
  assert.equal(await exists(path.join(root, '.genesis', 'voice', 'venv-chatterbox.backup-20260101')), false);

  assert.equal(await exists(path.join(root, 'README.md')), true);
  assert.equal(await exists(path.join(root, '.genesis', 'state.json')), true);
  assert.equal(await exists(path.join(root, '.genesis', 'conversations', 'history.json')), true);
  assert.equal(await exists(path.join(root, '.genesis', 'voice', 'models', 'kokoro', 'kokoro-v1_0.pth')), true);
  assert.equal(await exists(path.join(root, '.genesis', 'voice', 'hf-cache', 'models--active', 'blob')), true);
  assert.equal(await exists(path.join(root, '.suprememind', 'memory.json')), true);
});

test('backup de voz é preservado se o ambiente ativo não for validado', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-cleanup-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, '.genesis/voice/venv-chatterbox.backup-20260101/model.bin', 'backup-importante');

  const plan = await collectCleanupPlan({ root, trackedPaths: new Set(), probeVoiceEnv: () => false });
  assert.equal(plan.candidates.some(item => item.path.includes('venv-chatterbox.backup-')), false);
  assert.equal(plan.protected.some(item => item.path.includes('venv-chatterbox.backup-')), true);
});

test('barreira de rastreamento impede apagar qualquer diretório que contenha arquivo versionado', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-cleanup-tracked-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, 'node_modules/fixture/keep.txt', 'fixture versionada');

  const tracked = new Set(['node_modules/fixture/keep.txt']);
  const plan = await collectCleanupPlan({ root, trackedPaths: tracked, probeVoiceEnv: () => true });
  assert.equal(plan.candidates.some(item => item.path === 'node_modules'), false);
  assert.equal(plan.protected.some(item => item.path === 'node_modules'), true);
});
