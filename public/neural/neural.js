import {
  createEventBus, createSeenEventTracker, deriveTaskMetrics, eventModules,
  formatDuration, formatTokenCount, mergeGraph, moduleStateForEvent,
  normalizeEventType, normalizeGraphPayload, basename
} from './neural-core.js';
import { EVENT_MODULES, RUNTIME_MODULES, VIEW_IDS } from './neural.config.js';

const MAX_LOGS = 500;
const MAX_TIMELINE = 160;
const bus = createEventBus();
const seenEvents = createSeenEventTracker(1600);
const runtimeState = new Map(RUNTIME_MODULES.map(module => [module.id, {
  state: 'idle', title: module.description, timestamp: 0
}]));

const state = {
  view: 'overview',
  connection: 'connecting',
  connectionDetail: 'Aguardando handshake.',
  project: null,
  supremeMind: { indexed: false },
  bootstrap: null,
  neuralSnapshot: null,
  taskDetail: null,
  logs: [],
  paused: false,
  unseen: 0,
  activityOpen: false,
  indexing: false,
  indexProgress: { current: 0, total: 0, file: '' },
  graph: { nodes: [], edges: [] },
  selectedNode: null,
  selectedOrbit: null,
  graphLoading: false,
  graphError: '',
  graphViewBox: { x: -500, y: -350, width: 1000, height: 700 },
  graphZoom: 1,
  context: null,
  impact: null,
  orbit: null,
  memories: [],
  shuttingDown: false
};

let source = null;
let pollTimer = 0;
let clockTimer = 0;
let offlineTimer = 0;
let renderHandle = 0;
let snapshotRefreshTimer = 0;
let graphPan = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

function setText(selector, value) {
  const node = typeof selector === 'string' ? $(selector) : selector;
  if (node) node.textContent = String(value ?? '');
}

function setValue(selector, value) {
  const node = typeof selector === 'string' ? $(selector) : selector;
  if (node) node.value = String(value ?? '');
}

function setClass(node, base, modifier) {
  if (node) node.className = base + (modifier ? ' ' + modifier : '');
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('pt-BR') : '—';
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1).replace('.0', '') + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1).replace('.0', '') + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1).replace('.0', '') + ' KB';
  return Math.round(bytes) + ' B';
}

function formatDate(value) {
  if (!value) return 'Nunca indexado';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Data desconhecida';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function toast(message, type = '') {
  const region = $('#toastRegion');
  if (!region) return;
  const item = element('div', 'toast' + (type ? ' ' + type : ''), message);
  region.appendChild(item);
  window.setTimeout(() => item.remove(), 4200);
}

function errorMessage(error) {
  return String(error?.message || error || 'Não foi possível concluir a operação.');
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  headers.set('x-genesis-client', 'web');
  if (method !== 'GET' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, method, headers });
  const text = await response.text();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = { raw: text }; }
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Falha HTTP ' + response.status + '.');
    error.status = response.status;
    error.code = payload?.error?.code || 'http_error';
    error.payload = payload;
    throw error;
  }
  return payload;
}

function setConnection(kind, detail) {
  state.connection = kind;
  state.connectionDetail = detail || '';
  const badge = $('#connectionBadge');
  const label = badge?.querySelector('span');
  if (badge) badge.className = 'connection-badge ' + kind;
  if (label) label.textContent = kind === 'live' ? 'Ao vivo' : kind === 'offline' ? 'Offline' : kind === 'polling' ? 'Polling' : 'Conectando';
  renderDiagnostics();
}

function scheduleRender() {
  if (renderHandle || state.shuttingDown) return;
  renderHandle = requestAnimationFrame(() => {
    renderHandle = 0;
    renderOverview();
    renderRuntime();
    renderExecutionLog();
    renderTimeline();
    renderDiagnostics();
  });
}

function scheduleSnapshotRefresh(delay = 350, loadGraph = false) {
  clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = window.setTimeout(() => refreshSnapshot({ quiet: true, loadGraph }), delay);
}

function ingest(log, { live = true } = {}) {
  if (!log || !seenEvents.accept(log)) return false;
  state.logs.push(log);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  const type = normalizeEventType(log);
  if (type === 'agent.request.accepted') resetRuntime(false);
  for (const id of eventModules(log, EVENT_MODULES)) {
    const module = runtimeState.get(id);
    if (!module) continue;
    module.state = moduleStateForEvent(log);
    module.title = log.title || log.detail || type;
    module.timestamp = new Date(log.timestamp || Date.now()).getTime();
  }
  if (['agent.complete', 'agent.failed', 'agent.stopped'].includes(type)) {
    const terminalState = type === 'agent.complete' ? 'complete' : type === 'agent.stopped' ? 'waiting' : 'error';
    for (const module of runtimeState.values()) {
      if (!['processing', 'waiting'].includes(module.state)) continue;
      module.state = terminalState;
      module.title = log.title || log.detail || type;
      module.timestamp = new Date(log.timestamp || Date.now()).getTime();
    }
  }
  if (type === 'suprememind.index.progress' && live) {
    state.indexing = true;
    state.indexProgress = {
      current: Number(log.meta?.current || 0),
      total: Number(log.meta?.total || 0),
      file: String(log.meta?.file || log.detail || '')
    };
    renderIndexProgress();
  }
  if (type === 'suprememind.index.complete' && live) {
    state.indexing = false;
    scheduleSnapshotRefresh(150, true);
  }
  if (live && ['storage.project.opened', 'storage.project.opened.editable', 'storage.project.closed'].includes(type)) scheduleSnapshotRefresh();
  if (live && ['agent.request.accepted', 'agent.task.contract', 'agent.tool.completed', 'agent.complete', 'agent.failed', 'agent.stopped'].includes(type)) {
    scheduleSnapshotRefresh(type === 'agent.tool.completed' ? 650 : 250);
  }
  if (live && (!state.activityOpen || state.paused)) state.unseen += 1;
  bus.emit('telemetry', log);
  scheduleRender();
  return true;
}

function onSnapshot(event) {
  try {
    const payload = JSON.parse(event.data);
    for (const log of payload.logs || []) ingest(log, { live: false });
    scheduleRender();
  } catch (error) {
    console.warn('[neural] snapshot inválido', error);
  }
}

function onLog(event) {
  try { ingest(JSON.parse(event.data), { live: true }); }
  catch (error) { console.warn('[neural] evento inválido', error); }
}

function startPolling() {
  if (pollTimer || state.shuttingDown) return;
  const poll = async () => {
    try {
      const payload = await api('/api/logs?limit=300');
      for (const log of payload.logs || []) ingest(log, { live: true });
      setConnection('polling', 'EventSource indisponível; atualização a cada 3 segundos.');
    } catch (error) {
      setConnection('offline', errorMessage(error));
    }
  };
  poll();
  pollTimer = window.setInterval(poll, 3000);
}

