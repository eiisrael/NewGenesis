import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig, GENESIS_VERSION, isLoopbackHost } from './config.js';
import { GenesisStore } from './storage.js';
import { ContextEngine, estimateMessageTokens } from './core/context-engine.js';
import { GenesisOrchestrator } from './core/orchestrator.js';
import { ADULT_CONTENT_MESSAGE, FREE_POLICY, MODES, isAdultContent, normalizeMode } from './core/policy.js';
import { createImageProviders, createProviders } from './providers/index.js';
import { safeError } from './core/errors.js';
import { GenesisTelemetry } from './telemetry.js';
import { OpenRouterSettings, validateOpenRouterKey } from './openrouter-settings.js';
import { AttachmentStore } from './attachments.js';
import { ProjectStore } from './project-store.js';
import { PermissionStore, ApprovalManager } from './permissions.js';
import { ProjectToolExecutor, projectToolDefinitionsFor } from './project-tools.js';
import { pickProjectDirectory } from './native-folder-picker.js';
import { UserMemoryStore } from './user-memory.js';
import { SupremeMindIntegration } from './suprememind-integration.js';
import { createTaskContract } from './core/task-contract.js';
import { TaskLedgerStore } from './core/task-ledger.js';
import { createRuntimeShutdown } from './runtime-lifecycle.js';
import { VoiceRuntime } from './voice/voice-runtime.js';
import {
  LOCAL_CONTEXT_CAPABILITIES,
  WeatherService,
  extractRequestedPlace,
  formatTurnContext,
  resolveLocalContextResponse,
  sanitizeClientContext,
  sanitizeInputMetadata
} from './local-context.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CHAT_BODY_BYTES = 24 * 1024 * 1024;
const MAX_PROJECT_BODY_BYTES = 140 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const securityHeaders = {
  'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=(), payment=()'
};

function setSecurityHeaders(response) {
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  setSecurityHeaders(response);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    const error = new Error('Content-Type deve ser application/json.');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`Corpo da requisição excede ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('JSON inválido.');
    error.status = 400;
    throw error;
  }
}

async function readBuffer(request, { contentType, maxBytes }) {
  const type = String(request.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
  if (type !== contentType) {
    const error = new Error(`Content-Type deve ser ${contentType}.`);
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Corpo da requisição excede o limite permitido.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function assertTrustedMutation(request) {
  // Cabeçalho anti-CSRF emitido somente pela UI. Não é autenticação e nunca
  // autoriza exposição remota do servidor.
  if (request.headers['x-genesis-client'] !== 'web') {
    const error = new Error('Origem da requisição não autorizada.');
    error.status = 403;
    throw error;
  }
}

function assertLocalRequest(request) {
  const hostHeader = String(request.headers.host || '').trim();
  let target;
  try { target = new URL(`http://${hostHeader}`); }
  catch { target = null; }
  if (!target || !isLoopbackHost(target.hostname)) {
    const error = new Error('Host local não autorizado.');
    error.status = 403;
    error.code = 'untrusted_local_host';
    throw error;
  }

  const originHeader = String(request.headers.origin || '').trim();
  if (!originHeader) return;
  let origin;
  try { origin = new URL(originHeader); }
  catch { origin = null; }
  const sameTarget = origin
    && isLoopbackHost(origin.hostname)
    && origin.hostname.toLowerCase() === target.hostname.toLowerCase()
    && origin.port === target.port;
  if (!sameTarget) {
    const error = new Error('Origin local não autorizada.');
    error.status = 403;
    error.code = 'untrusted_local_origin';
    throw error;
  }
}

function sseStart(response) {
  setSecurityHeaders(response);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  response.write(': genesis-stream\n\n');
}

function sseSend(response, event, data) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function emitAgentEvent(telemetry, event, data, conversationId) {
  const common = { category: 'agent', conversationId, providerId: data.providerId || null, thought: true };
  if (event === 'attempt') {
    if (data.cacheHit === true) telemetry.recordCacheHit();
    else telemetry.recordCacheMiss();
    if (data.compactRetry === true) telemetry.recordRetry();
  }
  if (event === 'fallback') telemetry.recordFallback();
  if (event === 'task_contract') return telemetry.emit({
    ...common, type: 'agent.task.contract', title: 'Contrato da tarefa criado',
    detail: `${data.task?.kind || 'tarefa'} · ${data.task?.complexity || 'normal'} · ${data.task?.steps?.length || 0} etapas.`,
    meta: { task: data.task }
  });
  if (event === 'local_analysis') return telemetry.emit({
    ...common, type: 'agent.local.analysis', title: 'Análise local concluída', detail: data.message,
    level: 'success', meta: { taskId: data.taskId, projectFiles: data.projectFiles }
  });
  if (event === 'inference_start') return telemetry.emit({
    ...common, type: 'agent.inference.started', title: 'Requisição controlada',
    detail: `${data.model} · ${Number(data.estimatedInputTokens || 0).toLocaleString('pt-BR')} tokens estimados · ${data.toolsEnabled?.length || 0} ferramentas.`,
    meta: data
  });
  if (event === 'inference_complete') return telemetry.emit({
    ...common, type: 'agent.inference.completed', title: 'Requisição concluída',
    detail: `${data.model} · ${Math.round(data.latencyMs || 0)} ms · ${data.toolCallCount || 0} chamadas de ferramenta.`,
    level: 'success', meta: data
  });
  if (event === 'verification') return telemetry.emit({
    ...common, type: 'agent.verification', title: data.verification?.verified ? 'Entrega verificada' : 'Verificação parcial',
    detail: data.verification?.summary || 'Verificação local concluída.',
    level: data.verification?.status === 'failed' ? 'error' : data.verification?.status === 'partial' ? 'warning' : 'success',
    meta: data
  });
  if (event === 'route') return telemetry.emit({
    ...common, type: 'agent.route', title: 'Interpretando a tarefa', detail: data.message
  });
  if (event === 'attempt') return telemetry.emit({
    ...common, type: 'agent.attempt', title: 'Pensando',
    detail: `Selecionando uma rota gratuita compatível e preservando a memória canônica${data.compactRetry ? ' · contexto recomposto' : ''}.`,
    meta: { model: data.model, inputTokens: data.inputTokens, savedTokens: data.savedTokens, attempt: data.attempt, compactRetry: data.compactRetry, cacheHit: data.cacheHit === true }
  });
  if (event === 'compact') return telemetry.emit({
    ...common, type: 'agent.context.compact', title: 'Recompondo a memória', detail: data.message, level: 'warning'
  });
  if (event === 'fallback') return telemetry.emit({
    ...common, type: 'agent.fallback', title: 'Pensando',
    detail: 'Atualizando as rotas gratuitas e preservando integralmente o contexto da conversa.',
    level: 'warning', meta: { nextProvider: data.nextProvider, reasonCode: data.reason?.code }
  });
  if (event === 'continuation') return telemetry.emit({
    ...common, type: 'agent.continuation', title: 'Continuando a resposta', detail: data.message,
    level: 'info', meta: { round: data.round }
  });
  if (event === 'recovery') return telemetry.emit({
    ...common, type: 'agent.recovery', title: 'Pensando',
    detail: 'Nova rodada automática iniciada com a memória canônica preservada.',
    meta: { round: data.round, delayMs: data.delayMs }
  });
  if (event === 'complete') {
    telemetry.recordTokens(
      Number(data.usage?.inputTokens || 0),
      Number(data.usage?.outputTokens || 0),
      Number(data.context?.savedTokens || 0),
      Number(data.usage?.requestCount ?? 1),
      data.usage?.accuracy || 'reported'
    );
    return telemetry.emit({
      ...common, type: 'agent.complete', title: 'Resposta concluída',
      detail: `${data.provider} · ${data.model} · ${Math.round(data.latencyMs || 0)} ms`, level: 'success',
      meta: { model: data.model, latencyMs: data.latencyMs, usage: data.usage, freeVerified: data.freeVerified }
    });
  }
  if (event === 'handoff_start') return telemetry.emit({
    ...common, type: 'agent.handoff.started', title: 'Carregando modelo',
    detail: `${data.model} · validando a memória canônica em uma janela de ${data.contextWindow} tokens.`,
    thought: true, meta: { model: data.model, contextWindow: data.contextWindow }
  });
  if (event === 'handoff_complete') return telemetry.emit({
    ...common, type: 'agent.handoff.completed', title: 'Continuidade validada',
    detail: `${data.modelName} assumiu a sessão sem alterar o histórico canônico.`,
    level: 'success', thought: true,
    meta: { model: data.model, contextWindow: data.contextWindow, validationTokens: data.validationTokens }
  });
  if (event === 'approval_required') return telemetry.emit({
    ...common, type: 'agent.approval.required', title: 'Aguardando sua aprovação',
    detail: `${data.title} · ${data.detail}`, level: 'warning', meta: { kind: data.kind, approvalId: data.approvalId }
  });
  if (event === 'tool_start') return telemetry.emit({
    ...common, type: 'agent.tool.started', title: data.kind === 'command' ? 'Executando verificação' : data.kind === 'read' ? 'Consultando o projeto' : 'Aplicando alteração',
    detail: `${data.title} · ${data.detail}`, meta: { kind: data.kind }
  });
  if (event === 'tool_complete') return telemetry.emit({
    ...common, type: 'agent.tool.completed', title: 'Trabalho concluído',
    detail: data.summary || `${data.title} concluído.`, level: 'success', meta: { kind: data.kind }
  });
  if (event === 'tool_denied') return telemetry.emit({
    ...common, type: 'agent.tool.denied', title: 'Alteração recusada', detail: `${data.title} · ${data.detail}`, level: 'warning'
  });
  if (event === 'tool_failed') return telemetry.emit({
    ...common, type: 'agent.tool.failed', title: 'Ferramenta não concluiu', detail: data.message, level: 'error', meta: { kind: data.kind }
  });
  if (event === 'image_attempt') return telemetry.emit({
    ...common, type: 'agent.image.attempt', title: 'Gênesis está criando a imagem',
    detail: `${data.model} · tentativa ${data.attempt}`
  });
  if (event === 'image_fallback') return telemetry.emit({
    ...common, type: 'agent.image.fallback', title: 'Alternando rota de imagem',
    detail: `${data.reason?.message || 'Rota de imagem indisponível.'} Próxima rota: ${data.nextProvider}.`,
    level: 'warning', meta: { nextProvider: data.nextProvider, reasonCode: data.reason?.code }
  });
  if (event === 'image_complete') return telemetry.emit({
    ...common, type: 'agent.image.complete', title: 'Imagem criada',
    detail: `${data.model} · ${data.imageCount} imagem${data.imageCount === 1 ? '' : 's'} · ${Math.round(data.latencyMs || 0)} ms`, level: 'success'
  });
  return null;
}

