import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'suprememind.js');

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`exit=${code}\nstdout=${stdout}\nstderr=${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'suprememind-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'database.js'), `
export function saveCustomer(customer) {
  return { ...customer, saved: true };
}
`);
  await fs.writeFile(path.join(root, 'src', 'customer.js'), `
import { saveCustomer } from './database.js';
export function createCustomer(name) {
  return saveCustomer({ name });
}
`);
  await fs.writeFile(path.join(root, 'README.md'), '# Customer registration and persistence\n');
  return root;
}

test('indexa, consulta e monta contexto', async () => {
  const root = await fixture();
  await run(['init'], root);
  const indexed = await run(['index'], root);
  assert.match(indexed.stdout, /arquivos/);

  const query = await run(['query', 'customer persistence'], root);
  assert.match(query.stdout, /customer\.js|database\.js/);

  const context = await run(['context', 'save customer data', '--budget', '2000'], root);
  assert.match(context.stdout, /Contexto Estrutural/);
  assert.match(context.stdout, /database\.js|customer\.js/);

  const state = JSON.parse(await fs.readFile(path.join(root, '.suprememind', 'index.json'), 'utf8'));
  assert.ok(state.stats.indexed >= 3);
  assert.ok(state.stats.symbols >= 2);
  assert.ok(state.stats.edges >= 1);
});

test('reutiliza índice e persiste memória', async () => {
  const root = await fixture();
  await run(['index'], root);
  await run(['update'], root);
  const state = JSON.parse(await fs.readFile(path.join(root, '.suprememind', 'index.json'), 'utf8'));
  assert.ok(state.stats.reused >= 1);

  await run([
    'remember',
    '--title', 'Customer persistence',
    '--content', 'database.js stores customer records',
    '--files', 'src/database.js',
    '--status', 'success'
  ], root);
  const recalled = await run(['recall', 'customer database'], root);
  assert.match(recalled.stdout, /Customer persistence/);
});

test('gera análise de impacto e Galaxy', async () => {
  const root = await fixture();
  await run(['index'], root);
  const impact = await run(['impact', 'src/database.js'], root);
  assert.match(impact.stdout, /src\/customer\.js/);

  await run(['graph', '--output', 'galaxy.html'], root);
  const html = await fs.readFile(path.join(root, 'galaxy.html'), 'utf8');
  assert.match(html, /SupremeMind Galaxy/);
});