function connectTelemetry() {
  if (state.shuttingDown) return;
  source?.close();
  source = null;
  clearTimeout(offlineTimer);
  if (!window.EventSource) return startPolling();
  setConnection('connecting', 'Reconectando ao stream local.');
  source = new EventSource('/api/logs/stream');
  source.addEventListener('open', () => {
    clearTimeout(offlineTimer);
    setConnection('live', 'Server-Sent Events conectado.');
  });
  source.addEventListener('snapshot', onSnapshot);
  source.addEventListener('log', onLog);
  source.addEventListener('error', () => {
    setConnection('connecting', 'O navegador tentará reconectar automaticamente.');
    clearTimeout(offlineTimer);
    offlineTimer = window.setTimeout(() => setConnection('offline', 'Stream indisponível; aguardando o servidor.'), 7000);
  });
}

function normalizeSupremeStatus(status, bootstrap) {
  const fallback = bootstrap?.supremeMind || {};
  if (status && typeof status.indexed === 'boolean') return status;
  return fallback;
}

function latestTaskSummary() {
  const tasks = state.neuralSnapshot?.tasks?.tasks || [];
  if (!state.project?.id) return tasks[0] || null;
  return tasks.find(task => !task.projectId || task.projectId === state.project.id) || null;
}

function metricsWithLedger() {
  const metrics = deriveTaskMetrics(state.logs);
  const task = latestTaskSummary();
  if (!task) return metrics;
  const usage = task.usage || {};
  const reported = Number(usage.reportedRequests || 0);
  const estimated = Number(usage.estimatedRequests || 0);
  const unknown = Number(usage.unknownRequests || 0);
  const startedAt = new Date(task.createdAt || 0).getTime();
  const endedAt = new Date(task.completedAt || task.failedAt || task.updatedAt || Date.now()).getTime();
  const status = task.status === 'completed' ? 'complete'
    : task.status === 'failed' ? 'error'
      : task.status === 'cancelled' ? 'stopped'
        : ['running', 'planned'].includes(task.status) ? 'processing' : metrics.status;
  return {
    ...metrics,
    status,
    objective: task.objective,
    elapsedMs: Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : metrics.elapsedMs,
    inputTokens: Number(usage.inputTokens ?? metrics.inputTokens),
    outputTokens: Number(usage.outputTokens ?? metrics.outputTokens),
    totalTokens: Number(usage.totalTokens ?? metrics.totalTokens),
    requestCount: Number(usage.requestCount ?? metrics.requestCount),
    accuracy: reported && estimated ? 'mixed' : reported ? 'reported' : estimated ? 'estimated' : unknown ? 'unknown' : metrics.accuracy
  };
}

async function hydrateTaskDetail(task) {
  if (!task?.id) {
    state.taskDetail = null;
    return;
  }
  if (state.taskDetail?.id === task.id && state.taskDetail?.updatedAt === task.updatedAt) return;
  try {
    const payload = await api('/api/tasks/' + encodeURIComponent(task.id));
    state.taskDetail = payload.task || null;
  } catch {
    state.taskDetail = null;
  }
}

function resetProjectData() {
  state.graph = { nodes: [], edges: [] };
  state.selectedNode = null;
  state.selectedOrbit = null;
  state.graphError = '';
  state.context = null;
  state.impact = null;
  state.orbit = null;
  state.memories = [];
  updateKnownPaths();
}

async function refreshSnapshot({ quiet = false, loadGraph: shouldLoadGraph = false } = {}) {
  if (!quiet) setText('#bootMessage', 'Lendo projeto, índice e métricas…');
  const previousProjectId = state.project?.id || null;
  try {
    const snapshot = await api('/api/neural/snapshot');
    state.neuralSnapshot = snapshot;
    state.project = snapshot.project || null;
    state.supremeMind = normalizeSupremeStatus(snapshot.supremeMind, snapshot);
    state.bootstrap = {
      ...(state.bootstrap || {}),
      project: snapshot.project || null,
      supremeMind: snapshot.supremeMind || { indexed: false },
      telemetry: snapshot.telemetry || {},
      runtime: snapshot.runtime || {}
    };
    for (const log of snapshot.telemetry?.events || []) ingest(log, { live: false });
    const indexing = snapshot.supremeMind?.indexing;
    if (indexing?.status === 'running') {
      state.indexing = true;
      state.indexProgress = {
        current: Number(indexing.current || 0),
        total: Number(indexing.total || 0),
        file: String(indexing.file || '')
      };
    } else if (indexing?.status === 'completed' || indexing?.status === 'failed') {
      state.indexing = false;
    }
    await hydrateTaskDetail(latestTaskSummary());
  } catch (snapshotError) {
    const requests = await Promise.allSettled([
      api('/api/bootstrap'), api('/api/project'), api('/api/suprememind/status')
    ]);
    const successful = requests.filter(result => result.status === 'fulfilled');
    if (!successful.length) {
      setConnection('offline', 'A API local não respondeu.');
      renderAll();
      if (!quiet) throw snapshotError;
      return;
    }
    const bootstrap = requests[0].status === 'fulfilled' ? requests[0].value : state.bootstrap;
    const projectPayload = requests[1].status === 'fulfilled' ? requests[1].value : null;
    const statusPayload = requests[2].status === 'fulfilled' ? requests[2].value : null;
    state.neuralSnapshot = null;
    state.taskDetail = null;
    state.bootstrap = bootstrap;
    state.project = projectPayload ? projectPayload.project : bootstrap?.project || state.project;
    state.supremeMind = normalizeSupremeStatus(statusPayload, bootstrap);
  }
  if (previousProjectId !== (state.project?.id || null)) resetProjectData();
  renderAll();
  if (shouldLoadGraph && state.project && state.supremeMind?.indexed) await loadGraph({ quiet: true });
}

export function shutdown() {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  source?.close(); source = null;
  clearInterval(pollTimer); pollTimer = 0;
  clearInterval(clockTimer); clockTimer = 0;
  clearTimeout(offlineTimer); offlineTimer = 0;
  clearTimeout(snapshotRefreshTimer); snapshotRefreshTimer = 0;
  if (renderHandle) cancelAnimationFrame(renderHandle);
  renderHandle = 0;
  bus.clear();
}

function resetRuntime(render = true) {
  for (const module of runtimeState.values()) {
    module.state = 'idle';
    module.title = '';
    module.timestamp = 0;
  }
  if (render) renderRuntime();
}

function taskLabel(status) {
  return ({ idle: 'Inativo', processing: 'Processando', complete: 'Concluído', error: 'Erro', stopped: 'Interrompido' })[status] || status;
}

