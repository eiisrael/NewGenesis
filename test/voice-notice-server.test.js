import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createHandler } from '../src/server.js';
import { GenesisStore } from '../src/storage.js';

test('aviso de microfone é validado, persistido como Genesis Local e deduplicado', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-voice-notice-'));
  const store = await new GenesisStore(root).init();
  const events = [];
  const handler = createHandler({
    config: { root, dataDir: root, version: 'test', maxMessageCharacters: 20_000, inputTokenBudget: 8_000 },
    store,
    orchestrator: { provider: () => null },
    telemetry: { emit: event => events.push(event) },
    approvalManager: { cancelConversation() {} }
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const conversation = await store.createConversation();
  const endpoint = `${baseUrl}/api/conversations/${conversation.id}/notices`;
  const denied = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'microphone_unavailable', code: 'microphone_not_found' })
  });
  assert.equal(denied.status, 403);

  const request = () => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ kind: 'microphone_unavailable', code: 'microphone_not_found', language: 'pt-BR' })
  });
  const created = await request();
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.match(payload.message.content, /nenhum microfone ativo foi encontrado/i);
  assert.equal(payload.message.meta.providerId, 'genesis-local');
  assert.equal(payload.message.meta.model, 'voice-diagnostics');
  assert.deepEqual(payload.message.meta.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, accuracy: 'local' });

  const duplicate = await request();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).deduplicated, true);
  assert.equal(store.getConversation(conversation.id).messages.length, 1);
  assert.ok(events.some(event => event.type === 'voice.microphone.notice'));
});
