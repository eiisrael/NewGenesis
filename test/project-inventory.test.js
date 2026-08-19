import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_LIMITS, ProjectStore } from '../src/project-store.js';

async function fixture(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dataDirectory = path.join(directory, 'data');
  const projectDirectory = path.join(directory, 'workspace');
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.mkdir(path.join(projectDirectory, 'src'), { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { dataDirectory, projectDirectory };
}

test('registra e expõe a cobertura parcial do inventário por motivo', async t => {
  const { dataDirectory, projectDirectory } = await fixture(t, 'genesis-inventory-');
  await fs.mkdir(path.join(projectDirectory, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'README.md'), '# Projeto\n');
  await fs.writeFile(path.join(projectDirectory, 'src', 'app.js'), 'export const ready = true;\n');
  await fs.writeFile(path.join(projectDirectory, '.env'), 'TOKEN=segredo\n');
  await fs.writeFile(path.join(projectDirectory, 'sprite.png'), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(projectDirectory, 'binary.txt'), Buffer.from([65, 0, 66]));
  await fs.writeFile(path.join(projectDirectory, 'huge.js'), 'x'.repeat(PROJECT_LIMITS.maxFileBytes + 1));
  await fs.writeFile(path.join(projectDirectory, 'node_modules', 'dependency.js'), 'ignored();\n');

  const store = await new ProjectStore(dataDirectory).init();
  const summary = await store.openPath(projectDirectory);
  const inventory = summary.inventory;

  assert.equal(inventory.scope, 'partial');
  assert.equal(inventory.complete, false);
  assert.equal(inventory.source, 'native-folder');
  assert.equal(inventory.included.count, 2);
  assert.equal(inventory.included.reason, 'compatible_text');
  assert.deepEqual(inventory.included.paths, ['README.md', 'src/app.js']);
  assert.equal(inventory.ignored.count, 5);
  assert.deepEqual(inventory.ignored.byReason, {
    sensitive_path: 1,
    invalid_text: 1,
    file_too_large: 1,
    ignored_directory: 1,
    unsupported_format: 1
  });
  assert.equal(inventory.traversal.stopped, false);
  assert.match(inventory.note, /não representam uma análise completa/i);
  assert.equal(summary.files.some(file => file.path === '.env'), false);

  const profile = store.intelligence();
  assert.deepEqual(profile.inventory.ignored.byReason, inventory.ignored.byReason);
  assert.deepEqual(profile.inventory.included.paths, inventory.included.paths);

  const markdown = store.localReport('markdown');
  assert.match(markdown, /Cobertura do inventário/);
  assert.match(markdown, /escopo parcial/i);
  assert.match(markdown, /arquivo sensível protegido \(sensitive_path\): 1/);
  assert.match(markdown, /não representam uma análise completa/i);

  const bash = store.localReport('bash');
  assert.match(bash, /readonly PROJECT_INVENTORY_SCOPE='partial'/);
  assert.match(bash, /readonly PROJECT_INVENTORY_COMPLETE=false/);
  assert.match(bash, /readonly PROJECT_INCLUDED_FILES=2/);
  assert.match(bash, /readonly PROJECT_IGNORED_ENTRIES=5/);

  const jsonReport = store.localReport('json');
  const json = JSON.parse(jsonReport.replace(/^```json\n/, '').replace(/\n```$/, ''));
  assert.equal(json.inventory.complete, false);
  assert.equal(json.inventory.ignored.byReason.unsupported_format, 1);

  const restored = await new ProjectStore(dataDirectory).init();
  assert.deepEqual(restored.summary().inventory, inventory);
});

test('writeText e replaceText atualizam somente o snapshot do arquivo', async t => {
  const { dataDirectory, projectDirectory } = await fixture(t, 'genesis-incremental-');
  await fs.writeFile(path.join(projectDirectory, 'src', 'app.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(projectDirectory, 'sprite.png'), Buffer.from([137, 80, 78, 71]));

  const store = await new ProjectStore(dataDirectory).init();
  const opened = await store.openPath(projectDirectory);
  const projectId = opened.id;
  const openedAt = opened.openedAt;
  const scannedAt = opened.inventory.scannedAt;
  store.refresh = async () => { throw new Error('writeText não deve executar varredura completa'); };

  await store.writeText('src/app.js', 'export const value = 2;\n');
  assert.equal(await store.replaceText('src/app.js', 'value = 2', 'value = 3'), 1);
  await store.writeText('src/extra.ts', 'export const extra: boolean = true;\n');

  const summary = store.summary();
  assert.equal(summary.id, projectId);
  assert.equal(summary.openedAt, openedAt);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.inventory.included.count, 2);
  assert.deepEqual(summary.inventory.included.paths, ['src/app.js', 'src/extra.ts']);
  assert.equal(summary.inventory.visitedEntries, opened.inventory.visitedEntries + 1);
  assert.equal(summary.inventory.ignored.byReason.unsupported_format, 1);
  assert.equal(summary.inventory.scannedAt, scannedAt);
  assert.ok(summary.technologies.includes('TypeScript'));
  assert.match(store.contextFor('value').text, /Inventário parcial incluído/);
  assert.match(await fs.readFile(path.join(projectDirectory, 'src', 'app.js'), 'utf8'), /value = 3/);

  const restored = await new ProjectStore(dataDirectory).init();
  assert.equal(restored.summary().fileCount, 2);
  assert.deepEqual(restored.summary().inventory.included.paths, ['src/app.js', 'src/extra.ts']);
  assert.match(restored.contextFor('extra').text, /extra: boolean/);
});