function renderOverview() {
  const project = state.project;
  const supreme = state.supremeMind || {};
  const info = supreme.projectInfo || {};
  const intelligence = state.neuralSnapshot?.intelligence;
  const metrics = metricsWithLedger();
  const projectPill = $('#projectPill');
  projectPill?.classList.toggle('active', Boolean(project));
  setText('#projectName', project?.name || 'Nenhum projeto');
  setText('#projectCardName', project?.name || 'Nenhum projeto');
  setText('#projectFileCount', project ? formatNumber(project.fileCount) : '—');
  setText('#projectLineCount', project ? formatNumber(project.totalLines) : '—');
  setText('#projectSize', project ? formatBytes(project.totalBytes) : '—');
  setText('#projectTech', project?.technologies?.length ? project.technologies.join(', ') : '—');
  setText('#projectArchitecture', intelligence?.architecture || '—');
  setText('#projectEntrypoints', intelligence?.entrypoints?.length ? intelligence.entrypoints.join(', ') : '—');

  const notice = $('#projectNotice');
  const indexButton = $('#indexButton');
  if (indexButton) {
    indexButton.disabled = !project || state.indexing;
    setText(indexButton.querySelector('span'), state.indexing ? 'Indexando…' : supreme.indexed ? 'Atualizar índice' : 'Indexar projeto');
  }
  if (!project) {
    setClass(notice, 'notice-card', 'empty');
    setText('#projectNoticeTitle', 'Abra um projeto no painel principal');
    setText('#projectNoticeText', 'O Cockpit Neural acompanhará o projeto ativo automaticamente.');
  } else if (supreme.indexed) {
    setClass(notice, 'notice-card', 'indexed');
    setText('#projectNoticeTitle', project.name + ' está conectado ao SupremeMind');
    setText('#projectNoticeText', formatNumber(info.fileCount || project.fileCount) + ' arquivos estruturados · índice gerado em ' + formatDate(info.generatedAt));
  } else {
    setClass(notice, 'notice-card', 'warning');
    setText('#projectNoticeTitle', project.name + ' ainda não possui índice estrutural');
    setText('#projectNoticeText', 'Indexe o projeto para ativar grafo, contexto, impacto, órbita e memória estrutural.');
  }

  const statusTitle = metrics.status === 'idle' ? 'Aguardando solicitação'
    : metrics.status === 'processing' ? metrics.lastEvent?.title || 'Genesis trabalhando'
    : metrics.status === 'complete' ? 'Última tarefa concluída'
    : metrics.status === 'stopped' ? 'Execução interrompida' : 'A última tarefa falhou';
  const statusDetail = metrics.objective || metrics.lastEvent?.detail || (metrics.status === 'idle'
    ? 'Envie uma mensagem no chat principal para acompanhar o fluxo aqui.'
    : 'O rastro detalhado está disponível na aba Execução.');
  setText('#taskStatusTitle', statusTitle);
  setText('#taskStatusDetail', statusDetail);
  setClass($('#taskStateBadge'), 'state-badge', metrics.status);
  setText('#taskStateBadge', taskLabel(metrics.status));
  setText('#taskModel', metrics.model || 'Automático');
  setText('#taskElapsed', formatDuration(metrics.elapsedMs));
  setText('#metricInput', formatTokenCount(metrics.inputTokens));
  setText('#metricOutput', formatTokenCount(metrics.outputTokens));
  setText('#metricTotal', formatTokenCount(metrics.totalTokens));
  setText('#metricRequests', formatNumber(metrics.requestCount));
  setText('#metricFallbacks', metrics.fallbacks + ' fallback' + (metrics.fallbacks === 1 ? '' : 's'));
  setText('#metricTools', metrics.tools + ' ferramenta' + (metrics.tools === 1 ? '' : 's'));
  setText('#usageAccuracy', metrics.accuracy === 'reported' ? 'Reportado pela API' : metrics.accuracy === 'estimated' ? 'Estimativa ao vivo' : metrics.accuracy === 'mixed' ? 'Medição mista' : 'Sem dados');

  setText('#statFiles', supreme.indexed ? formatNumber(info.fileCount ?? info.indexed ?? project?.fileCount) : '—');
  setText('#statSymbols', supreme.indexed ? formatNumber(info.symbolCount ?? info.symbols) : '—');
  setText('#statEdges', supreme.indexed ? formatNumber(info.edgeCount ?? info.edges) : '—');
  setText('#statBasins', supreme.indexed ? formatNumber(info.basinCount ?? info.basins) : '—');
  setText('#statTokens', supreme.indexed ? formatTokenCount(info.totalTokens ?? info.tokens) : '—');
  setText('#statGit', supreme.indexed ? formatNumber(info.gitCommits ?? info.commitCount ?? 0) : '—');
  setText('#indexCardTitle', supreme.indexed ? 'Índice estrutural online' : project ? 'Índice necessário' : 'Índice indisponível');
  setText('#indexCardDetail', supreme.indexed
    ? 'Busca híbrida, grafo, contexto e análise de impacto estão disponíveis.'
    : project ? intelligence?.architecture || 'Use “Indexar projeto” para preparar os recursos estruturais.' : 'Abra e indexe um projeto para ativar os recursos estruturais.');
  setText('#indexGeneratedAt', supreme.indexed ? 'Gerado em ' + formatDate(info.generatedAt) : 'Nunca indexado');
  setClass($('#indexStateBadge'), 'state-badge', state.indexing ? 'waiting' : supreme.indexed ? 'complete' : 'idle');
  setText('#indexStateBadge', state.indexing ? 'Indexando' : supreme.indexed ? 'Online' : 'Inativo');

  const navState = $('#navIndexState');
  setClass(navState, 'nav-index-state', state.indexing ? 'indexing' : supreme.indexed ? 'indexed' : project ? '' : 'error');
  setText('#navIndexLabel', state.indexing ? 'Indexando' : supreme.indexed ? 'Índice online' : project ? 'Índice necessário' : 'Sem projeto');
  renderIndexProgress();
}

function renderIndexProgress() {
  const container = $('#indexProgress');
  if (!container) return;
  container.hidden = !state.indexing;
  if (!state.indexing) return;
  const current = Number(state.indexProgress.current || 0);
  const total = Number(state.indexProgress.total || 0);
  const percent = total > 0 ? Math.max(0, Math.min(100, current / total * 100)) : 2;
  setText('#indexProgressValue', total > 0 ? Math.round(percent) + '%' : 'Preparando');
  setText('#indexProgressFile', state.indexProgress.file || 'Preparando arquivos…');
  const bar = $('#indexProgressBar');
  if (bar) {
    bar.value = Math.round(percent);
    bar.textContent = Math.round(percent) + '%';
  }
}

function renderRuntime() {
  const host = $('#runtimeFlow');
  if (!host) return;
  clear(host);
  for (const module of RUNTIME_MODULES) {
    const status = runtimeState.get(module.id) || { state: 'idle' };
    const card = element('article', 'runtime-node ' + status.state);
    card.dataset.module = module.id;
    card.append(element('strong', '', module.name));
    card.append(element('small', '', status.title || module.description));
    card.title = module.description;
    host.append(card);
  }
}

