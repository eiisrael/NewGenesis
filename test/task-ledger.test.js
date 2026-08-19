import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TaskLedgerStore, sanitizeTaskText } from '../src/core/task-ledger.js';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-task-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, '.genesis');
  const store = await new TaskLedgerStore(dataDir, options).init();
  return { root, dataDir, store };
}

const contract = {
  objective: 'Analisar o projeto e produzir um relatório verificável.',
  deliverables: ['Relatório técnico'],
  constraints: ['Não modificar arquivos'],
  acceptanceCriteria: ['Arquivos centrais identificados'],
  permissions: ['Leitura local']
};

const steps = [
  { id: 'inspect', label: 'Inspecionar projeto', goal: 'Coletar evidências locais.' },
  { id: 'report', label: 'Gerar relatório', goal: 'Sintetizar os resultados.' }
];

test('persiste contrato, etapas e estado em .genesis/tasks.json', async t => {
  const { dataDir, store } = await fixture(t);
  const task = await store.createTask({
    conversationId: 'conversation-1', projectId: 'project-1', intent: 'ANALYSIS', mode: 'reasoning',
    contract, steps
  });

  assert.equal(task.status, 'running');
  assert.equal(task.contract.objective, contract.objective);
  assert.deepEqual(task.steps.map(step => step.status), ['pending', 'pending']);

  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.equal(persisted.tasks[0].id, task.id);
  assert.equal(persisted.tasks[0].contract.deliverables[0], 'Relatório técnico');

  const restored = await new TaskLedgerStore(dataDir).init();
  assert.deepEqual(restored.getTask(task.id), store.getTask(task.id));
});

test('registra ciclo de etapas, eventos, evidências, uso e conclusão', async t => {
  const { store } = await fixture(t);
  const task = await store.createTask({ contract, steps });

  await store.updateStep(task.id, 'inspect', { status: 'running', detail: 'Lendo metadados.' });
  await store.addEvidence(task.id, {
    kind: 'file', title: 'Manifesto encontrado', summary: 'package.json define o projeto.',
    stepId: 'inspect', source: { path: 'package.json', line: 1 }
  });
  await store.recordUsage(task.id, {
    providerId: 'openrouter', model: 'example:free', inputTokens: 3200, outputTokens: 400,
    totalTokens: 3600, requestCount: 1, accuracy: 'reported', latencyMs: 1200
  });
  await store.updateStep(task.id, 'inspect', { status: 'completed' });
  await store.updateStep(task.id, 2, { status: 'completed', detail: 'Relatório preparado.' });
  const completed = await store.completeTask(task.id, {
    summary: 'Relatório concluído.', artifacts: ['ASTRAEON_REPORT.md'],
    verification: { passed: true, checks: ['estrutura'] }, verified: true
  });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.steps.every(step => step.status === 'completed'), true);
  assert.equal(completed.evidence.length, 1);
  assert.equal(completed.usage.inputTokens, 3200);
  assert.equal(completed.usage.totalTokens, 3600);
  assert.equal(completed.usage.reportedRequests, 1);
  assert.match(completed.events.at(-1).type, /task\.completed/);
  await assert.rejects(store.appendEvent(task.id, { type: 'late' }), error => error.code === 'task_already_terminal');
});

test('impede conclusão falsa e registra falha associada à etapa', async t => {
  const { store } = await fixture(t);
  const task = await store.createTask({ contract, steps });
  await store.updateStep(task.id, 'inspect', { status: 'running' });

  await assert.rejects(
    store.completeTask(task.id, { summary: 'Incompleto.' }),
    error => error.code === 'task_steps_incomplete'
  );

  const failed = await store.failTask(task.id, {
    code: 'provider_timeout', message: 'A rota excedeu o tempo.', stage: 'executor',
    stepId: 'inspect', retryable: true
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.steps[0].status, 'failed');
  assert.equal(failed.failure.code, 'provider_timeout');
  assert.equal(failed.failure.retryable, true);
});

test('rejeita etapas ambíguas antes de persistir a tarefa', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.createTask({
    contract,
    steps: [{ id: 'same', label: 'Uma' }, { id: 'same', label: 'Duas' }]
  }), error => error.code === 'duplicate_task_step_id');
  await assert.rejects(store.createTask({
    contract,
    steps: [{ label: 'Uma', status: 'running' }, { label: 'Duas', status: 'running' }]
  }), error => error.code === 'task_step_conflict');
  assert.equal(store.publicSnapshot().count, 0);
});

