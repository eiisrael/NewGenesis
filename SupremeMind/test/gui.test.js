import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startGuiServer } from '../src/gui-server.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suprememind-gui-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'database.js'), `
export function savePlayer(player) {
  return { ...player, saved: true };
}
`);
  await fs.writeFile(path.join(root, 'src', 'player.js'), `
import { savePlayer } from './database.js';
export function createPlayer(name) {
  return savePlayer({ name });
}
`);
  return root;
}

async function request(base, pathname, method = 'GET', body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

async function streamAction(base, body) {
  const response = await fetch(`${base}/api/action-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const text = await response.text();
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function asset(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  assert.equal(response.status, 200, pathname);
  return response.text();
}

test('GUI mantém loading isolado, recupera falhas e exige índice antes da GPU', async () => {
  const root = await fixture();
  const { server } = await startGuiServer({ root, host: '127.0.0.1', port: 0, open: false });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const html = await asset(base, '/');
    assert.match(html, /SupremeMind Control Core/);
    assert.match(html, /src="\/gpu-acceleration\.js"/);
    assert.match(html, /src="\/live-progress\.js"/);
    assert.match(html, /src="\/runtime-guardrails\.js"/);
    assert.doesNotMatch(html, /progress-fix\.css/);
    assert.ok(html.indexOf('/gpu-acceleration.js') < html.indexOf('/live-progress.js'));
    assert.ok(html.indexOf('/live-progress.js') < html.indexOf('/runtime-guardrails.js'));
    assert.ok(html.indexOf('/runtime-guardrails.js') < html.indexOf('/app.js'));

    const progressStyles = await asset(base, '/live-progress.css');
    assert.match(progressStyles, /sm-loader-spinner/);
    assert.match(progressStyles, /sm-real-percent/);
    assert.match(progressStyles, /sm-progress-details/);
    assert.doesNotMatch(progressStyles, /\.loader-core\s+div/);

    const progressSource = await asset(base, '/live-progress.js');
    assert.match(progressSource, /replaceChildren/);
    assert.match(progressSource, /<p><span class="sm-progress-stage"/);
    assert.match(progressSource, /VERBOSE EM TEMPO REAL/);
    assert.match(progressSource, /INDEX_REQUIRED/);
    assert.match(progressSource, /Fallback seguro para CPU/);

    const gpuSource = await asset(base, '/gpu-acceleration.js');
    assert.match(gpuSource, /runQuery: runGpuQuery/);
    assert.doesNotMatch(gpuSource, /window\.fetch\s*=/);

    const guardSource = await asset(base, '/runtime-guardrails.js');
    assert.match(guardSource, /Este projeto ainda não foi indexado/);
    assert.match(guardSource, /stopImmediatePropagation/);

    let status = await request(base, '/api/status');
    assert.equal(status.product, 'SupremeMind');
    assert.equal(status.guiVersion, '0.2.3');
    assert.equal(status.initialized, false);
    assert.equal(status.indexed, false);

    const gpuWithoutIndex = await fetch(`${base}/api/gpu/index`);
    assert.equal(gpuWithoutIndex.status, 409);
    assert.deepEqual(await gpuWithoutIndex.json(), {
      error: 'O projeto ainda não possui índice. Inicialize e indexe antes de ativar a GPU.',
      code: 'INDEX_REQUIRED'
    });

    const noIndexEvents = await streamAction(base, { action: 'query', query: 'login', limit: 10 });
    assert.equal(noIndexEvents[0].type, 'start');
    assert.ok(noIndexEvents.some(event => event.type === 'error' && /não possui índice/.test(event.error)));
    assert.equal(noIndexEvents.at(-1).type, 'error');

    await fs.mkdir(path.join(root, '.suprememind'), { recursive: true });
    await fs.writeFile(path.join(root, '.suprememind', 'index.json'), '{corrompido');
    status = await request(base, '/api/status');
    assert.equal(status.indexed, false);
    assert.match(status.indexError, /JSON|position|property|Expected/i);
    await fs.rm(path.join(root, '.suprememind', 'index.json'));

    await request(base, '/api/action', 'POST', { action: 'init' });
    await request(base, '/api/action', 'POST', { action: 'index' });

    status = await request(base, '/api/status');
    assert.equal(status.initialized, true);
    assert.equal(status.indexed, true);
    assert.equal(status.indexError, null);
    assert.ok(status.stats.indexed >= 2);
    assert.ok(status.stats.symbols >= 2);

    const gpuIndex = await request(base, '/api/gpu/index');
    assert.ok(gpuIndex.count >= 2);
    assert.ok(gpuIndex.dimensions >= 8);
    assert.equal(gpuIndex.files.length, gpuIndex.count);

    const events = await streamAction(base, {
      action: 'query',
      query: 'save player database',
      limit: 10
    });
    assert.equal(events[0].type, 'start');
    assert.ok(events.some(event => event.type === 'progress' && Number.isFinite(event.percent)));
    assert.ok(events.some(event => event.type === 'log' && /database\.js|player\.js/.test(event.message)));
    const resultEvent = events.find(event => event.type === 'result');
    assert.ok(resultEvent);
    assert.ok(resultEvent.result.data.some(row => /player|database/.test(row.path)));
    assert.equal(events.at(-1).type, 'result');

    const files = await request(base, '/api/files');
    assert.ok(files.some(file => file.path === 'src/player.js'));
    const file = await request(base, '/api/file?path=src%2Fplayer.js');
    assert.match(file.content, /createPlayer/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