function renderExecutionLog() {
  const list = $('#executionLog');
  if (!list) return;
  clear(list);
  const metrics = metricsWithLedger();
  const task = state.taskDetail;
  if (task?.steps?.length) {
    for (const step of task.steps) {
      const row = element('li', 'step-' + (step.status || 'pending'));
      row.append(element('strong', '', step.index + '. ' + step.label));
      const detail = [step.status || 'pending', step.detail || step.goal].filter(Boolean).join(' · ');
      row.append(element('span', '', detail));
      list.append(row);
    }
    return;
  }
  const summary = latestTaskSummary();
  if (summary) {
    const row = element('li', 'step-' + (summary.status || 'pending'));
    row.append(element('strong', '', summary.objective || 'Tarefa registrada'));
    row.append(element('span', '', `${summary.completedSteps || 0}/${summary.stepCount || 0} etapas · ${summary.status || 'planejada'}`));
    list.append(row);
    return;
  }
  const logs = metrics.taskLogs.filter(log => normalizeEventType(log).startsWith('agent.')).slice(-60);
  if (!logs.length) {
    list.append(element('li', 'empty-row', 'Nenhuma tarefa executada nesta sessão.'));
    return;
  }
  for (const log of logs) {
    const row = element('li', String(log.level || 'info'));
    row.append(element('strong', '', log.title || normalizeEventType(log)));
    row.append(element('span', '', formatClock(log.timestamp) + (log.detail ? ' · ' + log.detail : '')));
    list.append(row);
  }
}

