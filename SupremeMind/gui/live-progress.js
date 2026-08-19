const transportFetch = window.fetch.bind(window);

const INDEX_ACTIONS = new Set(['query', 'context', 'orbit', 'impact', 'recall', 'graph', 'doctor', 'benchmark']);
const runtime = {
  active: false,
  state: 'idle',
  action: '',
  startedAt: 0,
  percent: 0,
  logCount: 0,
  droppedLogs: 0,
  timer: null,
  ui: null,
  status: null,
  statusAt: 0
};

function cleanLine(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function createLoadingUi(root) {
  root.replaceChildren();
  root.classList.add('sm-real-progress-active');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'busyText');

  const spinner = document.createElement('span');
  spinner.className = 'sm-loader-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const percent = document.createElement('span');
  percent.className = 'sm-real-percent';
  percent.textContent = '0%';
  spinner.append(percent);

  const title = document.createElement('strong');
  title.id = 'busyText';
  title.textContent = 'Processando...';

  const subtitle = document.createElement('span');
  subtitle.className = 'sm-progress-subtitle';
  subtitle.textContent = 'A porcentagem só avança quando o núcleo confirma trabalho concluído.';

  const meta = document.createElement('section');
  meta.className = 'sm-progress-meta';
  meta.innerHTML = `
    <p><span class="sm-progress-stage">Preparando</span><span class="sm-progress-count"></span></p>
    <p><span class="sm-progress-current"></span><span class="sm-progress-elapsed">0,0 s</span></p>`;

  const track = document.createElement('section');
  track.className = 'sm-real-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', '0');
  track.innerHTML = '<span class="sm-real-fill"></span>';

  const details = document.createElement('details');
  details.className = 'sm-progress-details';
  details.innerHTML = `
    <summary><span>Mostrar mais</span><b class="sm-log-badge">0</b></summary>
    <header class="sm-progress-console-head"><span>VERBOSE EM TEMPO REAL</span><button type="button">Limpar</button></header>
    <pre class="sm-progress-console" aria-live="polite"></pre>`;

  root.append(spinner, title, subtitle, meta, track, details);

  const summaryLabel = details.querySelector('summary span');
  details.addEventListener('toggle', () => {
    summaryLabel.textContent = details.open ? 'Mostrar menos' : 'Mostrar mais';
  });
  details.querySelector('button').addEventListener('click', event => {
    event.preventDefault();
    details.querySelector('pre').textContent = '';
    runtime.logCount = 0;
    runtime.droppedLogs = 0;
    details.querySelector('.sm-log-badge').textContent = '0';
  });

  return {
    root,
    spinner,
    percent,
    title,
    subtitle,
    meta,
    stage: meta.querySelector('.sm-progress-stage'),
    count: meta.querySelector('.sm-progress-count'),
    current: meta.querySelector('.sm-progress-current'),
    elapsed: meta.querySelector('.sm-progress-elapsed'),
    track,
    fill: track.querySelector('.sm-real-fill'),
    details,
    console: details.querySelector('.sm-progress-console'),
    badge: details.querySelector('.sm-log-badge')
  };
}

