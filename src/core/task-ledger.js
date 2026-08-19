import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactSecrets } from './secret-sanitizer.js';

export const TASK_LEDGER_SCHEMA_VERSION = 1;

export const TASK_STATUSES = Object.freeze([
  'planned', 'running', 'completed', 'failed', 'cancelled'
]);

export const STEP_STATUSES = Object.freeze([
  'pending', 'running', 'completed', 'failed', 'skipped'
]);

export const TASK_LEDGER_LIMITS = Object.freeze({
  maxTasks: 200,
  maxStepsPerTask: 64,
  maxEventsPerTask: 500,
  maxEvidencePerTask: 128,
  maxUsageEntriesPerTask: 128,
  maxListItems: 200,
  maxText: 4_000,
  maxDetail: 2_000,
  maxMetaDepth: 4,
  maxMetaKeys: 40,
  maxMetaArray: 40
});

const TASK_STATUS_SET = new Set(TASK_STATUSES);
const STEP_STATUS_SET = new Set(STEP_STATUSES);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_STEP_STATUSES = new Set(['completed', 'failed', 'skipped']);
const EVENT_LEVELS = new Set(['debug', 'info', 'success', 'warning', 'error']);
const EVIDENCE_KINDS = new Set(['file', 'command', 'test', 'tool', 'decision', 'source', 'artifact', 'note']);

const now = () => new Date().toISOString();
const clone = value => structuredClone(value);

function ledgerError(message, code, status = 400) {
  return Object.assign(new Error(message), { name: 'TaskLedgerError', code, status });
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function makeLimits(options = {}) {
  return Object.freeze(Object.fromEntries(Object.entries(TASK_LEDGER_LIMITS).map(([key, fallback]) => [
    key,
    positiveInteger(options[key], fallback, 1, fallback * 10)
  ])));
}

function sensitiveKey(key) {
  const normalized = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'token'
    || normalized.includes('apikey')
    || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken')
    || normalized.includes('authorization')
    || normalized.includes('password')
    || normalized.includes('credential')
    || normalized.includes('cookie')
    || normalized === 'secret'
    || normalized.endsWith('secret');
}

export function sanitizeTaskText(value, maxLength = TASK_LEDGER_LIMITS.maxText) {
  const limit = positiveInteger(maxLength, TASK_LEDGER_LIMITS.maxText, 1, 100_000);
  const text = redactSecrets(String(value ?? ''))
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function sanitizeValue(value, limits, depth = 0, key = '') {
  if (sensitiveKey(key)) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeTaskText(value, limits.maxDetail);
  if (depth >= limits.maxMetaDepth) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxMetaArray).map(item => sanitizeValue(item, limits, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .slice(0, limits.maxMetaKeys)
      .map(([name, item]) => [sanitizeTaskText(name, 100), sanitizeValue(item, limits, depth + 1, name)]));
  }
  return sanitizeTaskText(value, limits.maxDetail);
}

function safeId(value, fallback = null) {
  const id = sanitizeTaskText(value, 160).replace(/\s+/g, ' ');
  return id || fallback;
}

function stringList(value, { limit, itemLimit }) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map(item => sanitizeTaskText(item, itemLimit))
    .filter(Boolean);
}

function normalizedContract(value = {}, limits) {
  const objective = sanitizeTaskText(value.objective ?? value.goal ?? value.summary, limits.maxText);
  if (!objective) throw ledgerError('O contrato da tarefa precisa de um objetivo.', 'task_objective_required');
  return {
    objective,
    deliverables: stringList(value.deliverables, { limit: 32, itemLimit: 500 }),
    constraints: stringList(value.constraints, { limit: 32, itemLimit: 500 }),
    acceptanceCriteria: stringList(value.acceptanceCriteria ?? value.acceptance_criteria, { limit: 32, itemLimit: 500 }),
    permissions: stringList(value.permissions, { limit: 16, itemLimit: 300 }),
    scope: sanitizeTaskText(value.scope, 1_000) || null
  };
}

