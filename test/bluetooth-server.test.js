import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../src/server.js';
import { GenesisStore } from '../src/storage.js';
import { ContextEngine } from '../src/core/context-engine.js';

test('Bluetooth registra resultado local com origem explícita, sem inferência ou ferramenta no servidor', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-bluetooth-server-'));
  const store = await new GenesisStore(root).init();
  let invalidations = 0;
  const handler = createHandler({
    config: { root, dataDir: root, version: 'test', maxMessageCharacters: 20_000 }, store,
    orchestrator: { provider: () => null, invalidateContext() { invalidations += 1; } },
    telemetry: { emit() {} }, approvalManager: { cancelConversation() {} }
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const conversation = await store.createConversation();
  const endpoint = `http://127.0.0.1:${server.address().port}/api/conversations/${conversation.id}/device-actions`;
  const body = {
    content: 'Qual é a bateria Bluetooth?', inputMetadata: { inputMode: 'voice' },
    result: { action: 'battery', ok: true, content: 'Bateria: 72%.', deviceName: 'Sensor' }
  };
  const post = (payload, trusted = true) => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(trusted ? { 'x-genesis-client': 'web' } : {}) },
    body: JSON.stringify(payload)
  });
  assert.equal((await post(body, false)).status, 403);
  assert.equal((await post({ ...body, result: { ...body.result, action: 'run_shell' } })).status, 400);
  assert.equal((await post({ ...body, result: { ...body.result, content: 'a'.repeat(8001) } })).status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal(store.getConversation(conversation.id).messages.length, 0);
  const response = await post(body);
  assert.equal(response.status, 201);
  assert.match(response.headers.get('permissions-policy'), /bluetooth=\(self\)/);
  const result = await response.json();
  assert.equal(result.conversation.messages.length, 2);
  const assistant = result.conversation.messages.at(-1);
  assert.equal(assistant.meta.usage.requestCount, 0);
  assert.equal(assistant.meta.deviceAction.source, 'client-bluetooth');
  assert.equal(assistant.meta.deviceAction.action, 'battery');
  assert.equal(invalidations, 1);
  const context = await new ContextEngine().build({ conversation: result.conversation, query: 'Qual a leitura?' });
  assert.match(JSON.stringify(context.messages), /Relato Bluetooth do navegador/);
});