function filteredLogs() {
  const query = String($('#eventSearch')?.value || '').trim().toLowerCase();
  const level = String($('#eventLevel')?.value || '');
  return state.logs.filter(log => {
    if (level && log.level !== level) return false;
    if (!query) return true;
    return [log.title, log.detail, log.type, log.category, log.providerId].some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderTimeline() {
  const list = $('#eventTimeline');
  if (!list || state.paused) {
    renderActivityMeta();
    return;
  }
  clear(list);
  const logs = filteredLogs().slice(-MAX_TIMELINE).reverse();
  if (!logs.length) {
    list.append(element('li', 'empty-row', state.logs.length ? 'Nenhum evento corresponde aos filtros.' : 'Aguardando eventos reais do Genesis…'));
  } else {
    for (const log of logs) {
      const row = element('li', 'event-item ' + (log.level || 'info'));
      row.append(element('time', '', formatClock(log.timestamp) + ' · ' + (log.category || 'sistema')));
      row.append(element('strong', '', log.title || normalizeEventType(log)));
      if (log.detail) row.append(element('span', '', log.detail));
      list.append(row);
    }
  }
  renderActivityMeta();
}

function renderActivityMeta() {
  setText('#eventCount', state.logs.length + ' evento' + (state.logs.length === 1 ? '' : 's'));
  setText('#eventBufferState', state.paused ? 'Pausado' : state.connection === 'live' ? 'Ao vivo' : 'Reconectando');
  setText('#pauseEventsButton', state.paused ? 'Retomar' : 'Pausar');
  const badge = $('#unseenBadge');
  if (badge) {
    badge.hidden = state.unseen < 1;
    badge.textContent = state.unseen > 99 ? '99+' : String(state.unseen);
  }
}

function diagnosticRows(metrics = {}) {
  return [
    ['Tokens enviados', formatTokenCount(metrics.tokensSent)],
    ['Tokens recebidos', formatTokenCount(metrics.tokensReceived)],
    ['Tokens economizados', formatTokenCount(metrics.tokensSaved)],
    ['Requests ao provedor', formatNumber(metrics.providerRequestCount)],
    ['Fallbacks', formatNumber(metrics.fallbacks)],
    ['Retries', formatNumber(metrics.retries)],
    ['Cache hit rate', metrics.cacheHitRate || '—'],
    ['Latência média', metrics.avgLatencyMs ? formatDuration(metrics.avgLatencyMs) : '—'],
    ['Heap do Genesis', metrics.memoryUsage?.heapUsed ? formatBytes(metrics.memoryUsage.heapUsed) : '—']
  ];
}

function renderDiagnostics() {
  setText('#diagStream', state.connection === 'live' ? 'Ao vivo' : state.connection === 'polling' ? 'Polling ativo' : state.connection === 'offline' ? 'Offline' : 'Reconectando');
  setText('#diagStreamDetail', state.connectionDetail || 'Sem detalhes.');
  setText('#diagIndex', state.indexing ? 'Indexando' : state.supremeMind?.indexed ? 'Online' : 'Inativo');
  setText('#diagIndexDetail', state.supremeMind?.indexed ? formatNumber(state.supremeMind.projectInfo?.fileCount) + ' arquivos estruturados.' : state.project ? 'Projeto ainda não indexado.' : 'Nenhum projeto ativo.');
  const task = metricsWithLedger();
  const providerStatus = state.neuralSnapshot?.runtime?.providers?.find(provider => provider.state === 'ready')
    || state.neuralSnapshot?.runtime?.providers?.find(provider => provider.configured)
    || state.neuralSnapshot?.runtime?.providers?.[0];
  setText('#diagProvider', task.provider || providerStatus?.name || '—');
  setText('#diagProviderDetail', task.model
    ? task.model + ' · ' + task.requestCount + ' request(s)'
    : providerStatus ? (providerStatus.state || 'desconhecido') + ' · ' + (providerStatus.selectionMode || 'automático') : 'Nenhuma rota usada.');
  setText('#diagEvents', state.logs.length + ' eventos');
  setText('#diagEventsDetail', seenEvents.size + ' IDs únicos no deduplicador.');
  const list = $('#diagnosticMetrics');
  if (list) {
    clear(list);
    for (const [label, value] of diagnosticRows(state.neuralSnapshot?.telemetry?.metrics || state.bootstrap?.telemetry?.metrics || {})) {
      const row = element('div'); row.append(element('dt', '', label)); row.append(element('dd', '', value)); list.append(row);
    }
  }
  const errors = $('#diagnosticErrors');
  if (errors) {
    clear(errors);
    const rows = state.logs.filter(log => log.level === 'error').slice(-30).reverse();
    if (!rows.length) errors.append(element('p', 'empty-row', 'Nenhum erro no buffer atual.'));
    for (const log of rows) {
      const item = element('article', 'error-item');
      item.append(element('strong', '', log.title || normalizeEventType(log)));
      item.append(element('span', '', formatClock(log.timestamp) + (log.detail ? ' · ' + log.detail : '')));
      errors.append(item);
    }
  }
}

function requireProject() {
  if (!state.project) {
    toast('Abra um projeto no painel principal primeiro.', 'error');
    return false;
  }
  return true;
}

function requireIndex() {
  if (!requireProject()) return false;
  if (!state.supremeMind?.indexed) {
    toast('Indexe o projeto para usar este recurso.', 'error');
    setView('overview');
    return false;
  }
  return true;
}

async function indexProject() {
  if (!requireProject() || state.indexing) return;
  state.indexing = true;
  state.indexProgress = { current: 0, total: 0, file: '' };
  renderAll();
  try {
    await api('/api/suprememind/index', { method: 'POST', body: JSON.stringify({ force: false }) });
    state.indexing = false;
    toast('Índice estrutural atualizado.', 'success');
    await refreshSnapshot({ quiet: true, loadGraph: true });
  } catch (error) {
    state.indexing = false;
    if (error.code === 'index_in_progress') {
      await refreshSnapshot({ quiet: true });
      toast('A indexação já está em andamento.', 'success');
    } else {
      toast(errorMessage(error), 'error');
    }
    renderAll();
  }
}

function graphFallbackQuery() {
  const typed = String($('#graphQuery')?.value || '').trim();
  return typed || state.project?.name || 'main core game project';
}

async function loadGraph({ quiet = false, query = '' } = {}) {
  if (!state.supremeMind?.indexed || state.graphLoading) return;
  state.graphLoading = true;
  state.graphError = '';
  renderGraph();
  let payload = null;
  try {
    if (!query) {
      try { payload = await api('/api/suprememind/graph?nodes=350&edges=1400'); }
      catch (error) {
        if (![404, 405].includes(error.status)) throw error;
      }
    }
    if (!payload) {
      payload = await api('/api/suprememind/query', {
        method: 'POST', body: JSON.stringify({ query: query || graphFallbackQuery(), limit: 120 })
      });
    }
    state.graph = normalizeGraphPayload(payload);
    state.graphError = '';
    state.selectedNode = null;
    state.selectedOrbit = null;
    resetGraphView();
    renderGraph();
    updateKnownPaths();
    if (!quiet) toast(state.graph.nodes.length + ' arquivo(s) carregado(s) no grafo.', 'success');
  } catch (error) {
    state.graphError = errorMessage(error);
    if (!quiet) toast(errorMessage(error), 'error');
  } finally {
    state.graphLoading = false;
    renderGraph();
  }
}

async function searchGraph() {
  if (!requireIndex()) return;
  const query = String($('#graphQuery')?.value || '').trim();
  if (!query) return toast('Digite o que deseja localizar no projeto.', 'error');
  await loadGraph({ query });
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function graphPositions(nodes) {
  const positions = new Map();
  if (!nodes.length) return positions;
  const groups = new Map();
  for (const node of nodes) {
    const key = node.basin || node.language || 'project';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const groupRadius = entries.length === 1 ? 0 : Math.min(280, 120 + entries.length * 17);
  entries.forEach(([key, members], groupIndex) => {
    const angle = entries.length === 1 ? 0 : Math.PI * 2 * groupIndex / entries.length;
    const centerX = Math.cos(angle) * groupRadius;
    const centerY = Math.sin(angle) * groupRadius * .72;
    members.sort((a, b) => (b.centrality || b.score || 0) - (a.centrality || a.score || 0) || a.path.localeCompare(b.path));
    members.forEach((node, index) => {
      const radial = index === 0 ? 0 : 34 + Math.sqrt(index) * 25;
      const nodeAngle = index * 2.3999632297 + (hashText(key) % 100) / 100;
      positions.set(node.id, { x: centerX + Math.cos(nodeAngle) * radial, y: centerY + Math.sin(nodeAngle) * radial });
    });
  });
  return positions;
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function graphNodeRadius(node) {
  const score = Math.max(Number(node.centrality || 0), Number(node.score || 0));
  return Math.max(8, Math.min(20, 8 + Math.sqrt(score) * 12));
}

function shortLabel(value, limit = 22) {
  const label = basename(value);
  return label.length > limit ? label.slice(0, limit - 1) + '…' : label;
}

function renderGraph(error = '') {
  const svg = $('#projectGraph');
  const empty = $('#graphEmpty');
  if (!svg || !empty) return;
  clear(svg);
  if (state.graphLoading) {
    svg.setAttribute('hidden', ''); empty.removeAttribute('hidden');
    setText(empty.querySelector('strong'), 'Carregando estrutura do projeto…');
    setText(empty.querySelector('small'), 'A consulta é local e não consome modelos da OpenRouter.');
    return;
  }
  const displayError = error || state.graphError;
  if (displayError || !state.graph.nodes.length) {
    svg.setAttribute('hidden', ''); empty.removeAttribute('hidden');
    setText(empty.querySelector('strong'), displayError ? 'Não foi possível carregar o grafo' : state.supremeMind?.indexed ? 'Faça uma busca para explorar o projeto' : 'O mapa estrutural aparecerá aqui');
    setText(empty.querySelector('small'), displayError || (state.supremeMind?.indexed ? 'Use nomes de sistemas, arquivos ou funções.' : 'Indexe o projeto e faça uma busca para carregar arquivos e relações reais.'));
    renderNodeInspector();
    return;
  }
  empty.setAttribute('hidden', ''); svg.removeAttribute('hidden');
  applyGraphViewBox();
  const positions = graphPositions(state.graph.nodes);
  const edgeGroup = svgElement('g', { class: 'graph-edges' });
  for (const edge of state.graph.edges) {
    const sourcePos = positions.get(edge.source);
    const targetPos = positions.get(edge.target);
    if (!sourcePos || !targetPos) continue;
    edgeGroup.append(svgElement('line', {
      x1: sourcePos.x, y1: sourcePos.y, x2: targetPos.x, y2: targetPos.y,
      class: 'graph-edge ' + String(edge.type || '').replaceAll('_', '-'),
      'data-edge-type': edge.type || 'relation'
    }));
  }
  svg.append(edgeGroup);
  const nodeGroup = svgElement('g', { class: 'graph-nodes' });
  const selectedId = state.selectedNode?.id;
  state.graph.nodes.forEach((node, index) => {
    const position = positions.get(node.id);
    if (!position) return;
    const group = svgElement('g', {
      class: 'graph-node' + (selectedId === node.id ? ' selected' : ''),
      transform: 'translate(' + position.x + ' ' + position.y + ')',
      tabindex: '0', role: 'button',
      'aria-label': node.path + ', ' + (node.language || 'arquivo'),
      'data-node-id': node.id, 'data-language': node.language || 'text'
    });
    group.append(svgElement('circle', { r: graphNodeRadius(node) }));
    const title = svgElement('title'); title.textContent = node.path; group.append(title);
    if (state.graph.nodes.length <= 90 || index < 35 || selectedId === node.id) {
      const label = svgElement('text', { y: graphNodeRadius(node) + 15 }); label.textContent = shortLabel(node.path); group.append(label);
    }
    group.addEventListener('click', event => { event.stopPropagation(); selectGraphNode(node); });
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectGraphNode(node); } });
    nodeGroup.append(group);
  });
  svg.append(nodeGroup);
  renderNodeInspector();
}

function relationNodesFromOrbit(orbit) {
  const paths = new Set();
  for (const edge of [...(orbit?.outgoing || []), ...(orbit?.incoming || [])]) {
    if (edge.source) paths.add(String(edge.source));
    if (edge.target) paths.add(String(edge.target));
  }
  for (const level of orbit?.levels || []) for (const path of level.nodes || []) paths.add(String(path));
  return [...paths].map(path => ({ id: path, path, label: basename(path) }));
}

function orbitGraphAddition(orbit) {
  const rawEdges = [...(orbit?.outgoing || []), ...(orbit?.incoming || [])];
  const edges = rawEdges.flatMap((edge, index) => {
    const sourceId = String(edge.source || '');
    const targetId = String(edge.target || '');
    if (!sourceId || !targetId) return [];
    return [{ ...edge, id: String(edge.id || sourceId + '|' + targetId + '|' + (edge.type || index)), source: sourceId, target: targetId, type: edge.type || 'relation', weight: Number(edge.weight || .5) }];
  });
  return { nodes: relationNodesFromOrbit(orbit), edges };
}

async function selectGraphNode(node) {
  state.selectedNode = node;
  state.selectedOrbit = null;
  setValue('#impactPath', node.path);
  renderGraph();
  renderNodeInspector(true);
  try {
    const orbit = await api('/api/suprememind/orbit', { method: 'POST', body: JSON.stringify({ path: node.path, depth: 2 }) });
    state.selectedOrbit = orbit;
    state.graph = mergeGraph(state.graph, orbitGraphAddition(orbit));
    state.selectedNode = state.graph.nodes.find(item => item.path === node.path) || node;
    updateKnownPaths();
    renderGraph();
  } catch (error) {
    state.selectedOrbit = { error: errorMessage(error), outgoing: [], incoming: [] };
    renderNodeInspector();
  }
}

function relationButton(edge, direction) {
  const path = direction === 'outgoing' ? edge.target : edge.source;
  const button = element('button', '', path + ' · ' + (edge.type || 'relação'));
  button.type = 'button';
  button.addEventListener('click', () => {
    const node = state.graph.nodes.find(item => item.path === path) || { id: path, path, label: basename(path), language: 'text' };
    selectGraphNode(node);
  });
  return button;
}

function renderNodeInspector(loading = false) {
  const inspector = $('#nodeInspector');
  if (!inspector) return;
  clear(inspector);
  const node = state.selectedNode;
  if (!node) {
    inspector.append(element('span', 'inspector-empty', 'Selecione um nó para ver sua órbita.'));
    return;
  }
  inspector.append(element('h2', '', node.path));
  const tags = element('div', 'inspector-tags');
  tags.append(element('span', 'tag', node.language || 'texto'));
  if (node.basin) tags.append(element('span', 'tag', 'Bacia: ' + basename(node.basin)));
  if (Number.isFinite(Number(node.score))) tags.append(element('span', 'tag', 'Score: ' + (Number(node.score) * 100).toFixed(1) + '%'));
  inspector.append(tags);
  inspector.append(element('p', '', node.summary || 'Sem resumo estrutural disponível.'));
  if (loading) {
    inspector.append(element('span', 'inspector-empty', 'Carregando órbita…'));
    return;
  }
  const orbit = state.selectedOrbit;
  if (orbit?.error) inspector.append(element('p', 'error-text', orbit.error));
  const outgoing = element('div', 'relation-list'); outgoing.append(element('h3', '', 'SAÍDAS · ' + (orbit?.outgoing?.length || 0)));
  for (const edge of (orbit?.outgoing || []).slice(0, 30)) outgoing.append(relationButton(edge, 'outgoing'));
  if (!orbit?.outgoing?.length) outgoing.append(element('p', 'empty-row', 'Nenhuma saída detectada.'));
  inspector.append(outgoing);
  const incoming = element('div', 'relation-list'); incoming.append(element('h3', '', 'ENTRADAS · ' + (orbit?.incoming?.length || 0)));
  for (const edge of (orbit?.incoming || []).slice(0, 30)) incoming.append(relationButton(edge, 'incoming'));
  if (!orbit?.incoming?.length) incoming.append(element('p', 'empty-row', 'Nenhuma entrada detectada.'));
  inspector.append(incoming);
}

function updateKnownPaths() {
  const datalist = $('#knownFilePaths');
  if (!datalist) return;
  clear(datalist);
  const unique = [...new Set(state.graph.nodes.map(node => node.path))].sort();
  for (const path of unique) {
    const option = element('option'); option.value = path; datalist.append(option);
  }
}

function applyGraphViewBox() {
  const box = state.graphViewBox;
  $('#projectGraph')?.setAttribute('viewBox', [box.x, box.y, box.width, box.height].join(' '));
  setText('#zoomResetButton', Math.round(state.graphZoom * 100) + '%');
}

function resetGraphView() {
  state.graphZoom = 1;
  state.graphViewBox = { x: -500, y: -350, width: 1000, height: 700 };
  applyGraphViewBox();
}

function zoomGraph(factor) {
  const old = state.graphViewBox;
  const width = Math.max(260, Math.min(3000, old.width / factor));
  const height = width * .7;
  state.graphViewBox = { x: old.x + (old.width - width) / 2, y: old.y + (old.height - height) / 2, width, height };
  state.graphZoom = 1000 / width;
  applyGraphViewBox();
}

function renderContext() {
  const result = state.context;
  const files = $('#contextFiles');
  if (!files) return;
  clear(files);
  if (!result) {
    setText('#contextSelectionTitle', 'Nenhuma consulta');
    files.append(element('p', 'empty-row', 'Os níveis L0, L1 e L2 aparecerão aqui.'));
    setText('#contextPreview', 'Nenhum contexto gerado.');
    $('#copyContextButton').disabled = true;
    return;
  }
  const selected = result.selected || [];
  setText('#contextSelectionTitle', selected.length + ' arquivo' + (selected.length === 1 ? '' : 's') + ' · ' + formatTokenCount(result.usedTokens) + '/' + formatTokenCount(result.budget) + ' tokens');
  if (!selected.length) files.append(element('p', 'empty-row', 'Nenhum arquivo coube no orçamento informado.'));
  for (const item of selected) {
    const card = element('article', 'selected-file');
    const header = element('header');
    header.append(element('strong', '', item.path || 'Arquivo'));
    header.append(element('span', '', item.level || 'L2'));
    card.append(header);
    const factors = [];
    if (item.source) factors.push('origem ' + item.source);
    if (item.estimatedTokens) factors.push(formatTokenCount(item.estimatedTokens) + ' tokens');
    if (Number.isFinite(Number(item.score))) factors.push((Number(item.score) * 100).toFixed(1) + '% relevância');
    card.append(element('p', '', factors.join(' · ') || item.summary || 'Selecionado pelo índice estrutural.'));
    files.append(card);
  }
  setText('#contextPreview', result.markdown || 'O backend não retornou um preview textual.');
  $('#copyContextButton').disabled = !result.markdown;
}

async function buildContext() {
  if (!requireIndex()) return;
  const query = String($('#contextQuery')?.value || '').trim();
  const budget = Number($('#contextBudget')?.value || 6000);
  if (!query) return toast('Descreva a tarefa que receberá o contexto.', 'error');
  const button = $('#contextButton');
  button.disabled = true; setText(button, 'Montando…');
  try {
    state.context = await api('/api/suprememind/context', { method: 'POST', body: JSON.stringify({ query, budget }) });
    renderContext();
    toast('Contexto estrutural montado sem chamada de modelo.', 'success');
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    button.disabled = false; setText(button, 'Montar contexto');
  }
}

async function copyContext() {
  if (!state.context?.markdown) return;
  try {
    await navigator.clipboard.writeText(state.context.markdown);
    toast('Contexto copiado.', 'success');
  } catch {
    toast('O navegador não permitiu copiar automaticamente.', 'error');
  }
}

function renderImpact() {
  const output = $('#impactOutput');
  if (!output) return;
  clear(output);
  const data = state.impact;
  if (!data) {
    output.append(element('p', 'empty-row', 'Nenhuma análise executada.'));
    setClass($('#impactRisk'), 'risk-badge', 'idle'); setText('#impactRisk', '—');
    return;
  }
  const risk = String(data.risk || 'LOW').toLowerCase();
  setClass($('#impactRisk'), 'risk-badge', risk);
  setText('#impactRisk', data.risk || '—');
  const summary = element('div', 'impact-summary');
  for (const [label, value] of [['Score', data.score ?? 0], ['Diretos', data.direct ?? 0], ['Indiretos', data.indirect ?? 0]]) {
    const item = element('span'); item.append(element('small', '', label)); item.append(element('strong', '', formatNumber(value))); summary.append(item);
  }
  output.append(summary);
  if (data.error) output.append(element('p', 'empty-row', data.error));
  for (const item of (data.impacted || []).slice(0, 160)) {
    const row = element('article', 'relation');
    row.append(element('strong', '', item.path || 'Arquivo'));
    row.append(element('small', '', 'nível ' + (item.depth ?? 0) + ' · ' + (item.type || 'relação') + ' · peso ' + Number(item.weight || 0).toFixed(3)));
    output.append(row);
  }
  if (!data.error && !data.impacted?.length) output.append(element('p', 'empty-row', 'Nenhum dependente detectado.'));
}

function renderOrbit() {
  const output = $('#orbitOutput');
  if (!output) return;
  clear(output);
  const data = state.orbit;
  if (!data) return output.append(element('p', 'empty-row', 'Nenhuma órbita carregada.'));
  if (data.error) output.append(element('p', 'empty-row', data.error));
  const sections = [['Saídas', data.outgoing || [], 'target'], ['Entradas', data.incoming || [], 'source']];
  for (const [title, items, key] of sections) {
    const group = element('section', 'relation-list'); group.append(element('h3', '', title.toUpperCase() + ' · ' + items.length));
    for (const item of items.slice(0, 100)) {
      const row = element('article', 'relation');
      row.append(element('strong', '', item[key] || 'Arquivo'));
      row.append(element('small', '', (item.type || 'relação') + ' · peso ' + Number(item.weight || 0).toFixed(3)));
      group.append(row);
    }
    if (!items.length) group.append(element('p', 'empty-row', 'Nenhuma relação detectada.'));
    output.append(group);
  }
}

async function runImpact() {
  if (!requireIndex()) return;
  const path = String($('#impactPath')?.value || '').trim();
  const depth = Number($('#impactDepth')?.value || 3);
  if (!path) return toast('Informe o caminho de um arquivo indexado.', 'error');
  const button = $('#impactButton'); button.disabled = true; setText(button, 'Analisando…');
  try {
    state.impact = await api('/api/suprememind/impact', { method: 'POST', body: JSON.stringify({ path, depth }) });
    renderImpact();
  } catch (error) { toast(errorMessage(error), 'error'); }
  finally { button.disabled = false; setText(button, 'Analisar impacto'); }
}

async function runOrbit() {
  if (!requireIndex()) return;
  const path = String($('#impactPath')?.value || '').trim();
  const depth = Number($('#impactDepth')?.value || 3);
  if (!path) return toast('Informe o caminho de um arquivo indexado.', 'error');
  const button = $('#orbitButton'); button.disabled = true; setText(button, 'Mapeando…');
  try {
    state.orbit = await api('/api/suprememind/orbit', { method: 'POST', body: JSON.stringify({ path, depth }) });
    renderOrbit();
    state.graph = mergeGraph(state.graph, orbitGraphAddition(state.orbit));
    updateKnownPaths();
    renderGraph();
  } catch (error) { toast(errorMessage(error), 'error'); }
  finally { button.disabled = false; setText(button, 'Mapear órbita'); }
}

function renderMemories() {
  const host = $('#memoryList');
  if (!host) return;
  clear(host);
  const query = String($('#memoryFilter')?.value || '').trim().toLowerCase();
  const rows = state.memories.filter(memory => !query || [memory.title, memory.content, ...(memory.tags || [])].some(value => String(value || '').toLowerCase().includes(query)));
  if (!rows.length) {
    host.append(element('p', 'empty-row', state.memories.length ? 'Nenhuma memória corresponde ao filtro.' : 'Nenhuma memória gravada para este projeto.'));
    return;
  }
  for (const memory of rows) {
    const item = element('article', 'memory-item');
    item.append(element('h3', '', memory.title || 'Memória'));
    item.append(element('p', '', memory.content || ''));
    const meta = element('div', 'memory-meta');
    meta.append(element('span', 'tag', memory.status || 'recorded'));
    for (const tag of memory.tags || []) meta.append(element('span', 'tag', tag));
    if (memory.createdAt) meta.append(element('span', 'tag', formatDate(memory.createdAt)));
    item.append(meta); host.append(item);
  }
}

async function loadMemories({ quiet = false } = {}) {
  if (!state.project) { state.memories = []; renderMemories(); return; }
  try {
    const payload = await api('/api/suprememind/memories?limit=100');
    state.memories = payload.memories || [];
    renderMemories();
  } catch (error) {
    state.memories = [];
    renderMemories();
    if (!quiet) toast(errorMessage(error), 'error');
  }
}

async function saveMemory() {
  if (!requireProject()) return;
  const title = String($('#memoryTitle')?.value || '').trim();
  const content = String($('#memoryContent')?.value || '').trim();
  if (!title || !content) return toast('Preencha título e conteúdo da memória.', 'error');
  const body = {
    title, content,
    files: String($('#memoryFiles')?.value || '').split(',').map(value => value.trim()).filter(Boolean),
    tags: String($('#memoryTags')?.value || '').split(',').map(value => value.trim()).filter(Boolean),
    status: $('#memoryStatus')?.value || 'recorded'
  };
  const button = $('#saveMemoryButton'); button.disabled = true; setText(button, 'Salvando…');
  try {
    await api('/api/suprememind/memory', { method: 'POST', body: JSON.stringify(body) });
    setValue('#memoryTitle', ''); setValue('#memoryContent', ''); setValue('#memoryFiles', ''); setValue('#memoryTags', '');
    await loadMemories({ quiet: true });
    toast('Memória registrada no projeto.', 'success');
  } catch (error) { toast(errorMessage(error), 'error'); }
  finally { button.disabled = false; setText(button, 'Salvar memória'); }
}

function setView(view, { updateHash = true } = {}) {
  const next = VIEW_IDS.includes(view) ? view : 'overview';
  state.view = next;
  for (const button of $$('[data-view]')) {
    const active = button.dataset.view === next;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const section of $$('.view')) {
    const active = section.id === 'view-' + next;
    section.hidden = !active;
    section.classList.toggle('active', active);
  }
  if (updateHash && location.hash !== '#' + next) history.replaceState(null, '', '#' + next);
  if (next === 'graph' && state.supremeMind?.indexed && !state.graph.nodes.length) loadGraph({ quiet: true });
  if (next === 'memory') loadMemories({ quiet: true });
  $('#workspace')?.scrollTo({ top: 0, behavior: 'auto' });
}

function setActivityOpen(open) {
  state.activityOpen = Boolean(open);
  $('#cockpitShell')?.classList.toggle('activity-open', state.activityOpen);
  $('#activityDrawer')?.setAttribute('aria-hidden', String(!state.activityOpen && matchMedia('(max-width: 1280px)').matches));
  $('#activityToggle')?.setAttribute('aria-expanded', String(state.activityOpen));
  if (state.activityOpen) state.unseen = 0;
  renderActivityMeta();
}

function syncActivityAccessibility() {
  const compact = matchMedia('(max-width: 1280px)').matches;
  $('#activityDrawer')?.setAttribute('aria-hidden', String(compact && !state.activityOpen));
  $('#activityToggle')?.setAttribute('aria-expanded', String(compact ? state.activityOpen : true));
}

function openNeuralHelp() {
  const dialog = $('#neuralHelpDialog');
  if (!dialog) return;
  const labels = {
    overview: 'Visão geral', execution: 'Execução', graph: 'Grafo', context: 'Contexto',
    impact: 'Impacto', memory: 'Memória', diagnostics: 'Diagnóstico'
  };
  setText('#helpCurrentView', labels[state.view] || 'Visão geral');
  const current = dialog.querySelector(`[data-help-view="${state.view}"]`);
  if (current) current.open = true;
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => current?.querySelector('summary')?.focus(), 0);
}

function closeNeuralHelp() {
  const dialog = $('#neuralHelpDialog');
  if (dialog?.open) dialog.close();
}

function renderAll() {
  renderOverview(); renderRuntime(); renderExecutionLog(); renderTimeline(); renderGraph();
  renderContext(); renderImpact(); renderOrbit(); renderMemories(); renderDiagnostics();
}

function bindGraphInteraction() {
  const svg = $('#projectGraph');
  if (!svg) return;
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    zoomGraph(event.deltaY < 0 ? 1.15 : .87);
  }, { passive: false });
  svg.addEventListener('pointerdown', event => {
    if (event.target.closest?.('.graph-node')) return;
    graphPan = { x: event.clientX, y: event.clientY, box: { ...state.graphViewBox } };
    svg.classList.add('panning');
    svg.setPointerCapture?.(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    if (!graphPan) return;
    const rect = svg.getBoundingClientRect();
    const dx = (event.clientX - graphPan.x) * graphPan.box.width / Math.max(rect.width, 1);
    const dy = (event.clientY - graphPan.y) * graphPan.box.height / Math.max(rect.height, 1);
    state.graphViewBox = { ...graphPan.box, x: graphPan.box.x - dx, y: graphPan.box.y - dy };
    applyGraphViewBox();
  });
  const stop = () => { graphPan = null; svg.classList.remove('panning'); };
  svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop);
}

