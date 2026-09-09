import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/project-store.js';
import { PermissionStore, ApprovalManager } from '../src/permissions.js';
import { ProjectToolExecutor } from '../src/project-tools.js';

function batchCall(files) {
  return {
    type: 'function',
    function: {
      name: 'write_project_files',
      arguments: JSON.stringify({ files })
    }
  };
}

test('write_project_files grava e confirma HTML/CSS/JS no projeto real', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-batch-write-'));
  const dataDir = path.join(root, 'data');
  const projectDir = path.join(root, 'TESTE');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const projectStore = await new ProjectStore(dataDir).init();
  await projectStore.openPath(projectDir);
  const permissionStore = await new PermissionStore(dataDir).init();
  await permissionStore.setMode('full');
  const executor = new ProjectToolExecutor({
    projectStore,
    permissionStore,
    approvalManager: new ApprovalManager({ timeoutMs: 1000 })
  });

  const files = [
    { path: 'index.html', content: '<!doctype html><html><body><main>Genesis</main><script src="script.js"></script></body></html>' },
    { path: 'styles.css', content: 'body { font-family: sans-serif; }' },
    { path: 'script.js', content: 'const ready = true;\nconsole.log(ready);' }
  ];

  const result = await executor.execute(batchCall(files), {
    conversationId: 'batch-project-write',
    onEvent: () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification, 'batch_read_after_write');
  assert.deepEqual(result.paths, ['index.html', 'styles.css', 'script.js']);
  for (const file of files) {
    assert.equal(await fs.readFile(path.join(projectDir, file.path), 'utf8'), file.content);
  }
});

test('write_project_files restaura o estado anterior se um arquivo falhar', async () => {
  const state = new Map([['existing.txt', 'conteúdo original']]);
  let writes = 0;
  const projectStore = {
    summary: () => ({ writable: true }),
    async readText(relativePath) {
      if (!state.has(relativePath)) {
        throw Object.assign(new Error('arquivo ausente'), { code: 'project_path_not_found' });
      }
      return state.get(relativePath);
    },
    async writeText(relativePath, content) {
      writes += 1;
      if (relativePath === 'styles.css') {
        throw Object.assign(new Error('falha simulada'), { code: 'simulated_write_failure' });
      }
      state.set(relativePath, String(content));
    },
    async deletePath(relativePath) {
      state.delete(relativePath);
    }
  };
  const executor = new ProjectToolExecutor({
    projectStore,
    permissionStore: { mode: 'full' },
    approvalManager: new ApprovalManager({ timeoutMs: 1000 })
  });

  const result = await executor.execute(batchCall([
    { path: 'existing.txt', content: 'novo conteúdo' },
    { path: 'styles.css', content: 'body{}' },
    { path: 'script.js', content: 'console.log(1);' }
  ]), { conversationId: 'rollback-batch', onEvent: () => {} });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'simulated_write_failure');
  assert.equal(state.get('existing.txt'), 'conteúdo original');
  assert.equal(state.has('styles.css'), false);
  assert.equal(state.has('script.js'), false);
  assert.ok(writes >= 2);
});
