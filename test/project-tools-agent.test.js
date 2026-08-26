import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectToolExecutor } from '../src/project-tools.js';

function executorWith(store, mode = 'full') {
  return new ProjectToolExecutor({
    projectStore: store,
    permissionStore: { mode },
    approvalManager: { request: () => { throw new Error('não deveria pedir aprovação'); } }
  });
}

test('search_project aceita alternativas e devolve contexto ao redor do match', async () => {
  const source = Array.from({ length: 40 }, (_, i) => `linha ${i + 1}`).join('\n') + '\nfunction renderTerrain() { return "grass"; }\n';
  const store = {
    summary: () => ({ writable: true }),
    search: async query => query === 'renderTerrain' ? [{ path: 'src/game.js', line: 41, text: 'function renderTerrain()' }] : [],
    readText: async () => source
  };
  const result = await executorWith(store).execute({ function: {
    name: 'search_project', arguments: JSON.stringify({ query: 'drawWorld|renderTerrain|biome' })
  }});
  assert.equal(result.ok, true);
  assert.equal(result.queries.length, 3);
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].context, /renderTerrain/);
});

test('read_project_file limita a leitura mesmo se o modelo pedir o arquivo inteiro', async () => {
  const source = Array.from({ length: 1000 }, (_, i) => `linha ${i + 1}`).join('\n');
  const store = { summary: () => ({ writable: true }), readText: async () => source };
  const result = await executorWith(store).execute({ function: {
    name: 'read_project_file', arguments: JSON.stringify({ path: 'index.html', start_line: 100, end_line: 900 })
  }});
  assert.equal(result.ok, true);
  assert.equal(result.startLine, 100);
  assert.equal(result.endLine, 319);
  assert.equal(result.nextStartLine, 320);
});

test('modo full executa verificação automática sem pedir aprovação', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-auto-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  const store = { summary: () => ({ writable: true }), rootPath: () => root };
  const result = await executorWith(store, 'full').execute({ function: {
    name: 'run_project_check', arguments: JSON.stringify({ check: 'auto' })
  }});
  assert.equal(result.ok, true);
  assert.equal(result.detectedCheck, 'test');
});

test('auto prefere check claramente agregador a um test mais limitado', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-aggregate-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test',
    check: 'node --check index.js && node --test'
  } }));
  await fs.writeFile(path.join(root, 'index.js'), 'export const ok = true;\n');
  const store = { summary: () => ({ writable: true }), rootPath: () => root };
  const result = await executorWith(store, 'full').execute({ function: {
    name: 'run_project_check', arguments: JSON.stringify({ check: 'auto' })
  } });
  assert.equal(result.ok, true);
  assert.equal(result.detectedCheck, 'check');
  assert.match(result.command, /npm(?:\.cmd)? run check/);
});

test('auto não promove check nominal sem sinais de agregação', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-narrow-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test',
    check: 'node --check index.js'
  } }));
  await fs.writeFile(path.join(root, 'smoke.test.js'), 'import test from "node:test"; test("ok", () => {});\n');
  const store = { summary: () => ({ writable: true }), rootPath: () => root };
  const result = await executorWith(store, 'full').execute({ function: {
    name: 'run_project_check', arguments: JSON.stringify({ check: 'auto' })
  } });
  assert.equal(result.ok, true);
  assert.equal(result.detectedCheck, 'test');
});