function ensureUi() {
  if (runtime.ui?.root?.isConnected) return runtime.ui;
  const overlay = document.querySelector('#busyOverlay');
  const root = overlay?.querySelector('.loader-core');
  if (!overlay || !root) return null;
  runtime.ui = { overlay, ...createLoadingUi(root) };
  return runtime.ui;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.floor(seconds % 60)} s`;
}

function setPercent(value) {
  const ui = ensureUi();
  if (!ui) return;
  const received = Math.max(0, Math.min(100, Number(value) || 0));
  runtime.percent = Math.max(runtime.percent, received);
  const rounded = Math.round(runtime.percent);
  ui.percent.textContent = `${rounded}%`;
  ui.spinner.style.setProperty('--sm-progress-angle', `${runtime.percent * 3.6}deg`);
  ui.fill.style.width = `${runtime.percent}%`;
  ui.track.setAttribute('aria-valuenow', String(rounded));
}

function startClock() {
  clearInterval(runtime.timer);
  runtime.timer = setInterval(() => {
    const ui = ensureUi();
    if (!ui || !runtime.active) return;
    ui.elapsed.textContent = formatElapsed(performance.now() - runtime.startedAt);
  }, 100);
}

function resetProgress(label = 'Preparando operação', action = '', preserveLogs = false) {
  const ui = ensureUi();
  if (!ui) return;
  runtime.active = true;
  runtime.state = 'running';
  runtime.action = action;
  runtime.startedAt = performance.now();
  runtime.percent = 0;
  ui.root.classList.remove('sm-progress-indeterminate', 'sm-progress-error', 'sm-progress-complete');
  ui.title.textContent = label;
  ui.subtitle.textContent = 'A porcentagem só avança quando o núcleo confirma trabalho concluído.';
  ui.stage.textContent = 'Preparando operação';
  ui.count.textContent = '';
  ui.current.textContent = '';
  ui.elapsed.textContent = '0,0 s';
  setPercent(0);
  if (!preserveLogs) {
    runtime.logCount = 0;
    runtime.droppedLogs = 0;
    ui.console.textContent = '';
    ui.badge.textContent = '0';
    ui.details.open = false;
    ui.details.querySelector('summary span').textContent = 'Mostrar mais';
  }
  startClock();
}

function appendLog(message, level = 'info', at = new Date().toISOString()) {
  const ui = ensureUi();
  if (!ui) return;
  const clean = cleanLine(message);
  if (!clean) return;
  const timestamp = new Date(at).toLocaleTimeString('pt-BR', { hour12: false });
  const line = `[${timestamp}] [${String(level).toUpperCase()}] ${clean}`;
  const wasNearBottom = ui.console.scrollHeight - ui.console.scrollTop - ui.console.clientHeight < 45;
  const lines = ui.console.textContent ? ui.console.textContent.split('\n') : [];
  lines.push(line);
  if (lines.length > 2500) {
    const removed = lines.length - 2200;
    lines.splice(0, removed);
    runtime.droppedLogs += removed;
  }
  ui.console.textContent = `${runtime.droppedLogs ? `[... ${runtime.droppedLogs} linhas antigas removidas para manter a fluidez ...]\n` : ''}${lines.join('\n')}`;
  runtime.logCount++;
  ui.badge.textContent = runtime.logCount > 999 ? '999+' : String(runtime.logCount);
  if (wasNearBottom || !ui.details.open) ui.console.scrollTop = ui.console.scrollHeight;
}

function applyProgress(detail = {}) {
  const ui = ensureUi();
  if (!ui) return;
  if (!runtime.active) resetProgress(detail.stage || 'Processando', detail.action || '');
  const determinate = detail.mode !== 'indeterminate' && Number.isFinite(Number(detail.percent));
  ui.root.classList.toggle('sm-progress-indeterminate', !determinate);
  if (determinate) setPercent(detail.percent);
  if (detail.stage) ui.stage.textContent = detail.stage;
  if (detail.current !== undefined) ui.current.textContent = detail.current || '';
  if (detail.total > 0) {
    ui.count.textContent = `${Number(detail.completed).toLocaleString('pt-BR')} / ${Number(detail.total).toLocaleString('pt-BR')}`;
  } else {
    ui.count.textContent = detail.mode === 'indeterminate' ? 'aguardando etapa indivisível' : '';
  }
  if (detail.message) appendLog(detail.message, 'info', detail.at);
}

function finishProgress(success, message = '') {
  const ui = ensureUi();
  if (!ui || runtime.state === 'idle') return;
  runtime.active = false;
  runtime.state = success ? 'success' : 'error';
  clearInterval(runtime.timer);
  ui.elapsed.textContent = formatElapsed(performance.now() - runtime.startedAt);
  ui.root.classList.remove('sm-progress-indeterminate');
  ui.root.classList.toggle('sm-progress-complete', success);
  ui.root.classList.toggle('sm-progress-error', !success);
  if (success) {
    setPercent(100);
    ui.stage.textContent = 'Concluído';
    appendLog(message || 'Operação concluída.', 'success');
  } else {
    ui.stage.textContent = 'Falha no processamento';
    ui.subtitle.textContent = 'A operação foi encerrada. Consulte o verbose para ver a causa.';
    appendLog(message || 'A operação falhou.', 'error');
    ui.details.open = true;
    ui.details.querySelector('summary span').textContent = 'Mostrar menos';
  }
}

function dismissProgress() {
  runtime.active = false;
  runtime.state = 'idle';
  clearInterval(runtime.timer);
}

function parseActionRequest(input, options = {}) {
  const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : input?.url;
  if (!raw) return null;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin || url.pathname !== '/api/action') return null;
  const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST' || typeof options.body !== 'string') return null;
  try { return JSON.parse(options.body); } catch { return null; }
}

async function projectStatus(force = false) {
  const age = Date.now() - runtime.statusAt;
  if (!force && runtime.status && age < 2000) return runtime.status;
  const response = await transportFetch('/api/status', { headers: { accept: 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  runtime.status = payload;
  runtime.statusAt = Date.now();
  window.dispatchEvent(new CustomEvent('suprememind-project-status', { detail: payload }));
  return payload;
}

function errorResponse(message, code = 'OPERATION_FAILED', status = 500) {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function streamAction(payload, options = {}, preserveSession = false) {
  if (!preserveSession) resetProgress(document.querySelector('#busyText')?.textContent || payload.action, payload.action);
  appendLog(`Solicitando operação detalhada: ${payload.action}`);
  let response;
  try {
    response = await transportFetch('/api/action-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options.signal
    });
  } catch (error) {
    finishProgress(false, error.message);
    return errorResponse(error.message, 'NETWORK_ERROR', 503);
  }
  if (!response.ok || !response.body) {
    const message = await response.text();
    finishProgress(false, message || `HTTP ${response.status}`);
    return errorResponse(message || `HTTP ${response.status}`, 'STREAM_UNAVAILABLE', response.status || 500);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let result = null;
  let failure = null;
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch {
        appendLog(`Evento inválido ignorado: ${line.slice(0, 180)}`, 'warning');
        continue;
      }
      if (event.type === 'start') {
        applyProgress(event);
        appendLog(`Início confirmado pelo núcleo: ${event.action}`);
      } else if (event.type === 'progress') {
        applyProgress(event);
      } else if (event.type === 'log') {
        appendLog(event.message, event.level, event.at);
      } else if (event.type === 'result') {
        result = event.result;
      } else if (event.type === 'error') {
        failure = event.error || 'Falha desconhecida';
      }
    }
    if (done) break;
  }

  if (failure) {
    finishProgress(false, failure);
    return errorResponse(failure, 'ACTION_FAILED', 500);
  }
  if (!result) {
    const message = 'O fluxo terminou sem retornar um resultado.';
    finishProgress(false, message);
    return errorResponse(message, 'EMPTY_STREAM', 500);
  }
  finishProgress(true, `${payload.action} concluído em ${Math.round(result.durationMs || 0)} ms`);
  runtime.statusAt = 0;
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function executeAction(payload, options) {
  resetProgress(document.querySelector('#busyText')?.textContent || payload.action, payload.action);
  try {
    const status = await projectStatus();
    if (INDEX_ACTIONS.has(payload.action) && !status.indexed) {
      const message = status.indexError
        ? `O índice do projeto está inválido: ${status.indexError}`
        : 'O projeto ainda não possui índice. Abra Projeto, clique em Inicializar e depois em Indexar.';
      finishProgress(false, message);
      return errorResponse(message, 'INDEX_REQUIRED', 409);
    }
  } catch (error) {
    finishProgress(false, error.message);
    return errorResponse(error.message, 'STATUS_UNAVAILABLE', 503);
  }

  if (payload.action === 'query' && window.SupremeMindGPU?.active && typeof window.SupremeMindGPU.runQuery === 'function') {
    appendLog('WebGPU disponível: iniciando busca semântica acelerada.');
    try {
      const response = await window.SupremeMindGPU.runQuery(payload);
      finishProgress(true, 'Consulta WebGPU concluída.');
      return response;
    } catch (error) {
      if (error?.code === 'INDEX_REQUIRED') {
        finishProgress(false, error.message);
        return errorResponse(error.message, error.code, error.status || 409);
      }
      appendLog(`WebGPU indisponível nesta consulta: ${error.message}`, 'warning');
      applyProgress({ mode: 'indeterminate', stage: 'Fallback seguro para CPU', current: 'Mantendo o verbose da operação' });
      return streamAction(payload, options, true);
    }
  }
  return streamAction(payload, options, true);
}

window.fetch = async function supremeMindFetch(input, options = {}) {
  const payload = parseActionRequest(input, options);
  return payload ? executeAction(payload, options) : transportFetch(input, options);
};

const observer = new MutationObserver(() => {
  const ui = ensureUi();
  if (!ui) return;
  if (!ui.overlay.classList.contains('hidden') && runtime.state === 'idle') {
    resetProgress(ui.title.textContent || 'Processando', 'network');
    appendLog('Aguardando início do processamento...');
  }
  if (ui.overlay.classList.contains('hidden')) dismissProgress();
});

function boot() {
  const ui = ensureUi();
  if (ui) observer.observe(ui.overlay, { attributes: true, attributeFilter: ['class'] });
  else setTimeout(boot, 50);
}
boot();

window.SupremeMindProgress = {
  start: resetProgress,
  update: applyProgress,
  log: appendLog,
  finish: finishProgress,
  dismiss: dismissProgress,
  status: projectStatus,
  get state() { return runtime.state; }
};