function openRouterSnapshot(settings, provider) {
  return {
    configuration: settings.publicState(provider.account),
    models: (provider.catalog || []).filter(model => model.id !== 'openrouter/free'),
    provider: provider.publicStatus()
  };
}

// Hit /auth/key com cache em memória (10 min) — preenche account { limit,
// limitRemaining, expiresAt, isFreeTier } SEM gastar quota da chave.
// route privada do OpenRouter (não consome créditos).
const ACCOUNT_REFRESH_MS = 10 * 60 * 1000;
let lastAccountRefreshAt = 0;
let accountRefreshPromise = null;
async function refreshAccountInfo(provider, settings) {
  if (!provider?.configured) return;
  const now = Date.now();
  if (accountRefreshPromise) return accountRefreshPromise;
  if (now - lastAccountRefreshAt < ACCOUNT_REFRESH_MS) return;
  accountRefreshPromise = (async () => {
    try {
      await provider.validateKey();
      lastAccountRefreshAt = Date.now();
    } catch { /* mantém dados anteriores; UI usa telemetria */ }
    finally { accountRefreshPromise = null; }
  })();
  return accountRefreshPromise;
}

function publicMessage(message) {
  return {
    ...message,
    attachments: (message.attachments || []).map(({ sha256, ...attachment }) => attachment)
  };
}

function publicConversation(conversation) {
  if (!conversation) return null;
  const { usageRecords, ...publicValue } = conversation;
  return {
    ...publicValue,
    messages: conversation.messages.map(publicMessage)
  };
}

function terminalExecutionReport(error, contract, usage = null) {
  const failure = safeError(error);
  const evidence = Array.isArray(error?.evidence) ? error.evidence : [];
  const successful = evidence.filter(item => item?.ok === true);
  const mutations = successful.filter(item => [
    'write_project_file', 'replace_project_text', 'create_project_directory',
    'move_project_path', 'delete_project_path'
  ].includes(item.tool));
  const checks = successful.filter(item => item.tool === 'run_project_check');
  const failedCriteria = (error?.verification?.checks || [])
    .filter(item => item.required && !item.passed)
    .map(item => item.label);
  const lines = [
    '## Relatório final do Genesis',
    '',
    mutations.length
      ? '**Estado: alterações aplicadas, mas a tarefa não pôde ser marcada como totalmente pronta.**'
      : '**Estado: não ficou pronto; nenhuma alteração foi confirmada no projeto.**',
    '',
    'O Genesis encerrou esta tentativa de forma controlada e não ocultou uma conclusão incompleta.'
  ];
  if (successful.length) {
    lines.push('', '### O que foi feito', '');
    for (const item of successful.slice(-12)) {
      lines.push(`- ${item.tool}: ${item.summary || 'operação concluída.'}`);
    }
  } else {
    lines.push('', '### O que foi feito', '', '- Nenhuma operação no projeto foi confirmada nesta tentativa.');
  }
  lines.push('', '### O que impediu a conclusão', '', `- ${failure.message}`);
  for (const criterion of failedCriteria) lines.push(`- Critério pendente: ${criterion}.`);
  if (mutations.length && !checks.length) lines.push('- A escrita ocorreu, mas não houve orçamento ou rota disponível para executar a verificação final.');
  if (usage?.requestCount) {
    lines.push('', '### Uso contabilizado', '', `- ${usage.requestCount} requisição(ões); ${usage.inputTokens || 0} tokens enviados e ${usage.outputTokens || 0} recebidos.`);
  }
  lines.push(
    '',
    '### Situação de prontidão',
    '',
    mutations.length
      ? '- **Ainda requer verificação antes de ser considerado pronto.**'
      : '- **Não está pronto. O Genesis não declarou um falso sucesso.**',
    '- As evidências e o consumo foram preservados para a próxima continuação.'
  );
  return lines.join('\n');
}