function bindUi() {
  for (const button of $$('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
  $('#refreshButton')?.addEventListener('click', async () => {
    const button = $('#refreshButton'); button.disabled = true;
    try { await refreshSnapshot({ quiet: true, loadGraph: state.view === 'graph' }); toast('Cockpit atualizado.', 'success'); }
    catch (error) { toast(errorMessage(error), 'error'); }
    finally { button.disabled = false; }
  });
  $('#helpButton')?.addEventListener('click', openNeuralHelp);
  $('#closeHelpButton')?.addEventListener('click', closeNeuralHelp);
  $('#neuralHelpDialog')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closeNeuralHelp();
  });
  $('#closeButton')?.addEventListener('click', () => { shutdown(); window.close(); });
  $('#activityToggle')?.addEventListener('click', () => setActivityOpen(!state.activityOpen));
  $('#activityClose')?.addEventListener('click', () => setActivityOpen(false));
  $('#pauseEventsButton')?.addEventListener('click', () => { state.paused = !state.paused; if (!state.paused) { state.unseen = 0; renderTimeline(); } else renderActivityMeta(); });
  $('#eventSearch')?.addEventListener('input', renderTimeline); $('#eventLevel')?.addEventListener('change', renderTimeline);
  $('#indexButton')?.addEventListener('click', indexProject);
  $('#resetRuntimeButton')?.addEventListener('click', () => resetRuntime(true));
  $('#graphSearchButton')?.addEventListener('click', searchGraph);
  $('#graphQuery')?.addEventListener('keydown', event => { if (event.key === 'Enter') searchGraph(); });
  $('#zoomInButton')?.addEventListener('click', () => zoomGraph(1.2));
  $('#zoomOutButton')?.addEventListener('click', () => zoomGraph(.82));
  $('#zoomResetButton')?.addEventListener('click', resetGraphView);
  $('#contextBudget')?.addEventListener('input', event => setText('#contextBudgetValue', formatNumber(event.target.value)));
  $('#contextButton')?.addEventListener('click', buildContext); $('#copyContextButton')?.addEventListener('click', copyContext);
  $('#impactButton')?.addEventListener('click', runImpact); $('#orbitButton')?.addEventListener('click', runOrbit);
  $('#refreshMemoriesButton')?.addEventListener('click', () => loadMemories()); $('#memoryFilter')?.addEventListener('input', renderMemories); $('#saveMemoryButton')?.addEventListener('click', saveMemory);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.activityOpen) setActivityOpen(false); });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { updateHash: false }));
  window.addEventListener('resize', syncActivityAccessibility, { passive: true });
  bindGraphInteraction();
}

async function bootstrap() {
  bindUi();
  syncActivityAccessibility();
  setView(location.hash.slice(1) || 'overview', { updateHash: false });
  renderAll();
  connectTelemetry();
  try {
    await refreshSnapshot({ quiet: false, loadGraph: true });
  } catch (error) {
    setConnection('offline', errorMessage(error));
    toast('O Cockpit abriu em modo offline.', 'error');
  } finally {
    $('#bootScreen')?.classList.add('ready');
  }
  clockTimer = window.setInterval(() => { if (!document.hidden) renderOverview(); }, 1000);
}

window.NeuralAPI = {
  setMode(mode) {
    const aliases = { neural: 'execution', galaxy: 'graph', flux: 'execution', metrics: 'diagnostics', debug: 'diagnostics' };
    setView(aliases[mode] || mode);
  },
  getMode: () => state.view,
  getRecentEvents: () => state.logs.slice(-40),
  refresh: () => refreshSnapshot({ quiet: true, loadGraph: true }),
  on: (name, handler) => bus.on(name, handler),
  shutdown
};

window.addEventListener('beforeunload', shutdown);
window.addEventListener('pagehide', shutdown);

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
else queueMicrotask(bootstrap);