test('sanitiza segredos, controles, metadados e limita retenção', async t => {
  const { store } = await fixture(t, {
    maxEventsPerTask: 4,
    maxEvidencePerTask: 2,
    maxUsageEntriesPerTask: 2,
    maxText: 80,
    maxDetail: 80
  });
  const task = await store.createTask({
    contract: { objective: `Inspecionar com API_KEY=segredo-super-longo ${'x'.repeat(200)}` }
  });
  for (let index = 0; index < 6; index += 1) {
    await store.appendEvent(task.id, {
      type: `event.${index}`, detail: `Bearer abcdefghijklmnopqrstuvwxyz.${index}`,
      meta: { apiKey: 'não-pode-vazar', nested: { password: 'também-não' } }
    });
  }
  for (let index = 0; index < 4; index += 1) {
    await store.addEvidence(task.id, {
      title: `Evidência ${index}`, summary: `sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890`,
      source: { authorization: 'Bearer segredo' }
    });
    await store.recordUsage(task.id, { model: `model-${index}:free`, inputTokens: 10, accuracy: 'estimated' });
  }

  const current = store.getTask(task.id);
  const serialized = JSON.stringify(current);
  assert.equal(current.events.length, 4);
  assert.equal(current.evidence.length, 2);
  assert.equal(current.usage.entries.length, 2);
  assert.equal(current.usage.inputTokens, 40);
  assert.doesNotMatch(serialized, /segredo-super|não-pode-vazar|também-não|abcdefghijklmnopqrstuvwxyz1234567890/);
  assert.match(serialized, /REDACTED/);
  assert.ok(current.contract.objective.length <= 80);
  assert.equal(sanitizeTaskText('a\u0000b'), 'ab');
  const prefixedSecrets = sanitizeTaskText([
    'API_KEY=plain-api-secret',
    'const DATABASE_PASSWORD = "database-password";',
    'const JWT_SECRET = "jwt-signing-secret";',
    'OPENROUTER_API_KEY = "custom-openrouter-secret";',
    'DATABASE_URL=postgres://admin:url-password@example.test/app'
  ].join('\n'));
  assert.doesNotMatch(prefixedSecrets, /plain-api-secret|database-password|jwt-signing-secret|custom-openrouter-secret|url-password/);
  assert.match(prefixedSecrets, /REDACTED/);
});

test('serializa escritas concorrentes e mantém JSON atômico válido', async t => {
  const { dataDir, store } = await fixture(t, { maxEventsPerTask: 100 });
  const task = await store.createTask({ contract });
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.appendEvent(task.id, {
    type: 'parallel.event', title: `Evento ${index}`
  })));
  await store.flush();

  const parsed = JSON.parse(await fs.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  const persisted = parsed.tasks.find(item => item.id === task.id);
  assert.equal(persisted.events.filter(event => event.type === 'parallel.event').length, 30);
  const temporaryFiles = (await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(temporaryFiles, []);
});

test('fornece listagem filtrada e snapshot público sem referências mutáveis', async t => {
  const { store } = await fixture(t);
  const first = await store.createTask({ conversationId: 'one', projectId: 'project-a', contract: { objective: 'Primeira' } });
  const second = await store.createTask({ conversationId: 'two', projectId: 'project-b', contract: { objective: 'Segunda' } });
  await store.failTask(first.id, { message: 'Falhou com segurança.' });

  const failed = store.listTasks({ status: 'failed' });
  assert.deepEqual(failed.map(task => task.id), [first.id]);
  assert.equal('events' in failed[0], false);
  assert.equal(store.listTasks({ projectId: 'project-b' })[0].id, second.id);

  const snapshot = store.publicSnapshot();
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.activeCount, 1);
  snapshot.tasks[0].objective = 'mutado externamente';
  assert.notEqual(store.listTasks()[0].objective, 'mutado externamente');
});

test('remove a tarefa terminal mais antiga ao atingir capacidade', async t => {
  const { store } = await fixture(t, { maxTasks: 2 });
  const first = await store.createTask({ contract: { objective: 'Primeira' } });
  await store.failTask(first.id, { message: 'Encerrada.' });
  const second = await store.createTask({ contract: { objective: 'Segunda' } });
  const third = await store.createTask({ contract: { objective: 'Terceira' } });

  assert.throws(() => store.getTask(first.id), error => error.code === 'task_not_found');
  assert.deepEqual(new Set(store.listTasks().map(task => task.id)), new Set([second.id, third.id]));
});