function attachmentDisposition(name, download = false) {
  const safe = String(name || 'arquivo').replace(/["\\\r\n]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function conversationMarkdown(conversation) {
  const lines = [`# ${conversation.title}`, '', `- Criada em: ${conversation.createdAt}`, `- Modo: ${conversation.mode}`, ''];
  for (const message of conversation.messages) {
    lines.push(`## ${message.role === 'assistant' ? 'Genesis' : 'Usuário'}`, '', message.content, '');
    if (message.attachments?.length) {
      lines.push(...message.attachments.map(attachment => `- Anexo: ${attachment.name} (${attachment.kind}, ${attachment.size} bytes)`), '');
    }
    if (message.meta?.provider) lines.push(`_Motor: ${message.meta.provider} · ${message.meta.model || 'automático'}_`, '');
  }
  return `${lines.join('\n')}\n`;
}

function createRateLimiter() {
  const buckets = new Map();
  return (request, limit = 120) => {
    const key = request.socket.remoteAddress || 'local';
    const timestamp = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= timestamp) {
      buckets.set(key, { count: 1, resetAt: timestamp + 60000 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

async function createLedgerTask(taskLedger, contract, conversationId, mode) {
  if (!taskLedger || !contract) return null;
  return taskLedger.createTask({
    id: contract.id,
    conversationId,
    projectId: contract.project?.id || null,
    intent: contract.kind,
    mode,
    contract: {
      objective: contract.objective,
      acceptanceCriteria: contract.successCriteria,
      constraints: [
        `Limite total: ${contract.requestBudget?.limit || 0} requisicoes.`,
        `Limite cumulativo de entrada: ${contract.requestBudget?.inputTokenLimit || 0} tokens.`,
        contract.readOnly ? 'Tarefa somente leitura.' : 'Alteracoes limitadas ao projeto ativo.'
      ],
      permissions: contract.toolPolicy?.allowed || [],
      scope: contract.project ? `${contract.project.name} (${contract.project.fileCount} arquivos)` : 'Conversa atual'
    },
    steps: (contract.steps || []).map(step => ({
      id: step.id,
      label: step.label,
      status: step.status === 'in_progress' ? 'running' : 'pending'
    }))
  });
}

async function completeLedgerTask(taskLedger, contract, result) {
  if (!taskLedger || !contract) return null;
  const task = taskLedger.getTask(contract.id);
  for (const evidence of result.context?.evidence || []) {
    await taskLedger.addEvidence(contract.id, {
      kind: evidence.tool === 'run_project_check' ? 'test' : 'tool',
      title: evidence.tool || 'Evidencia da tarefa',
      summary: evidence.summary || (evidence.ok ? 'Operacao concluida.' : 'Operacao nao concluida.'),
      source: { tool: evidence.tool, ok: evidence.ok, code: evidence.code }
    });
  }
  await taskLedger.recordUsage(contract.id, {
    providerId: result.providerId,
    model: result.resolvedModel,
    inputTokens: result.usage?.inputTokens || 0,
    outputTokens: result.usage?.outputTokens || 0,
    totalTokens: result.usage?.totalTokens || 0,
    requestCount: result.usage?.requestCount ?? 0,
    reportedRequests: result.usage?.reportedRequests || 0,
    estimatedRequests: result.usage?.estimatedRequests || 0,
    unknownRequests: result.usage?.unknownRequests || 0,
    accuracy: result.usage?.accuracy || 'unknown',
    latencyMs: result.latencyMs || 0,
    status: 'completed'
  });
  if (result.verification?.status === 'failed') {
    return taskLedger.failTask(contract.id, {
      code: 'task_verification_failed',
      message: result.verification.summary || 'A entrega nao atendeu aos criterios obrigatorios.',
      stage: 'verification',
      retryable: false,
      meta: { score: result.verification.score, checks: result.verification.checks }
    });
  }
  for (const step of task.steps) {
    if (step.status === 'pending') await taskLedger.updateStep(contract.id, step.id, { status: 'running' });
    if (!['completed', 'failed', 'skipped'].includes(step.status)) {
      await taskLedger.updateStep(contract.id, step.id, { status: 'completed', detail: 'Etapa encerrada pela verificacao da entrega.' });
    }
  }
  return taskLedger.completeTask(contract.id, {
    summary: result.verification?.summary || 'Entrega concluida pelo Genesis.',
    verification: result.verification || {},
    verified: result.verification?.verified === true
  });
}

async function stopLedgerTask(taskLedger, contract, error, usage = null, cancelled = false) {
  if (!taskLedger || !contract) return null;
  for (const evidence of Array.isArray(error?.evidence) ? error.evidence : []) {
    await taskLedger.addEvidence(contract.id, {
      kind: evidence.tool === 'run_project_check' ? 'test' : 'tool',
      title: evidence.tool || 'Evidência da tarefa',
      summary: evidence.summary || (evidence.ok ? 'Operação concluída.' : 'Operação não concluída.'),
      source: { tool: evidence.tool, ok: evidence.ok, code: evidence.code }
    });
  }
  if (usage) {
    await taskLedger.recordUsage(contract.id, {
      providerId: error?.attempts?.at?.(-1)?.providerId || null,
      model: error?.attempts?.at?.(-1)?.model || null,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      totalTokens: usage.totalTokens || 0,
      requestCount: usage.requestCount ?? 0,
      reportedRequests: usage.reportedRequests || 0,
      estimatedRequests: usage.estimatedRequests || 0,
      unknownRequests: usage.unknownRequests || 0,
      accuracy: usage.accuracy || 'unknown',
      status: cancelled ? 'cancelled' : 'failed'
    });
  }
  if (cancelled) return taskLedger.cancelTask(contract.id, 'Execucao interrompida pelo usuario.');
  return taskLedger.failTask(contract.id, {
    code: error?.code || 'task_failed',
    message: safeError(error).message,
    stage: error?.category || 'generation',
    retryable: error?.retryable === true
  });
}

async function serveStatic(response, staticRoot, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(requested); } catch { return false; }
  const target = path.resolve(staticRoot, `.${decoded}`);
  if (!target.startsWith(`${path.resolve(staticRoot)}${path.sep}`)) return false;
  try {
    const body = await fs.readFile(target);
    const extension = path.extname(target).toLowerCase();
    setSecurityHeaders(response);
    response.writeHead(200, {
      'content-type': MIME[extension] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': ['.html', '.css', '.js'].includes(extension) ? 'no-cache' : 'public, max-age=3600'
    });
    response.end(body);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

export function createHandler({ config, store, orchestrator, telemetry, settings, attachmentStore, projectStore, permissionStore, approvalManager, projectTools, userMemory, supremeMind, taskLedger, voiceRuntime = null, weatherService = new WeatherService(), onShutdown = null }) {
  const activeConversations = new Set();
  const activeControllers = new Set();
  const activeStreams = new Set();
  const allowRequest = createRateLimiter();
  const allowChatRequest = createRateLimiter();
  const staticRoot = path.join(config.root, 'public');
  let shuttingDown = false;
  
  // Cache de instâncias SupremeMindIntegration por projeto
  const supremeMindCache = new Map(); // projectRoot -> SupremeMindIntegration
  const supremeMindJobs = new Map();

  function getSupremeMind(projectRoot) {
    if (!projectRoot) return supremeMind; // fallback to global instance for dataDir
    const cached = supremeMindCache.get(projectRoot);
    if (cached) return cached;
    const instance = new SupremeMindIntegration(projectRoot);
    supremeMindCache.set(projectRoot, instance);
    return instance;
  }

  const handler = async function handler(request, response) {
    try {
      if (shuttingDown) return sendJson(response, 503, { error: { code: 'server_shutting_down', message: 'O Genesis está encerrando com segurança.' } });
      assertLocalRequest(request);
      if (!allowRequest(request)) return sendJson(response, 429, { error: { code: 'local_rate_limit', message: 'Muitas requisições locais. Aguarde um minuto.' } });
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const segments = url.pathname.split('/').filter(Boolean);
      const openRouter = orchestrator.provider('openrouter');

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return sendJson(response, 200, { ok: true, name: 'Genesis New', version: config.version || GENESIS_VERSION, freeOnly: true });
      }

      if (url.pathname === '/api/voice/status' && request.method === 'GET') {
        return sendJson(response, 200, voiceRuntime ? await voiceRuntime.refreshStatus() : {
          available: false, localOnly: true, storesRawAudio: false,
          stt: { whisper: { available: false, profiles: {} } },
          tts: { kokoro: { available: false }, chatterbox: { available: false }, piper: { available: false } }
        });
      }

      if (url.pathname === '/api/voice/metrics' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request, 8 * 1024);
        return sendJson(response, 202, voiceRuntime?.recordMetric?.(body) || { ok: true });
      }

      if (url.pathname === '/api/voice/transcribe' && request.method === 'POST') {
        assertTrustedMutation(request);
        if (!voiceRuntime) return sendJson(response, 503, { error: { code: 'voice_runtime_unavailable', message: 'Runtime de voz local indisponível.' } });
        const audio = await readBuffer(request, { contentType: 'audio/wav', maxBytes: 10 * 1024 * 1024 });
        const result = await voiceRuntime.transcribe(audio, { quality: url.searchParams.get('quality') || 'balanced' });
        return sendJson(response, 200, result);
      }

      if (url.pathname === '/api/voice/synthesize' && request.method === 'POST') {
        assertTrustedMutation(request);
        if (!voiceRuntime) return sendJson(response, 503, { error: { code: 'voice_runtime_unavailable', message: 'Runtime de voz local indisponível.' } });
        const body = await readJson(request, 12 * 1024);
        const result = await voiceRuntime.synthesize(body);
        setSecurityHeaders(response);
        response.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': result.audio.length,
          'cache-control': 'no-store',
          'x-genesis-voice-engine': result.engine,
          'x-genesis-voice-process-mode': result.processMode,
          'x-genesis-voice-latency-ms': String(result.latencyMs)
        });
        response.end(result.audio);
        return;
      }

      if (url.pathname === '/api/context/capabilities' && request.method === 'GET') {
        return sendJson(response, 200, {
          ...LOCAL_CONTEXT_CAPABILITIES,
          generatedAt: new Date().toISOString()
        });
      }

      if (url.pathname === '/api/context/weather' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request, 8 * 1024);
        const place = String(body.place || '').trim();
        if (place.length < 2 || place.length > 100) return sendJson(response, 400, { error: { code: 'invalid_place', message: 'Informe cidade e estado ou país.' } });
        return sendJson(response, 200, await weatherService.currentForPlace(place));
      }

      if (url.pathname === '/api/runtime/shutdown' && request.method === 'POST') {
        assertTrustedMutation(request);
        if (typeof onShutdown !== 'function') return sendJson(response, 503, { error: { code: 'shutdown_unavailable', message: 'Shutdown controlado indisponível neste runtime.' } });
        sendJson(response, 202, { ok: true, status: 'shutting_down' });
        setImmediate(() => Promise.resolve(onShutdown()).catch(error => {
          console.error(`[Genesis] Falha no shutdown solicitado localmente: ${error?.stack || error}`);
          process.exitCode = 1;
        }));
        return;
      }

      if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        const projectSummary = projectStore.summary();
        const projectRoot = projectStore.rootPath();
        let supremeMindInfo = { indexed: false };
        if (projectRoot) {
          const sm = getSupremeMind(projectRoot);
          try {
            if (!sm.isIndexed()) await sm.loadIndex();
            supremeMindInfo = { indexed: true, projectInfo: sm.getProjectInfo(), indexing: supremeMindJobs.get(projectRoot) || null };
          } catch {
            supremeMindInfo = { indexed: false, indexing: supremeMindJobs.get(projectRoot) || null };
          }
        }
        // refresh a conta antes do snapshot inicial — a UI passa a ver quota real
        refreshAccountInfo(openRouter, settings);
        return sendJson(response, 200, {
          app: { name: 'Genesis New', version: config.version || GENESIS_VERSION },
          policy: FREE_POLICY,
          modes: Object.values(MODES),
          providers: orchestrator.statuses(),
          openrouter: openRouterSnapshot(settings, openRouter),
          project: projectSummary,
          permissions: permissionStore.publicState(),
          userMemory: userMemory.publicState(),
          supremeMind: supremeMindInfo,
          tasks: taskLedger?.publicSnapshot({ limit: 30 }) || { count: 0, activeCount: 0, tasks: [] },
          conversations: store.listConversations(),
          telemetry: { count: telemetry.list({ limit: telemetry.capacity }).length, live: true, metrics: telemetry.getMetrics() }
        });
      }

      if (url.pathname === '/api/logs' && request.method === 'GET') {
        const thought = url.searchParams.get('thought') === 'true';
        return sendJson(response, 200, {
          logs: telemetry.list({
            limit: url.searchParams.get('limit'),
            category: url.searchParams.get('category') || undefined,
            conversationId: url.searchParams.get('conversationId') || undefined,
            thought
          })
        });
      }

      if (url.pathname === '/api/logs/stream' && request.method === 'GET') {
        sseStart(response);
        activeStreams.add(response);
        sseSend(response, 'snapshot', { logs: telemetry.list({ limit: 300 }) });
        const unsubscribe = telemetry.subscribe(event => sseSend(response, 'log', event));
        const heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n');
        }, 15000);
        response.on('close', () => {
          activeStreams.delete(response);
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      if (url.pathname === '/api/logs' && request.method === 'DELETE') {
        assertTrustedMutation(request);
        await telemetry.clear();
        return sendJson(response, 200, { ok: true });
      }

      if (url.pathname === '/api/project' && request.method === 'GET') {
        return sendJson(response, 200, { project: projectStore.summary() });
      }

      if (url.pathname === '/api/tasks' && request.method === 'GET') {
        return sendJson(response, 200, {
          tasks: taskLedger?.publicSnapshot({
            limit: url.searchParams.get('limit') || 50,
            status: url.searchParams.get('status') || undefined,
            conversationId: url.searchParams.get('conversationId') || undefined,
            projectId: url.searchParams.get('projectId') || undefined
          }) || { count: 0, activeCount: 0, tasks: [] }
        });
      }

      if (segments[0] === 'api' && segments[1] === 'tasks' && segments[2] && segments.length === 3 && request.method === 'GET') {
        if (!taskLedger) return sendJson(response, 404, { error: { code: 'task_ledger_unavailable', message: 'O ledger de tarefas nÃ£o estÃ¡ disponÃ­vel.' } });
        return sendJson(response, 200, { task: taskLedger.getTask(segments[2]) });
      }

      if (url.pathname === '/api/neural/snapshot' && request.method === 'GET') {
        const project = projectStore.summary();
        const projectRoot = projectStore.rootPath();
        let supremeMindState = { indexed: false, indexing: projectRoot ? supremeMindJobs.get(projectRoot) || null : null, projectInfo: null };
        if (projectRoot) {
          const sm = getSupremeMind(projectRoot);
          try {
            if (!sm.isIndexed()) await sm.loadIndex();
            supremeMindState = { indexed: true, indexing: supremeMindJobs.get(projectRoot) || null, projectInfo: sm.getProjectInfo() };
          } catch {
            // Um projeto ainda nÃ£o indexado Ã© um estado normal da interface Neural.
          }
        }
        return sendJson(response, 200, {
          generatedAt: new Date().toISOString(),
          app: { name: 'Genesis New', version: config.version || GENESIS_VERSION },
          project,
          intelligence: projectStore.intelligence(),
          supremeMind: supremeMindState,
          tasks: taskLedger?.publicSnapshot({ limit: 40 }) || { count: 0, activeCount: 0, tasks: [] },
          telemetry: { metrics: telemetry.getMetrics(), events: telemetry.list({ limit: 160 }) },
          runtime: { activeConversations: activeConversations.size, providers: orchestrator.statuses() }
        });
      }

      if (url.pathname === '/api/user-memory' && request.method === 'GET') {
        return sendJson(response, 200, { userMemory: userMemory.publicState() });
      }

      if (url.pathname === '/api/user-memory' && request.method === 'PUT') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        return sendJson(response, 200, { userMemory: await userMemory.setEnabled(body.enabled === true) });
      }

      if (url.pathname === '/api/user-memory' && request.method === 'DELETE') {
        assertTrustedMutation(request);
        return sendJson(response, 200, { userMemory: await userMemory.clear() });
      }

      if (url.pathname === '/api/project/open-path' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const selectedPath = String(body.path || '').trim().replace(/^(["'])(.*)\1$/, '$2');
        if (!selectedPath || selectedPath.length > 1000) {
          const error = new Error('Informe um caminho de pasta válido.');
          error.status = 400;
          error.code = 'invalid_project_directory';
          throw error;
        }
        const project = await projectStore.openPath(selectedPath);
        orchestrator.invalidateContext?.();
        telemetry.emit({
          category: 'storage', type: 'project.opened.editable', title: 'Projeto editável aberto',
          detail: `${project.name} · ${project.fileCount} arquivos · alterações restritas à pasta selecionada.`,
          level: 'success', thought: true,
          meta: { fileCount: project.fileCount, totalBytes: project.totalBytes, technologies: project.technologies }
        });
        return sendJson(response, 200, { project });
      }

      if (url.pathname === '/api/project/pick' && request.method === 'POST') {
        assertTrustedMutation(request);
        const pickerController = new AbortController();
        activeControllers.add(pickerController);
        const cancelPicker = () => pickerController.abort();
        request.once('aborted', cancelPicker);
        response.once('close', cancelPicker);
        let selectedPath;
        try {
          selectedPath = await pickProjectDirectory({ signal: pickerController.signal });
        } catch (error) {
          if (pickerController.signal.aborted) return;
          throw error;
        } finally {
          request.off('aborted', cancelPicker);
          response.off('close', cancelPicker);
          activeControllers.delete(pickerController);
        }
        if (!selectedPath) return sendJson(response, 200, { cancelled: true, project: projectStore.summary() });
        const project = await projectStore.openPath(selectedPath);
        orchestrator.invalidateContext?.();
        telemetry.emit({
          category: 'storage', type: 'project.opened.editable', title: 'Projeto editável aberto',
          detail: `${project.name} · ${project.fileCount} arquivos · alterações restritas à pasta selecionada.`,
          level: 'success', thought: true,
          meta: { fileCount: project.fileCount, totalBytes: project.totalBytes, technologies: project.technologies }
        });
        return sendJson(response, 200, { cancelled: false, project });
      }

      if (url.pathname === '/api/project' && request.method === 'PUT') {
        assertTrustedMutation(request);
        const body = await readJson(request, MAX_PROJECT_BODY_BYTES);
        const project = await projectStore.open(body);
        orchestrator.invalidateContext?.();
        telemetry.emit({
          category: 'storage', type: 'project.opened', title: 'Projeto aberto no Genesis',
          detail: `${project.name} · ${project.fileCount} arquivos · ${project.totalLines} linhas indexadas em modo somente leitura.`,
          level: 'success', thought: true,
          meta: { fileCount: project.fileCount, totalBytes: project.totalBytes, technologies: project.technologies }
        });
        return sendJson(response, 200, { project });
      }

      if (url.pathname === '/api/project' && request.method === 'DELETE') {
        assertTrustedMutation(request);
        const previous = projectStore.summary();
        await projectStore.close();
        orchestrator.invalidateContext?.();
        telemetry.emit({
          category: 'storage', type: 'project.closed', title: 'Projeto fechado',
          detail: previous ? `${previous.name} foi removido do contexto ativo.` : 'Nenhum projeto estava ativo.', level: 'warning'
        });
        return sendJson(response, 200, { project: null });
      }

      // SupremeMind API endpoints
      if (url.pathname === '/api/suprememind/init' && request.method === 'POST') {
        assertTrustedMutation(request);
        await readJson(request);
        const projectRoot = projectStore.rootPath();
        if (!projectRoot) return sendJson(response, 400, { error: { code: 'no_project', message: 'Abra uma pasta de projeto editavel antes de inicializar o SupremeMind.' } });
        const sm = getSupremeMind(projectRoot);
        const result = await sm.init();
        telemetry.emit({ category: 'suprememind', type: 'init', title: 'SupremeMind inicializado', detail: `Projeto: ${path.basename(projectRoot)}`, level: 'success', thought: true });
        return sendJson(response, 200, { ...result, projectRoot: undefined });
      }

      if (url.pathname === '/api/suprememind/index' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const projectRoot = projectStore.rootPath();
        if (!projectRoot) return sendJson(response, 400, { error: { code: 'no_project', message: 'Abra uma pasta de projeto editável antes de indexar.' } });
        const sm = getSupremeMind(projectRoot);
        if (supremeMindJobs.get(projectRoot)?.status === 'running') {
          return sendJson(response, 409, { error: { code: 'index_in_progress', message: 'A indexação deste projeto já está em andamento.' }, indexing: supremeMindJobs.get(projectRoot) });
        }
        const job = { status: 'running', current: 0, total: 0, percent: 0, file: '', startedAt: new Date().toISOString() };
        supremeMindJobs.set(projectRoot, job);
        let lastProgress = -1;
        try {
          await sm.init();
          const result = await sm.index({
            force: body.force === true,
            progress: (current, total, file) => {
              const percent = total ? Math.round(current / total * 100) : 0;
              Object.assign(job, { current, total, percent, file });
              if (percent === 100 || percent === 0 || percent >= lastProgress + 5) {
                lastProgress = percent;
                telemetry.emit({ category: 'suprememind', type: 'index.progress', title: 'Indexando', detail: `${current}/${total} · ${file}`, level: 'info', meta: { current, total, percent, file } });
              }
            }
          });
          Object.assign(job, { status: 'completed', current: result.stats.indexed, total: result.stats.indexed, percent: 100, file: '', completedAt: new Date().toISOString() });
          telemetry.emit({ category: 'suprememind', type: 'index.complete', title: 'Indexação concluída', detail: `${result.stats.indexed} arquivos, ${result.stats.symbols} símbolos`, level: 'success', thought: true });
          return sendJson(response, 200, { stats: result.stats, projectInfo: sm.getProjectInfo(), indexing: job });
        } catch (error) {
          Object.assign(job, { status: 'failed', message: safeError(error).message, failedAt: new Date().toISOString() });
          throw error;
        }
      }

      if (url.pathname === '/api/suprememind/status' && request.method === 'GET') {
        const path = projectStore.rootPath();
        if (!path) return sendJson(response, 200, { indexed: false });
        const sm = getSupremeMind(path);
        try {
          if (!sm.isIndexed()) await sm.loadIndex();
          return sendJson(response, 200, { indexed: true, projectInfo: sm.getProjectInfo(), indexing: supremeMindJobs.get(path) || null });
        } catch {
          return sendJson(response, 200, { indexed: false, indexing: supremeMindJobs.get(path) || null });
        }
      }

      if (url.pathname === '/api/suprememind/graph' && request.method === 'GET') {
        const projectRoot = projectStore.rootPath();
        if (!projectRoot) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(projectRoot);
        if (!sm.isIndexed()) await sm.loadIndex();
        return sendJson(response, 200, {
          graph: sm.getGraph({ nodeLimit: url.searchParams.get('nodes'), edgeLimit: url.searchParams.get('edges') })
        });
      }

      if (url.pathname === '/api/suprememind/files' && request.method === 'GET') {
        const projectRoot = projectStore.rootPath();
        if (!projectRoot) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(projectRoot);
        if (!sm.isIndexed()) await sm.loadIndex();
        return sendJson(response, 200, {
          files: sm.listIndexedFiles({ limit: url.searchParams.get('limit'), query: url.searchParams.get('query') || '' })
        });
      }

      if (url.pathname === '/api/suprememind/query' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const query = String(body.query || '').trim();
        if (!query) return sendJson(response, 400, { error: { code: 'empty_query', message: 'Informe a consulta.' } });
        const path = projectStore.rootPath();
        if (!path) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(path);
        if (!sm.isIndexed()) await sm.loadIndex();
        const results = await sm.search(query, body.limit ?? 20);
        return sendJson(response, 200, { results });
      }

      if (url.pathname === '/api/suprememind/context' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const query = String(body.query || '').trim();
        if (!query) return sendJson(response, 400, { error: { code: 'empty_query', message: 'Informe a consulta.' } });
        const path = projectStore.rootPath();
        if (!path) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(path);
        if (!sm.isIndexed()) await sm.loadIndex();
        const context = await sm.getContext(query, body.budget ?? 6000);
        return sendJson(response, 200, context);
      }

      if (url.pathname === '/api/suprememind/impact' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const filePath = String(body.path || '').trim();
        if (!filePath) return sendJson(response, 400, { error: { code: 'empty_path', message: 'Informe o caminho do arquivo.' } });
        const path = projectStore.rootPath();
        if (!path) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(path);
        if (!sm.isIndexed()) await sm.loadIndex();
        const impact = await sm.getImpact(filePath, body.depth ?? 3);
        return sendJson(response, 200, impact);
      }

      if (url.pathname === '/api/suprememind/orbit' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const filePath = String(body.path || '').trim();
        if (!filePath) return sendJson(response, 400, { error: { code: 'empty_path', message: 'Informe o caminho do arquivo.' } });
        const path = projectStore.rootPath();
        if (!path) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(path);
        if (!sm.isIndexed()) await sm.loadIndex();
        const orbit = await sm.getOrbit(filePath, body.depth ?? 2);
        return sendJson(response, 200, orbit);
      }

      if (url.pathname === '/api/suprememind/memory' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const path = projectStore.rootPath();
        if (!path) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(path);
        await sm.init();
        const memory = await sm.saveMemory(body);
        telemetry.emit({ category: 'suprememind', type: 'memory.saved', title: 'Memória salva', detail: memory.title, level: 'success', thought: true });
        return sendJson(response, 200, { memory });
      }

      if (url.pathname === '/api/suprememind/memories' && request.method === 'GET') {
        const query = url.searchParams.get('query') || '';
        const limit = Number(url.searchParams.get('limit') ?? 10);
        const path = projectStore.rootPath();
        if (!path) return sendJson(response, 400, { error: { code: 'no_project', message: 'Nenhum projeto ativo.' } });
        const sm = getSupremeMind(path);
        await sm.init();
        const memories = await sm.listMemories(query, limit);
        return sendJson(response, 200, { memories });
      }

      if (url.pathname === '/api/permissions' && request.method === 'GET') {
        return sendJson(response, 200, { permissions: permissionStore.publicState() });
      }

      if (url.pathname === '/api/permissions' && request.method === 'PUT') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const permissions = await permissionStore.setMode(body.mode);
        telemetry.emit({
          category: 'system', type: 'permissions.updated', title: 'Modo de permissão atualizado',
          detail: permissions.mode === 'full'
            ? 'Permissão completa ativada somente dentro da pasta do projeto.'
            : 'O Gênesis pedirá aprovação antes de cada alteração.',
          level: permissions.mode === 'full' ? 'warning' : 'success', thought: true,
          meta: { mode: permissions.mode }
        });
        return sendJson(response, 200, { permissions });
      }

      if (segments[0] === 'api' && segments[1] === 'approvals' && segments[2] && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const result = approvalManager.decide(segments[2], body.decision);
        if (!result) return sendJson(response, 404, { error: { code: 'approval_not_found', message: 'Esta solicitação de aprovação não está mais ativa.' } });
        telemetry.emit({
          category: 'agent', type: 'agent.approval.resolved', title: result.decision === 'approve' ? 'Alteração aprovada' : 'Alteração negada',
          detail: result.decision === 'approve' ? 'O Gênesis pode continuar esta operação.' : 'A operação foi recusada pelo usuário.',
          conversationId: result.conversationId, level: result.decision === 'approve' ? 'success' : 'warning', thought: true
        });
        return sendJson(response, 200, { ok: true, decision: result.decision });
      }

      if (url.pathname === '/api/openrouter/config' && request.method === 'GET') {
        // refreshAccountInfo(): bate no /auth/key com a chave do vault (sem gastar quota).
        // Cacheia 10 min — `/auth/key` deveria ser barato, mas evitamos spam.
        refreshAccountInfo(openRouter, settings);
        return sendJson(response, 200, openRouterSnapshot(settings, openRouter));
      }

      if (url.pathname === '/api/openrouter/key' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const submittedKey = String(body.apiKey || '').trim();
        const key = submittedKey ? validateOpenRouterKey(submittedKey) : settings.key;
        if (!key) {
          const error = new Error('Informe sua chave OpenRouter para continuar.');
          error.status = 400;
          error.code = 'openrouter_key_required';
          throw error;
        }
        const previousKey = settings.key;
        openRouter.setApiKey(key);
        openRouter.setSelection(settings.preferences.selectionMode, settings.preferences.selectedModel);
        try {
          await openRouter.validateKey();
          await openRouter.models({ force: true });
          await settings.setKey(key, { persist: body.persist === true });
          telemetry.emit({
            category: 'providers', type: 'openrouter.connected', title: 'OpenRouter conectado',
            detail: `${openRouter.catalog?.length || 0} modelos gratuitos carregados · chave ${body.persist === true ? 'salva no cofre local' : 'mantida apenas nesta sessão'}.`,
            level: 'success', thought: true, meta: { modelCount: openRouter.catalog?.length || 0, persisted: body.persist === true }
          });
          return sendJson(response, 200, openRouterSnapshot(settings, openRouter));
        } catch (error) {
          openRouter.setApiKey(previousKey);
          openRouter.setSelection(settings.preferences.selectionMode, settings.preferences.selectedModel);
          error.status = error.category === 'authentication' ? 401 : 502;
          throw error;
        }
      }

      if (url.pathname === '/api/openrouter/key' && request.method === 'DELETE') {
        assertTrustedMutation(request);
        await settings.clearKey();
        openRouter.setApiKey('');
        telemetry.emit({
          category: 'providers', type: 'openrouter.disconnected', title: 'OpenRouter desconectado',
          detail: 'A chave foi removida da memória e do cofre local.', level: 'warning'
        });
        return sendJson(response, 200, openRouterSnapshot(settings, openRouter));
      }

      if (url.pathname === '/api/openrouter/models' && request.method === 'GET') {
        if (!openRouter.configured) {
          const error = new Error('Conecte sua chave OpenRouter para carregar os modelos gratuitos.');
          error.status = 409;
          error.code = 'openrouter_not_configured';
          throw error;
        }
        await openRouter.models({ force: url.searchParams.get('refresh') === 'true' });
        return sendJson(response, 200, openRouterSnapshot(settings, openRouter));
      }

      if (url.pathname === '/api/openrouter/preferences' && request.method === 'PUT') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const selectionMode = body.selectionMode === 'manual' ? 'manual' : 'automatic';
        const selectedModel = selectionMode === 'manual' ? String(body.selectedModel || '').trim() : 'openrouter/free';
        if (selectionMode === 'manual') {
          const models = await openRouter.models();
          if (selectedModel === 'openrouter/free' || !models.some(model => model.id === selectedModel)) {
            const error = new Error('Escolha um modelo gratuito disponível no catálogo atual.');
            error.status = 400;
            error.code = 'free_model_not_available';
            throw error;
          }
        }
        await settings.setSelection(selectionMode, selectedModel);
        openRouter.setSelection(selectionMode, selectedModel);
        telemetry.emit({
          category: 'providers', type: 'openrouter.selection.updated', title: 'Seleção de modelo atualizada',
          detail: selectionMode === 'automatic' ? 'Roteamento automático entre modelos gratuitos ativado.' : `Modelo manual: ${selectedModel}.`,
          level: 'success', thought: true, meta: { selectionMode, selectedModel }
        });
        return sendJson(response, 200, openRouterSnapshot(settings, openRouter));
      }

      if (url.pathname === '/api/providers/refresh' && request.method === 'POST') {
        assertTrustedMutation(request);
        telemetry.emit({ category: 'providers', type: 'providers.refresh', title: 'Verificando modelos gratuitos', detail: 'Consultando chave, modelos gratuitos e disponibilidade.', thought: true });
        const providers = await orchestrator.refreshProviders();
        const available = providers.filter(provider => provider.state === 'online').length;
        telemetry.emit({
          category: 'providers', type: 'providers.refreshed', title: 'Rotas gratuitas atualizadas',
          detail: available ? 'Catálogo gratuito atualizado.' : 'Os modelos gratuitos ainda não estão disponíveis.', level: available ? 'success' : 'warning',
          meta: { available, total: providers.length }
        });
        return sendJson(response, 200, { providers, openrouter: openRouterSnapshot(settings, openRouter) });
      }

      if (url.pathname === '/api/conversations' && request.method === 'POST') {
        assertTrustedMutation(request);
        const body = await readJson(request);
        const conversation = await store.createConversation({ mode: normalizeMode(body.mode) });
        telemetry.emit({ category: 'conversation', type: 'conversation.created', title: 'Nova conversa criada', detail: `Modo ${conversation.mode}.`, conversationId: conversation.id, level: 'success' });
        return sendJson(response, 201, { conversation });
      }

      if (segments[0] === 'api' && segments[1] === 'conversations' && segments[2]) {
        const id = segments[2];
        const conversation = store.getConversation(id);
        if (!conversation) return sendJson(response, 404, { error: { code: 'not_found', message: 'Conversa não encontrada.' } });

        if (segments.length === 3 && request.method === 'GET') return sendJson(response, 200, { conversation: publicConversation(conversation) });

        if (segments.length === 3 && request.method === 'PATCH') {
          assertTrustedMutation(request);
          const body = await readJson(request);
          const changes = {};
          if (Object.hasOwn(body, 'title')) {
            const title = String(body.title || '').replace(/\s+/g, ' ').trim();
            if (title.length < 1 || title.length > 80) {
              return sendJson(response, 400, { error: { code: 'invalid_title', message: 'Use um nome entre 1 e 80 caracteres.' } });
            }
            changes.title = title;
          }
          if (Object.hasOwn(body, 'markerColor')) {
            const markerColor = String(body.markerColor || '').trim().toLowerCase();
            if (!['violet', 'cyan', 'green', 'amber', 'rose'].includes(markerColor)) {
              return sendJson(response, 400, { error: { code: 'invalid_marker', message: 'Marcador de conversa inválido.' } });
            }
            changes.markerColor = markerColor;
          }
          if (!Object.keys(changes).length) {
            return sendJson(response, 400, { error: { code: 'empty_update', message: 'Nenhuma alteração foi informada.' } });
          }
          const updated = await store.updateConversation(id, changes);
          telemetry.emit({
            category: 'conversation', type: 'conversation.updated', title: 'Conversa personalizada',
            detail: changes.title ? 'Nome da conversa atualizado.' : 'Marcador da conversa atualizado.',
            conversationId: id, level: 'success'
          });
          return sendJson(response, 200, { conversation: publicConversation(updated) });
        }

        if (segments.length === 3 && request.method === 'DELETE') {
          assertTrustedMutation(request);
          await store.deleteConversation(id);
          await attachmentStore.deleteConversation(id);
          orchestrator.invalidateContext?.(id);
          telemetry.emit({ category: 'conversation', type: 'conversation.deleted', title: 'Conversa removida', detail: 'Histórico local excluído.', conversationId: id, level: 'warning' });
          return sendJson(response, 200, { ok: true });
        }

        if (segments[3] === 'handoff' && request.method === 'POST') {
          assertTrustedMutation(request);
          if (activeConversations.has(id)) return sendJson(response, 409, { error: { code: 'conversation_busy', message: 'Aguarde a tarefa atual terminar antes de trocar o modelo.' } });
          const lastAssistant = [...conversation.messages].reverse().find(message => message.role === 'assistant');
          const currentContextWindow = Number(lastAssistant?.meta?.context?.contextWindow || 0);
          activeConversations.add(id);
          const controller = new AbortController();
          activeControllers.add(controller);
          const stopOnDisconnect = () => controller.abort();
          request.once('aborted', stopOnDisconnect);
          try {
            const dispatchAgentEvent = (event, data) => emitAgentEvent(telemetry, event, data, id);
            const handoff = await orchestrator.prepareHandoff({
              conversation,
              currentContextWindow,
              requirements: { tools: projectStore.summary()?.writable === true },
              onEvent: dispatchAgentEvent,
              signal: controller.signal
            });
            await settings.setSelection('manual', handoff.model);
            openRouter.setSelection('manual', handoff.model);
            return sendJson(response, 200, { handoff, openrouter: openRouterSnapshot(settings, openRouter) });
          } finally {
            request.off('aborted', stopOnDisconnect);
            activeControllers.delete(controller);
            activeConversations.delete(id);
          }
        }

        if (segments[3] === 'attachments' && segments[4] && request.method === 'GET') {
          const attachment = conversation.messages
            .flatMap(message => message.attachments || [])
            .find(item => item.id === segments[4]);
          if (!attachment) return sendJson(response, 404, { error: { code: 'attachment_not_found', message: 'Anexo não encontrado.' } });
          const body = await attachmentStore.read(id, attachment.id);
          setSecurityHeaders(response);
          response.writeHead(200, {
            'content-type': attachment.mimeType,
            'content-length': body.length,
            'content-disposition': attachmentDisposition(attachment.name, url.searchParams.get('download') === '1'),
            'cache-control': 'private, max-age=300',
            etag: `"${attachment.sha256}"`,
            'x-content-type-options': 'nosniff'
          });
          response.end(body);
          return;
        }

        if (segments[3] === 'export' && request.method === 'GET') {
          telemetry.emit({ category: 'conversation', type: 'conversation.exported', title: 'Conversa exportada', detail: 'Arquivo Markdown gerado localmente.', conversationId: id });
          const body = conversationMarkdown(conversation);
          setSecurityHeaders(response);
          response.writeHead(200, {
            'content-type': 'text/markdown; charset=utf-8',
            'content-disposition': `attachment; filename="genesis-${id.slice(0, 8)}.md"`,
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store'
          });
          return response.end(body);
        }

        if (segments[3] === 'messages' && request.method === 'POST') {
          assertTrustedMutation(request);
          if (!allowChatRequest(request, 30)) return sendJson(response, 429, { error: { code: 'chat_rate_limit', message: 'Limite local de mensagens atingido. Aguarde um minuto.' } });
          if (activeConversations.has(id)) return sendJson(response, 409, { error: { code: 'conversation_busy', message: 'O Genesis já está processando esta conversa.' } });
          const body = await readJson(request, MAX_CHAT_BODY_BYTES);
          const editMessageId = String(body.editMessageId || '').trim();
          const editedMessage = editMessageId
            ? conversation.messages.find(message => message.id === editMessageId && message.role === 'user')
            : null;
          if (editMessageId && !editedMessage) return sendJson(response, 404, { error: { code: 'message_not_found', message: 'A mensagem que seria editada não foi encontrada.' } });
          const submittedAttachments = body.attachments ?? [];
          const hasAttachments = (Array.isArray(submittedAttachments) && submittedAttachments.length > 0) || Boolean(editedMessage?.attachments?.length);
          const content = String(body.content || '').trim() || (hasAttachments ? 'Analise os arquivos anexados e apresente os pontos relevantes.' : '');
          const mode = normalizeMode(body.mode || conversation.mode);
          const interfaceLanguage = body.language === 'en-US' ? 'en-US' : 'pt-BR';
          const inputMetadata = sanitizeInputMetadata(body.inputMetadata);
          const clientContext = sanitizeClientContext(body.clientContext);
          const taskContract = createTaskContract(content, { project: projectStore.summary(), mode });
          if (!content || content.length > config.maxMessageCharacters) return sendJson(response, 400, { error: { code: 'invalid_message', message: `A mensagem deve ter entre 1 e ${config.maxMessageCharacters.toLocaleString('pt-BR')} caracteres.` } });
          const submittedAttachmentNames = Array.isArray(submittedAttachments) ? submittedAttachments.map(item => item?.name).join(' ') : '';
          const priorAdultContent = conversation.messages.some(message => message.role === 'user' && message.id !== editMessageId && (
            isAdultContent(message.content) || isAdultContent((message.attachments || []).map(item => item.name).join(' '))
          ));
          if (isAdultContent(content) || isAdultContent(submittedAttachmentNames) || priorAdultContent) {
            telemetry.emit({
              category: 'policy', type: 'policy.adult_content.blocked', title: 'Conteúdo impróprio bloqueado',
              detail: 'A solicitação foi recusada localmente antes de acessar qualquer modelo.', conversationId: id, level: 'warning'
            });
            return sendJson(response, 422, { error: { code: 'adult_content_blocked', message: ADULT_CONTENT_MESSAGE } });
          }
          const localContextResponse = await resolveLocalContextResponse({
            query: content,
            clientContext,
            language: interfaceLanguage,
            weatherService,
            fallbackPlace: [...conversation.messages].reverse()
              .filter(message => message.role === 'user')
              .map(message => extractRequestedPlace(message.content))
              .find(Boolean) || null
          });

          activeConversations.add(id);
          const generationController = new AbortController();
          activeControllers.add(generationController);
          const stopOnDisconnect = () => generationController.abort();
          request.once('aborted', stopOnDisconnect);
          response.once('close', stopOnDisconnect);
          let attachments = [];
          let messagePersisted = false;
          let ledgerTaskCreated = false;
          let current;
          let userMessage;
          try {
            if (editMessageId) {
              const messageMeta = {
                tokenEstimate: estimateMessageTokens({ content, attachments: editedMessage.attachments || [] }),
                tokenAccuracy: 'estimated',
                task: taskContract,
                ...(inputMetadata.inputMode === 'voice' ? { input: inputMetadata } : {})
              };
              const edited = await store.editUserMessage(id, editMessageId, { content, mode, meta: messageMeta });
              orchestrator.invalidateContext?.(id);
              if (edited.removedAttachmentIds.length) await attachmentStore.removeMany(id, edited.removedAttachmentIds);
              userMessage = edited.message;
              attachments = userMessage.attachments || [];
              messagePersisted = true;
            } else {
              attachments = await attachmentStore.saveMany(id, submittedAttachments);
              const messageMeta = {
                tokenEstimate: estimateMessageTokens({ content, attachments }),
                tokenAccuracy: 'estimated',
                task: taskContract,
                ...(inputMetadata.inputMode === 'voice' ? { input: inputMetadata } : {})
              };
              userMessage = await store.addMessage(id, { role: 'user', content, mode, attachments, meta: messageMeta });
              messagePersisted = true;
            }
            current = await attachmentStore.hydrateConversation(store.getConversation(id));
            await userMemory.observe(content);
            if (taskLedger) {
              try {
                await createLedgerTask(taskLedger, taskContract, id, mode);
                ledgerTaskCreated = true;
              } catch (ledgerError) {
                telemetry.emit({
                  category: 'task', type: 'task.ledger.warning', title: 'Ledger de tarefas indisponivel',
                  detail: safeError(ledgerError).message, conversationId: id, level: 'warning',
                  meta: { taskId: taskContract.id, code: ledgerError.code || 'task_ledger_error' }
                });
              }
            }
          } catch (error) {
            if (!messagePersisted && attachments.length) await attachmentStore.removeMany(id, attachments.map(item => item.id));
            request.off('aborted', stopOnDisconnect);
            response.off('close', stopOnDisconnect);
            activeControllers.delete(generationController);
            activeConversations.delete(id);
            throw error;
          }
          telemetry.emit({
            category: 'agent', type: 'agent.request.accepted', title: 'Nova tarefa recebida',
            detail: `${content.length} caracteres · ${attachments.length} anexo${attachments.length === 1 ? '' : 's'} · modo ${mode}.`, conversationId: id, thought: true,
            meta: { characters: content.length, mode, attachmentCount: attachments.length, attachmentBytes: attachments.reduce((sum, item) => sum + item.size, 0), projectFiles: projectStore.summary()?.fileCount || 0 }
          });
          sseStart(response);
          sseSend(response, 'accepted', { message: publicMessage(userMessage) });
          try {
            const projectContext = projectStore.contextFor(content, {
              maxCharacters: Math.min(26000, Math.max(8000, config.inputTokenBudget * 2)),
              maxFiles: mode === 'fast' ? 4 : mode === 'reasoning' || mode === 'code' ? 10 : 7
            });
            const projectRoot = projectStore.rootPath();
            const activeSupremeMind = projectRoot ? getSupremeMind(projectRoot) : supremeMind;
            if (projectRoot && !activeSupremeMind.isIndexed()) {
              try { await activeSupremeMind.loadIndex(); } catch { /* o chat continua com o contexto textual do projeto */ }
            }
            const dispatchAgentEvent = (event, data) => {
              emitAgentEvent(telemetry, event, data, id);
              sseSend(response, event, data);
            };
            const result = await orchestrator.respond({
              conversation: current,
              mode,
              onEvent: dispatchAgentEvent,
              signal: generationController.signal,
              projectContext,
              supremeMind: activeSupremeMind,
              userMemoryContext: await userMemory.context(content),
              interfaceLanguage,
              turnContext: formatTurnContext(inputMetadata),
              taskContract,
              localResponse: localContextResponse || (taskContract.toolPolicy.strategy === 'local_project_profile'
                ? projectStore.localReport(taskContract.outputFormat)
                : ''),
              tools: projectToolDefinitionsFor(taskContract, { writable: projectStore.summary()?.writable === true }),
              toolExecutor: async (toolCall, options) => {
                const toolResult = await projectTools.execute(toolCall, {
                  ...options,
                  conversationId: id,
                  onEvent: dispatchAgentEvent
                });
                const mutationTools = new Set([
                  'write_project_file', 'replace_project_text', 'create_project_directory',
                  'move_project_path', 'delete_project_path'
                ]);
                if (toolResult?.ok === true && mutationTools.has(toolCall?.function?.name)) {
                  await activeSupremeMind.invalidateIndex?.();
                  orchestrator.invalidateContext?.(id);
                }
                return toolResult;
              }
            });
            const meta = {
              providerId: result.providerId,
              provider: result.provider,
              model: result.resolvedModel,
              requestedModel: result.requestedModel,
              resolvedProvider: result.resolvedProvider,
              latencyMs: result.latencyMs,
              usage: result.usage,
              context: result.context,
              attempts: result.attempts,
              freeVerified: result.freeVerified,
              task: result.task || taskContract,
              verification: result.verification || result.context?.verification || null
            };
            const generatedAttachments = result.generatedImages?.length
              ? await attachmentStore.saveMany(id, result.generatedImages.map(image => ({
                name: image.name,
                mimeType: image.mimeType,
                dataUrl: image.dataUrl
              })))
              : [];
            const assistant = await store.addMessage(id, { role: 'assistant', content: result.content, attachments: generatedAttachments, meta });
            await store.applyResult(id, result);
            if (ledgerTaskCreated) {
              try {
                await completeLedgerTask(taskLedger, taskContract, result);
              } catch (ledgerError) {
                telemetry.emit({
                  category: 'task', type: 'task.ledger.warning', title: 'Ledger nao confirmou a conclusao',
                  detail: safeError(ledgerError).message, conversationId: id, level: 'warning',
                  meta: { taskId: taskContract.id, code: ledgerError.code || 'task_ledger_error' }
                });
              }
            }
            telemetry.emit({
              category: 'storage', type: 'conversation.persisted', title: 'Memória canônica atualizada',
              detail: 'Resposta e métricas salvas no workspace local.', conversationId: id, level: 'success',
              meta: { providerId: result.providerId, savedTokens: result.context?.savedTokens || 0 }
            });
            sseSend(response, 'done', {
              message: publicMessage(assistant),
              conversation: store.listConversations().find(item => item.id === id),
              providers: orchestrator.statuses()
            });
          } catch (error) {
            if (generationController.signal.aborted || error?.code === 'request_cancelled') {
              const stoppedUsage = error?.usage || null;
              const stoppedProviderId = stoppedUsage?.models?.find(model => model.providerId)?.providerId || null;
              if (stoppedUsage?.requestCount > 0) {
                await store.applyResult(id, {
                  accountingId: taskContract.id,
                  providerId: stoppedProviderId,
                  usage: stoppedUsage,
                  context: { savedTokens: 0 }
                });
                telemetry.recordTokens(
                  Number(stoppedUsage.inputTokens || 0),
                  Number(stoppedUsage.outputTokens || 0),
                  0,
                  Number(stoppedUsage.requestCount || 0),
                  stoppedUsage.accuracy || 'mixed'
                );
              }
              if (ledgerTaskCreated) {
                try { await stopLedgerTask(taskLedger, taskContract, error, stoppedUsage, true); }
                catch { /* o chat nao depende da persistencia auxiliar */ }
              }
              telemetry.emit({
                category: 'agent', type: 'agent.stopped', title: 'Execução interrompida',
                detail: 'O usuário interrompeu esta resposta antes da conclusão.', conversationId: id, level: 'warning', thought: true
              });
              sseSend(response, 'stopped', { ok: true, usage: stoppedUsage, task: error?.task || taskContract });
            } else {
              const failureUsage = error?.usage || null;
              const failureProviderId = error?.attempts?.at?.(-1)?.providerId || null;
              if (failureUsage?.requestCount > 0) {
                await store.applyResult(id, {
                  accountingId: taskContract.id,
                  providerId: failureProviderId,
                  usage: failureUsage,
                  context: { savedTokens: 0 }
                });
                telemetry.recordTokens(
                  Number(failureUsage.inputTokens || 0),
                  Number(failureUsage.outputTokens || 0),
                  0,
                  Number(failureUsage.requestCount || 0),
                  failureUsage.accuracy || 'mixed'
                );
              }
              if (ledgerTaskCreated) {
                try { await stopLedgerTask(taskLedger, taskContract, error, failureUsage, false); }
                catch { /* o erro original continua sendo a fonte canonica da resposta */ }
              }
              const failure = safeError(error);
              const terminalContent = terminalExecutionReport(error, taskContract, failureUsage);
              const terminalAssistant = await store.addMessage(id, {
                role: 'assistant',
                content: terminalContent,
                meta: {
                  terminalReport: true,
                  terminalStatus: 'failed',
                  providerId: error?.providerId || failureProviderId,
                  provider: error?.provider || null,
                  model: error?.model || error?.attempts?.at?.(-1)?.model || null,
                  usage: failureUsage,
                  task: error?.task || taskContract,
                  verification: error?.verification || null,
                  attempts: error?.attempts || []
                }
              });
              telemetry.emit({
                category: 'agent', type: 'agent.failed',
                title: failure.code === 'task_verification_failed' ? 'Tarefa encerrada sem falso sucesso' : 'Execução encerrada com relatório final',
                detail: failure.message, conversationId: id, level: 'error', thought: true,
                meta: {
                  code: failure.code,
                  attempts: error.attempts?.length || 0,
                  usage: failureUsage,
                  task: error?.task || taskContract
                }
              });
              sseSend(response, 'done', {
                message: publicMessage(terminalAssistant),
                conversation: store.listConversations().find(item => item.id === id),
                providers: orchestrator.statuses(),
                terminal: {
                  status: 'failed',
                  ready: false,
                  error: failure,
                  usage: failureUsage,
                  task: error?.task || taskContract
                }
              });
            }
          } finally {
            request.off('aborted', stopOnDisconnect);
            response.off('close', stopOnDisconnect);
            activeControllers.delete(generationController);
            activeConversations.delete(id);
            approvalManager.cancelConversation(id);
            if (!response.destroyed && !response.writableEnded) response.end();
          }
          return;
        }
      }

      if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: { code: 'not_found', message: 'Rota não encontrada.' } });
      if (request.method === 'GET' && await serveStatic(response, staticRoot, url.pathname)) return;
      sendJson(response, 404, { error: { code: 'not_found', message: 'Página não encontrada.' } });
    } catch (error) {
      telemetry.emit({
        category: 'server', type: 'server.request.error', title: 'Falha ao processar solicitação',
        detail: error.status ? error.message : 'Erro interno tratado pelo Genesis.', level: 'error',
        meta: { method: request.method, path: String(request.url || '').split('?')[0], status: error.status || 500, code: error.code || 'server_error' }
      });
      sendJson(response, error.status || 500, { error: { code: error.code || 'server_error', message: error.status ? error.message : 'Falha interna do Genesis.' } });
    }
  };
  handler.beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const controller of activeControllers) controller.abort();
    for (const response of activeStreams) {
      sseSend(response, 'shutdown', { ok: true });
      response.end();
    }
    for (const conversationId of activeConversations) approvalManager.cancelConversation(conversationId);
    voiceRuntime?.beginShutdown?.();
  };
  handler.runtimeState = () => ({ shuttingDown, activeRequests: activeControllers.size, activeStreams: activeStreams.size });
  return handler;
}

