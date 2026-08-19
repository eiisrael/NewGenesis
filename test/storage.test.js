import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GenesisStore } from '../src/storage.js';

test('persiste conversas e métricas sem gravar credenciais', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new GenesisStore(directory).init();
  const conversation = await store.createConversation({ mode: 'code' });
  await store.addMessage(conversation.id, {
    role: 'user', content: 'Crie uma API segura.',
    attachments: [{ id: 'attachment-1', name: 'requisitos.md', mimeType: 'text/plain', kind: 'text', size: 42, sha256: 'a'.repeat(64) }]
  });
  await store.addMessage(conversation.id, { role: 'assistant', content: 'Plano pronto.', meta: { provider: 'OpenRouter' } });
  await store.applyResult(conversation.id, {
    providerId: 'openrouter', usage: { inputTokens: 20, outputTokens: 10 }, context: { savedTokens: 80 }
  });
  const loaded = store.getConversation(conversation.id);
  assert.equal(loaded.title, 'Crie uma API segura.');
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].attachments[0].name, 'requisitos.md');
  assert.equal('dataUrl' in loaded.messages[0].attachments[0], false);
  assert.equal(loaded.stats.savedTokens, 80);
  assert.equal(JSON.stringify(loaded).includes('API_KEY'), false);
});

test('edita uma mensagem do usuário sem apagar o consumo remoto já realizado', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-edit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new GenesisStore(directory).init();
  const conversation = await store.createConversation({ mode: 'balanced' });
  const first = await store.addMessage(conversation.id, { role: 'user', content: 'Versão original.', meta: { tokenEstimate: 8, tokenAccuracy: 'estimated' } });
  await store.addMessage(conversation.id, {
    role: 'assistant', content: 'Resposta antiga.',
    meta: { providerId: 'openrouter', usage: { inputTokens: 20, outputTokens: 10 }, context: { savedTokens: 4 } }
  });
  await store.applyResult(conversation.id, {
    providerId: 'openrouter', usage: { inputTokens: 20, outputTokens: 10 }, context: { savedTokens: 4 }
  });

  const result = await store.editUserMessage(conversation.id, first.id, { content: 'Versão corrigida.', mode: 'code', meta: { tokenEstimate: 9, tokenAccuracy: 'estimated' } });
  const edited = store.getConversation(conversation.id);

  assert.equal(result.message.content, 'Versão corrigida.');
  assert.ok(result.message.editedAt);
  assert.equal(result.message.meta.tokenEstimate, 9);
  assert.equal(edited.messages.length, 1);
  assert.equal(edited.title, 'Versão corrigida.');
  assert.equal(edited.mode, 'code');
  assert.deepEqual(edited.stats, { inputTokens: 20, outputTokens: 10, savedTokens: 4, providerSwitches: 0, requests: 1 });
  assert.equal(edited.lastProviderId, 'openrouter');
});

test('consumo de uma tentativa falha permanece contabilizado depois de editar e reiniciar', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-failed-usage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new GenesisStore(directory).init();
  const conversation = await store.createConversation({ mode: 'balanced' });
  const first = await store.addMessage(conversation.id, {
    role: 'user', content: 'Analise o projeto.', meta: { tokenEstimate: 6, tokenAccuracy: 'estimated' }
  });

  await store.applyResult(conversation.id, {
    accountingId: 'failed-task-1',
    providerId: 'openrouter',
    usage: { inputTokens: 451_000, outputTokens: 0, requestCount: 2, accuracy: 'reported' },
    context: { savedTokens: 0 }
  });
  await store.editUserMessage(conversation.id, first.id, {
    content: 'Analise somente o resumo local.',
    meta: { tokenEstimate: 8, tokenAccuracy: 'estimated' }
  });

  const edited = store.getConversation(conversation.id);
  assert.equal(edited.messages.length, 1, 'a resposta falha não precisa existir para preservar a medição');
  assert.deepEqual(edited.stats, {
    inputTokens: 451_000,
    outputTokens: 0,
    savedTokens: 0,
    providerSwitches: 0,
    requests: 2
  });

  const restored = await new GenesisStore(directory).init();
  assert.deepEqual(restored.getConversation(conversation.id).stats, edited.stats);
});

test('persiste nome e marcador escolhidos sem perder a personalização ao editar a primeira mensagem', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-personalization-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new GenesisStore(directory).init();
  const conversation = await store.createConversation();
  const first = await store.addMessage(conversation.id, { role: 'user', content: 'Nome automático.' });

  await store.updateConversation(conversation.id, { title: 'Projeto Aurora', markerColor: 'cyan' });
  await store.editUserMessage(conversation.id, first.id, { content: 'Mensagem atualizada.' });
  const loaded = store.getConversation(conversation.id);

  assert.equal(loaded.title, 'Projeto Aurora');
  assert.equal(loaded.customTitle, true);
  assert.equal(loaded.markerColor, 'cyan');
});