function normalizedSteps(values, limits) {
  if (!Array.isArray(values)) return [];
  if (values.length > limits.maxStepsPerTask) {
    throw ledgerError(`A tarefa excede o limite de ${limits.maxStepsPerTask} etapas.`, 'task_step_limit');
  }
  const steps = values.map((value, index) => {
    const label = sanitizeTaskText(value?.label ?? value?.title, 240);
    if (!label) throw ledgerError(`A etapa ${index + 1} precisa de um nome.`, 'task_step_label_required');
    const status = STEP_STATUS_SET.has(value?.status) ? value.status : 'pending';
    return {
      id: safeId(value?.id, `step-${index + 1}`),
      index: index + 1,
      label,
      goal: sanitizeTaskText(value?.goal ?? value?.description, 1_200) || null,
      acceptanceCriteria: stringList(value?.acceptanceCriteria ?? value?.acceptance_criteria, { limit: 12, itemLimit: 400 }),
      status,
      startedAt: status === 'running' ? now() : null,
      completedAt: TERMINAL_STEP_STATUSES.has(status) ? now() : null,
      detail: null
    };
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length) {
    throw ledgerError('As etapas precisam de identificadores únicos.', 'duplicate_task_step_id');
  }
  if (steps.filter(step => step.status === 'running').length > 1) {
    throw ledgerError('Somente uma etapa pode começar em execução.', 'task_step_conflict', 409);
  }
  return steps;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    requestCount: 0,
    reportedRequests: 0,
    estimatedRequests: 0,
    unknownRequests: 0,
    entries: []
  };
}

function emptyState() {
  return {
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    updatedAt: null,
    tasks: []
  };
}

function safeMetric(value, maximum = 1_000_000_000_000) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(0, number)) : 0;
}

function addMetric(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, safeMetric(left, Number.MAX_SAFE_INTEGER) + safeMetric(right, Number.MAX_SAFE_INTEGER));
}

function taskSummary(task) {
  const completedSteps = task.steps.filter(step => step.status === 'completed').length;
  const failedSteps = task.steps.filter(step => step.status === 'failed').length;
  const skippedSteps = task.steps.filter(step => step.status === 'skipped').length;
  const terminalSteps = task.steps.filter(step => TERMINAL_STEP_STATUSES.has(step.status)).length;
  const { entries, ...usage } = task.usage;
  return {
    id: task.id,
    conversationId: task.conversationId,
    projectId: task.projectId,
    intent: task.intent,
    mode: task.mode,
    status: task.status,
    objective: task.contract.objective,
    stepCount: task.steps.length,
    completedSteps,
    failedSteps,
    skippedSteps,
    terminalSteps,
    eventCount: task.events.length,
    evidenceCount: task.evidence.length,
    usage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    failedAt: task.failedAt
  };
}

