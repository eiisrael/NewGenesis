import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/project-store.js';
import { PermissionStore, ApprovalManager } from '../src/permissions.js';
import { ProjectToolExecutor } from '../src/project-tools.js';

test('solicita aprovação antes de gravar e respeita aprovar ou negar', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-permissions-'));
  const dataDirectory = path.join(directory, 'data');
  const projectDirectory = path.join(directory, 'project');
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'README.md'), '# Antes\n');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const projectStore = await new ProjectStore(dataDirectory).init();
  await projectStore.openPath(projectDirectory);
  const permissionStore = await new PermissionStore(dataDirectory).init();
  const approvalManager = new ApprovalManager({ timeoutMs: 1000 });
  const executor = new ProjectToolExecutor({ projectStore, permissionStore, approvalManager });
  const events = [];
  const call = content => executor.execute({
    function: { name: 'write_project_file', arguments: JSON.stringify({ path: 'README.md', content }) }
  }, { conversationId: 'conversation', onEvent: (event, payload) => events.push({ event, payload }) });

  const approved = call('# Depois\n');
  await new Promise(resolve => setImmediate(resolve));
  const firstApproval = events.find(item => item.event === 'approval_required').payload.approvalId;
  approvalManager.decide(firstApproval, 'approve');
  assert.equal((await approved).ok, true);
  assert.equal(await fs.readFile(path.join(projectDirectory, 'README.md'), 'utf8'), '# Depois\n');

  events.length = 0;
  const denied = call('# Não deve gravar\n');
  await new Promise(resolve => setImmediate(resolve));
  approvalManager.decide(events.find(item => item.event === 'approval_required').payload.approvalId, 'deny');
  assert.equal((await denied).denied, true);
  assert.equal(await fs.readFile(path.join(projectDirectory, 'README.md'), 'utf8'), '# Depois\n');
});

test('permissão completa executa automaticamente sem remover o isolamento', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-permissions-full-'));
  const dataDirectory = path.join(directory, 'data');
  const projectDirectory = path.join(directory, 'project');
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'README.md'), '# Projeto\n');
  await fs.writeFile(path.join(projectDirectory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const projectStore = await new ProjectStore(dataDirectory).init();
  await projectStore.openPath(projectDirectory);
  const permissionStore = await new PermissionStore(dataDirectory).init();
  await permissionStore.setMode('full');
  const approvalManager = new ApprovalManager({ timeoutMs: 1000 });
  const executor = new ProjectToolExecutor({ projectStore, permissionStore, approvalManager });
  const result = await executor.execute({ function: {
    name: 'create_project_directory', arguments: JSON.stringify({ path: 'src/components' })
  } }, { conversationId: 'conversation' });
  assert.equal(result.ok, true);
  assert.equal(await fs.stat(path.join(projectDirectory, 'src', 'components')).then(stat => stat.isDirectory()), true);

  const events = [];
  const command = executor.execute({ function: {
    name: 'run_project_check', arguments: JSON.stringify({ check: 'tests' })
  } }, { conversationId: 'conversation', onEvent: (event, payload) => events.push({ event, payload }) });
  for (let attempt = 0; attempt < 30 && !events.some(item => item.event === 'approval_required'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const approval = events.find(item => item.event === 'approval_required');
  assert.ok(approval);
  assert.match(approval.payload.detail, /npm test/);
  approvalManager.decide(approval.payload.approvalId, 'deny');
  assert.equal((await command).denied, true);
});
