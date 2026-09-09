import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenRouterSettings, validateOpenRouterKey } from '../src/openrouter-settings.js';

const SAMPLE_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890';

test('cofre persiste a chave criptografada e restaura após reiniciar', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-openrouter-vault-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = await new OpenRouterSettings(directory).init();
  await settings.setKey(SAMPLE_KEY, { persist: true });
  await settings.setSelection('manual', 'qwen/qwen3:free');

  const vault = await fs.readFile(path.join(directory, 'openrouter.vault'), 'utf8');
  assert.equal(vault.includes(SAMPLE_KEY), false);
  assert.equal(vault.includes('aes-256-gcm'), true);

  const restored = await new OpenRouterSettings(directory).init();
  assert.equal(restored.key, SAMPLE_KEY);
  assert.equal(restored.persisted, true);
  assert.equal(JSON.stringify(restored.publicState()).includes(SAMPLE_KEY), false);
  assert.equal('key' in restored.publicState(), false);
  assert.equal(restored.preferences.selectionMode, 'manual');
  assert.equal(restored.preferences.selectedModel, 'qwen/qwen3:free');

  await restored.setPersistence(false);
  const sessionOnly = await new OpenRouterSettings(directory).init();
  assert.equal(sessionOnly.key, '');
  assert.equal(sessionOnly.persisted, false);
});

test('valida formato da chave sem aceitar credenciais genéricas', () => {
  assert.equal(validateOpenRouterKey(SAMPLE_KEY), SAMPLE_KEY);
  assert.throws(() => validateOpenRouterKey('sk-proj-paid'), /OpenRouter válida/);
  assert.throws(() => validateOpenRouterKey('token com espaços'), /OpenRouter válida/);
});

test('cofre ilegível é preservado e não gera chave mestra substituta', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-vault-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = await new OpenRouterSettings(directory).init();
  await settings.setKey(SAMPLE_KEY, { persist: true });
  const vaultFile = path.join(directory, 'openrouter.vault');
  const masterFile = path.join(directory, '.vault-key');
  const vault = await fs.readFile(vaultFile, 'utf8');
  const master = await fs.readFile(masterFile, 'utf8');
  await fs.unlink(masterFile);
  const unavailable = await new OpenRouterSettings(directory).init();
  assert.equal(unavailable.key, '');
  assert.equal(unavailable.publicState().error.code, 'vault_unreadable');
  assert.equal(await fs.readFile(vaultFile, 'utf8'), vault);
  await assert.rejects(fs.access(masterFile));
  await fs.writeFile(masterFile, master);
  const restored = await new OpenRouterSettings(directory).init();
  assert.equal(restored.key, SAMPLE_KEY);
  assert.equal(restored.publicState().error, undefined);
});