export async function startServer(root = process.cwd()) {
  const config = createConfig(root);
  const store = await new GenesisStore(config.dataDir).init();
  const telemetry = await new GenesisTelemetry(config.dataDir).init();
  const voiceRuntime = await new VoiceRuntime({ root: config.root, dataDir: config.dataDir, telemetry }).init();
  const attachmentStore = await new AttachmentStore(config.dataDir).init();
  const projectStore = await new ProjectStore(config.dataDir).init();
  const permissionStore = await new PermissionStore(config.dataDir).init();
  const taskLedger = await new TaskLedgerStore(config.dataDir).init();
  
  // SupremeMind integration - create first so userMemory can use it
  const supremeMind = new SupremeMindIntegration(config.dataDir);
  
  const userMemory = await new UserMemoryStore(config.dataDir, supremeMind).init();
  const approvalManager = new ApprovalManager();
  const projectTools = new ProjectToolExecutor({ projectStore, permissionStore, approvalManager });
  const settings = await new OpenRouterSettings(config.dataDir, { environmentKey: config.providers.openrouter.apiKey }).init();
  
  const contextEngine = new ContextEngine({
    inputTokenBudget: config.inputTokenBudget,
    outputTokenBudget: config.outputTokenBudget,
    supremeMind,
    telemetry
  });
  const providers = createProviders(config, settings);
  const orchestrator = new GenesisOrchestrator({
    providers,
    imageProviders: createImageProviders(config, providers),
    contextEngine,
    outputTokenBudget: config.outputTokenBudget,
    maxRoutes: config.maxRoutesPerMessage,
    maxInferenceRequests: config.maxRequestsPerMessage,
    maxToolRequests: config.maxToolRequestsPerMessage,
    maxToolRounds: config.maxToolRounds
  });
  let shutdown;
  const handler = createHandler({
    config, store, orchestrator, telemetry, settings, attachmentStore, projectStore,
    permissionStore, approvalManager, projectTools, userMemory, supremeMind, taskLedger, voiceRuntime,
    onShutdown: () => shutdown()
  });
  const server = http.createServer(handler);
  shutdown = createRuntimeShutdown({
    server,
    handler,
    persistences: [store, projectStore, permissionStore, taskLedger, userMemory, voiceRuntime],
    telemetry
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(config.port, config.host, resolve));
  telemetry.emit({
    category: 'system', type: 'system.ready', title: 'Genesis Core online',
    detail: `Painel ativo em http://${config.host}:${config.port} · política free-only protegida.`, level: 'success'
  });
  console.log(`[Genesis] Painel ativo em http://${config.host}:${config.port}`);
  console.log('[Genesis] Política: somente modelos gratuitos; APIs pagas desativadas.');
  const runtime = { server, config, store, orchestrator, telemetry, settings, attachmentStore, projectStore, permissionStore, approvalManager, projectTools, userMemory, taskLedger, voiceRuntime };
  runtime.shutdown = shutdown;
  return runtime;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(runtime => {
    const stop = signal => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      runtime.shutdown().catch(error => {
        console.error(`[Genesis] Falha no encerramento após ${signal}: ${error?.stack || error}`);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => {
    console.error(`[Genesis] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