export class TaskLedgerStore {
  constructor(dataDir = path.resolve('.genesis'), options = {}) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'tasks.json');
    this.limits = makeLimits(options);
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed?.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) {
        throw ledgerError('O arquivo de tarefas possui um formato incompatível.', 'task_ledger_incompatible', 500);
      }
      this.state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.name === 'SyntaxError') throw ledgerError('O arquivo de tarefas está corrompido.', 'task_ledger_corrupt', 500);
        throw error;
      }
      await this.persist();
    }
    return this;
  }

  persist() {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      const temporary = path.join(this.dataDir, `.tasks.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    return this.writeQueue;
  }

  _task(taskId) {
    const id = safeId(taskId);
    const task = this.state.tasks.find(item => item.id === id);
    if (!task) throw ledgerError('Tarefa não encontrada.', 'task_not_found', 404);
    return task;
  }

  _assertMutable(task) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw ledgerError('A tarefa já está encerrada e não pode ser alterada.', 'task_already_terminal', 409);
    }
  }

  _touch(task, timestamp = now()) {
    task.updatedAt = timestamp;
    this.state.updatedAt = timestamp;
  }

  _trim(values, maximum) {
    if (values.length > maximum) values.splice(0, values.length - maximum);
  }

  _pushEvent(task, input = {}, timestamp = now()) {
    const event = {
      id: crypto.randomUUID(),
      type: safeId(input.type, 'task.event'),
      level: EVENT_LEVELS.has(input.level) ? input.level : 'info',
      title: sanitizeTaskText(input.title || 'Evento da tarefa', 240),
      detail: sanitizeTaskText(input.detail, this.limits.maxDetail),
      stepId: safeId(input.stepId),
      meta: sanitizeValue(input.meta || {}, this.limits),
      timestamp
    };
    task.events.push(event);
    this._trim(task.events, this.limits.maxEventsPerTask);
    this._touch(task, timestamp);
    return event;
  }

  _ensureCapacity() {
    if (this.state.tasks.length < this.limits.maxTasks) return;
    const removable = this.state.tasks
      .filter(task => TERMINAL_TASK_STATUSES.has(task.status))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
    if (!removable) throw ledgerError('O ledger atingiu o limite de tarefas ativas.', 'task_ledger_capacity', 409);
    this.state.tasks = this.state.tasks.filter(task => task.id !== removable.id);
  }

  async createTask(input = {}) {
    this._ensureCapacity();
    const timestamp = now();
    const requestedStatus = TASK_STATUS_SET.has(input.status) ? input.status : 'running';
    if (TERMINAL_TASK_STATUSES.has(requestedStatus)) {
      throw ledgerError('Uma tarefa nova não pode começar encerrada.', 'invalid_initial_task_status');
    }
    const task = {
      id: safeId(input.id, crypto.randomUUID()),
      conversationId: safeId(input.conversationId),
      projectId: safeId(input.projectId),
      intent: safeId(input.intent, 'CHAT'),
      mode: safeId(input.mode, 'balanced'),
      status: requestedStatus,
      contract: normalizedContract(input.contract || input, this.limits),
      steps: normalizedSteps(input.steps, this.limits),
      events: [],
      evidence: [],
      usage: emptyUsage(),
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: requestedStatus === 'running' ? timestamp : null,
      completedAt: null,
      failedAt: null,
      result: null,
      failure: null
    };
    if (this.state.tasks.some(item => item.id === task.id)) {
      throw ledgerError('Já existe uma tarefa com este identificador.', 'duplicate_task_id', 409);
    }
    this._pushEvent(task, {
      type: 'task.created',
      title: requestedStatus === 'running' ? 'Tarefa iniciada' : 'Tarefa planejada',
      detail: task.contract.objective
    }, timestamp);
    this.state.tasks.push(task);
    this._touch(task, timestamp);
    await this.persist();
    return clone(task);
  }

  async startTask(taskId) {
    const task = this._task(taskId);
    this._assertMutable(task);
    if (task.status === 'running') return clone(task);
    const timestamp = now();
    task.status = 'running';
    task.startedAt ||= timestamp;
    this._pushEvent(task, { type: 'task.started', title: 'Execução iniciada' }, timestamp);
    await this.persist();
    return clone(task);
  }

  async updateStep(taskId, stepRef, changes = {}) {
    const task = this._task(taskId);
    this._assertMutable(task);
    const step = typeof stepRef === 'number'
      ? task.steps.find(item => item.index === stepRef)
      : task.steps.find(item => item.id === safeId(stepRef));
    if (!step) throw ledgerError('Etapa não encontrada.', 'task_step_not_found', 404);
    const status = changes.status;
    if (!STEP_STATUS_SET.has(status)) throw ledgerError('Estado de etapa inválido.', 'invalid_task_step_status');
    if (status === 'running') {
      const running = task.steps.find(item => item.status === 'running' && item.id !== step.id);
      if (running) throw ledgerError('Outra etapa já está em execução.', 'task_step_conflict', 409);
    }
    const timestamp = now();
    step.status = status;
    step.detail = sanitizeTaskText(changes.detail, this.limits.maxDetail) || null;
    if (status === 'running') step.startedAt ||= timestamp;
    if (TERMINAL_STEP_STATUSES.has(status)) {
      step.startedAt ||= timestamp;
      step.completedAt = timestamp;
    } else {
      step.completedAt = null;
    }
    if (task.status === 'planned') {
      task.status = 'running';
      task.startedAt ||= timestamp;
    }
    this._pushEvent(task, {
      type: `task.step.${status}`,
      level: status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'info',
      title: `${step.label}: ${status}`,
      detail: step.detail,
      stepId: step.id,
      meta: changes.meta || {}
    }, timestamp);
    await this.persist();
    return clone(step);
  }

  async appendEvent(taskId, input = {}) {
    const task = this._task(taskId);
    this._assertMutable(task);
    const event = this._pushEvent(task, input);
    await this.persist();
    return clone(event);
  }

  async addEvidence(taskId, input = {}) {
    const task = this._task(taskId);
    this._assertMutable(task);
    const timestamp = now();
    const evidence = {
      id: crypto.randomUUID(),
      kind: EVIDENCE_KINDS.has(input.kind) ? input.kind : 'note',
      title: sanitizeTaskText(input.title || 'Evidência', 240),
      summary: sanitizeTaskText(input.summary ?? input.detail, this.limits.maxDetail),
      stepId: safeId(input.stepId),
      source: sanitizeValue(input.source || {}, this.limits),
      meta: sanitizeValue(input.meta || {}, this.limits),
      timestamp
    };
    task.evidence.push(evidence);
    this._trim(task.evidence, this.limits.maxEvidencePerTask);
    this._pushEvent(task, {
      type: 'task.evidence.added', title: evidence.title, detail: evidence.summary,
      stepId: evidence.stepId, meta: { evidenceId: evidence.id, kind: evidence.kind }
    }, timestamp);
    await this.persist();
    return clone(evidence);
  }

  async recordUsage(taskId, input = {}) {
    const task = this._task(taskId);
    this._assertMutable(task);
    const timestamp = now();
    const inputTokens = safeMetric(input.inputTokens ?? input.prompt_tokens);
    const outputTokens = safeMetric(input.outputTokens ?? input.completion_tokens);
    const reportedTotal = safeMetric(input.totalTokens ?? input.total_tokens);
    const totalTokens = reportedTotal || inputTokens + outputTokens;
    const requestCount = safeMetric(input.requestCount ?? 1, 1_000_000);
    const accuracy = ['reported', 'estimated', 'mixed', 'local', 'unknown'].includes(input.accuracy) ? input.accuracy : 'unknown';
    const entry = {
      id: crypto.randomUUID(),
      providerId: safeId(input.providerId),
      model: safeId(input.model),
      kind: safeId(input.kind, 'completion'),
      status: safeId(input.status, 'completed'),
      inputTokens,
      outputTokens,
      totalTokens,
      cost: safeMetric(input.cost, 1_000_000_000),
      requestCount,
      latencyMs: safeMetric(input.latencyMs, 86_400_000),
      accuracy,
      timestamp
    };
    const usage = task.usage;
    usage.inputTokens = addMetric(usage.inputTokens, entry.inputTokens);
    usage.outputTokens = addMetric(usage.outputTokens, entry.outputTokens);
    usage.totalTokens = addMetric(usage.totalTokens, entry.totalTokens);
    usage.cost = addMetric(usage.cost, entry.cost);
    usage.requestCount = addMetric(usage.requestCount, entry.requestCount);
    usage.reportedRequests = addMetric(usage.reportedRequests, safeMetric(input.reportedRequests ?? (accuracy === 'reported' ? requestCount : 0)));
    usage.estimatedRequests = addMetric(usage.estimatedRequests, safeMetric(input.estimatedRequests ?? (accuracy === 'estimated' ? requestCount : 0)));
    usage.unknownRequests = addMetric(usage.unknownRequests, safeMetric(input.unknownRequests ?? (accuracy === 'unknown' ? requestCount : 0)));
    usage.entries.push(entry);
    this._trim(usage.entries, this.limits.maxUsageEntriesPerTask);
    this._pushEvent(task, {
      type: 'task.usage.recorded',
      title: 'Uso registrado',
      detail: `${entry.inputTokens} enviados · ${entry.outputTokens} recebidos · ${entry.requestCount} requisição(ões)`,
      meta: { usageEntryId: entry.id, model: entry.model, accuracy: entry.accuracy }
    }, timestamp);
    await this.persist();
    return clone(usage);
  }

  async completeTask(taskId, result = {}, options = {}) {
    const task = this._task(taskId);
    this._assertMutable(task);
    const unfinished = task.steps.filter(step => !TERMINAL_STEP_STATUSES.has(step.status));
    if (unfinished.length && options.allowIncomplete !== true) {
      throw ledgerError(`Ainda existem ${unfinished.length} etapas pendentes.`, 'task_steps_incomplete', 409);
    }
    const timestamp = now();
    task.status = 'completed';
    task.completedAt = timestamp;
    task.result = {
      summary: sanitizeTaskText(result.summary ?? result.message, this.limits.maxText),
      artifacts: stringList(result.artifacts, { limit: 32, itemLimit: 500 }),
      verification: sanitizeValue(result.verification || {}, this.limits)
    };
    this._pushEvent(task, {
      type: 'task.completed', level: 'success', title: 'Tarefa concluída', detail: task.result.summary,
      meta: { verified: result.verified === true }
    }, timestamp);
    await this.persist();
    return clone(task);
  }

  async failTask(taskId, failure = {}) {
    const task = this._task(taskId);
    this._assertMutable(task);
    const timestamp = now();
    const step = failure.stepId
      ? task.steps.find(item => item.id === safeId(failure.stepId))
      : task.steps.find(item => item.status === 'running');
    if (step && !TERMINAL_STEP_STATUSES.has(step.status)) {
      step.status = 'failed';
      step.startedAt ||= timestamp;
      step.completedAt = timestamp;
      step.detail = sanitizeTaskText(failure.message, this.limits.maxDetail) || null;
    }
    for (const pending of task.steps.filter(item => item.status === 'pending')) {
      pending.status = 'skipped';
      pending.completedAt = timestamp;
      pending.detail = 'Etapa não executada porque a tarefa foi encerrada.';
    }
    task.status = 'failed';
    task.failedAt = timestamp;
    task.failure = {
      code: safeId(failure.code, 'task_failed'),
      message: sanitizeTaskText(failure.message || 'A tarefa não foi concluída.', this.limits.maxDetail),
      stage: safeId(failure.stage),
      stepId: step?.id || safeId(failure.stepId),
      retryable: failure.retryable === true,
      meta: sanitizeValue(failure.meta || {}, this.limits)
    };
    this._pushEvent(task, {
      type: 'task.failed', level: 'error', title: 'Tarefa não concluída', detail: task.failure.message,
      stepId: task.failure.stepId, meta: { code: task.failure.code, retryable: task.failure.retryable }
    }, timestamp);
    await this.persist();
    return clone(task);
  }

  async cancelTask(taskId, detail = '') {
    const task = this._task(taskId);
    this._assertMutable(task);
    const timestamp = now();
    for (const step of task.steps.filter(item => ['pending', 'running'].includes(item.status))) {
      const wasRunning = step.status === 'running';
      step.status = 'skipped';
      if (wasRunning) step.startedAt ||= timestamp;
      step.completedAt = timestamp;
      step.detail = sanitizeTaskText(detail, this.limits.maxDetail) || 'Etapa cancelada.';
    }
    task.status = 'cancelled';
    task.completedAt = timestamp;
    this._pushEvent(task, {
      type: 'task.cancelled', level: 'warning', title: 'Tarefa cancelada', detail
    }, timestamp);
    await this.persist();
    return clone(task);
  }

  getTask(taskId) {
    return clone(this._task(taskId));
  }

  listTasks(filters = {}) {
    const limit = positiveInteger(filters.limit, 50, 1, this.limits.maxListItems);
    const status = TASK_STATUS_SET.has(filters.status) ? filters.status : null;
    const conversationId = safeId(filters.conversationId);
    const projectId = safeId(filters.projectId);
    return this.state.tasks
      .filter(task => !status || task.status === status)
      .filter(task => !conversationId || task.conversationId === conversationId)
      .filter(task => !projectId || task.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(task => filters.full === true ? clone(task) : clone(taskSummary(task)));
  }

  publicSnapshot(options = {}) {
    const tasks = this.listTasks({ ...options, full: false });
    return {
      schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
      updatedAt: this.state.updatedAt,
      count: this.state.tasks.length,
      activeCount: this.state.tasks.filter(task => !TERMINAL_TASK_STATUSES.has(task.status)).length,
      tasks
    };
  }

  snapshot(options = {}) {
    return this.publicSnapshot(options);
  }

  async flush() {
    await this.writeQueue;
  }
}
