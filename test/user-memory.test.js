import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMemoryStore } from '../src/user-memory.js';

test('aprende apenas preferências não sensíveis e nunca armazena a mensagem bruta', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-user-memory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const memory = await new UserMemoryStore(directory).init();
  await memory.observe('Quero algo profissional, funcional e com testes no Windows. segredo-super-privado');
  await memory.observe('Seja profissional, valide os testes e use apenas opção gratuita no Windows.');

  const stored = await fs.readFile(path.join(directory, 'user-memory.json'), 'utf8');
  assert.equal(stored.includes('segredo-super-privado'), false);
  const context = await memory.context();
  assert.match(context, /profissional/i);
  assert.match(context, /Windows/i);
  assert.ok(memory.publicState().messagesObserved >= 2);
});

test('permite desativar e limpar a memória adaptativa', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-user-memory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const memory = await new UserMemoryStore(directory).init();
  await memory.setEnabled(false);
  await memory.observe('profissional profissional testes Windows');
  assert.equal(memory.publicState().messagesObserved, 0);
  await memory.setEnabled(true);
  await memory.observe('profissional e testes');
  await memory.clear();
  assert.equal(memory.publicState().messagesObserved, 0);
});
