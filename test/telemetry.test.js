import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GenesisTelemetry } from '../src/telemetry.js';

test('transmite, persiste e filtra eventos seguros do Genesis', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-telemetry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const telemetry = await new GenesisTelemetry(directory, { capacity: 10 }).init();
  const received = [];
  const unsubscribe = telemetry.subscribe(event => received.push(event));

  telemetry.emit({
    category: 'agent', type: 'agent.attempt', title: 'Executando etapa',
    detail: 'Authorization: Bearer sk-test_12345678901234567890', thought: true,
    meta: { apiKey: 'segredo', inputTokens: 320, providerId: 'free-model' }
  });
  telemetry.emit({ category: 'system', type: 'system.ready', title: 'Pronto', level: 'success' });
  unsubscribe();
  await telemetry.flush();

  assert.equal(received.length, 2);
  assert.equal(received[0].meta.apiKey, '[REDACTED]');
  assert.equal(received[0].meta.inputTokens, 320);
  assert.equal(received[0].detail.includes('sk-test_'), false);
  assert.equal(telemetry.list({ thought: true }).length, 1);
  assert.equal(telemetry.list({ category: 'system' }).length, 1);

  const restored = await new GenesisTelemetry(directory, { capacity: 10 }).init();
  assert.equal(restored.list().length, 2);
  assert.equal(restored.list()[0].title, 'Executando etapa');
  await restored.clear();
  assert.equal(restored.list().length, 0);
  assert.equal(await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8'), '');
});

test('limita a retenção em memória aos eventos mais recentes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-telemetry-ring-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const telemetry = await new GenesisTelemetry(directory, { capacity: 3 }).init();
  for (let index = 1; index <= 5; index += 1) telemetry.emit({ title: `Evento ${index}` });
  await telemetry.flush();
  assert.deepEqual(telemetry.list().map(event => event.title), ['Evento 3', 'Evento 4', 'Evento 5']);
});

test('flush drena a fila e erros de persistência nunca viram unhandledRejection', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-telemetry-flush-'));
  const telemetry = await new GenesisTelemetry(directory).init();
  for (let index = 0; index < 50; index += 1) {
    telemetry.emit({ category: 'test', type: 'flush.regression', title: `Evento ${index}` });
  }
  await telemetry.flush();
  const persisted = (await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(persisted.length, 50);

  await fs.rm(directory, { recursive: true, force: true });
  let unhandled = null;
  const capture = error => { unhandled = error; };
  process.once('unhandledRejection', capture);
  t.after(() => process.off('unhandledRejection', capture));
  telemetry.emit({ category: 'test', type: 'flush.failure', title: 'Diretório removido' });
  await assert.rejects(telemetry.flush(), error => error.code === 'ENOENT');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unhandled, null);
});
