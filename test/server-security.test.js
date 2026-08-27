import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHandler } from '../src/server.js';
import { createRuntimeShutdown } from '../src/runtime-lifecycle.js';

function rawRequest(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
}

test('servidor local rejeita Host e Origin externos', async t => {
  const handler = createHandler({
    config: { root: path.resolve(import.meta.dirname, '..'), version: 'test' },
    orchestrator: { provider: () => null },
    telemetry: { emit() {} },
    approvalManager: { cancelConversation() {} }
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const shutdown = createRuntimeShutdown({ server, handler });
  t.after(shutdown);

  assert.equal(await rawRequest(port), 200);
  assert.equal(await rawRequest(port, { Host: 'evil.example' }), 403);
  assert.equal(await rawRequest(port, { Origin: 'https://evil.example' }), 403);
  assert.equal(await rawRequest(port, { Origin: `http://127.0.0.1:${port}` }), 200);
});

test('shutdown encerra streams SSE de observabilidade antes de drenar o runtime', async () => {
  let unsubscribed = false;
  const telemetry = {
    emit() {},
    list: () => [],
    subscribe: () => () => { unsubscribed = true; },
    flush: async () => {}
  };
  const handler = createHandler({
    config: { root: path.resolve(import.meta.dirname, '..'), version: 'test' },
    orchestrator: { provider: () => null },
    telemetry,
    approvalManager: { cancelConversation() {} }
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/logs/stream' }, resolve);
    request.once('error', reject);
  });
  await new Promise(resolve => response.once('data', resolve));
  assert.equal(handler.runtimeState().activeStreams, 1);

  const shutdown = createRuntimeShutdown({ server, handler, telemetry });
  await shutdown();
  await new Promise(resolve => response.readableEnded ? resolve() : response.once('end', resolve));
  assert.equal(unsubscribed, true);
  assert.equal(handler.runtimeState().activeStreams, 0);
});

test('endpoint de shutdown exige a barreira da UI e agenda o lifecycle local', async t => {
  let requested = false;
  const handler = createHandler({
    config: { root: path.resolve(import.meta.dirname, '..'), version: 'test' },
    orchestrator: { provider: () => null },
    telemetry: { emit() {} },
    approvalManager: { cancelConversation() {} },
    onShutdown: async () => { requested = true; }
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const denied = await fetch(`http://127.0.0.1:${port}/api/runtime/shutdown`, { method: 'POST' });
  assert.equal(denied.status, 403);
  const accepted = await fetch(`http://127.0.0.1:${port}/api/runtime/shutdown`, {
    method: 'POST', headers: { 'x-genesis-client': 'web' }
  });
  assert.equal(accepted.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested, true);
});

test('contexto local expõe capacidades e clima somente pela barreira local', async t => {
  const calls = [];
  const handler = createHandler({
    config: { root: path.resolve(import.meta.dirname, '..'), version: 'test' },
    orchestrator: { provider: () => null },
    telemetry: { emit() {} },
    approvalManager: { cancelConversation() {} },
    weatherService: { currentForPlace: async place => { calls.push(place); return { source: { name: 'Open-Meteo' }, current: { temperature: 29 } }; } }
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const capabilities = await fetch(`http://127.0.0.1:${port}/api/context/capabilities`).then(response => response.json());
  assert.equal(capabilities.geolocation.available, false);
  assert.equal(capabilities.geolocation.persisted, false);
  assert.equal(capabilities.placeLookup.available, true);
  assert.equal(capabilities.weather.source, 'Open-Meteo');

  const denied = await fetch(`http://127.0.0.1:${port}/api/context/weather`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ place: 'Caruaru, PE' })
  });
  assert.equal(denied.status, 403);
  const accepted = await fetch(`http://127.0.0.1:${port}/api/context/weather`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ place: 'Caruaru, PE' })
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls, ['Caruaru, PE']);
});
