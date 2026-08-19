const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  status: null,
  files: [],
  memories: [],
  events: [],
  contextMarkdown: '',
  selectedFileContent: ''
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatNumber(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('pt-BR', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('pt-BR');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toastStack').append(node);
  setTimeout(() => node.remove(), 4500);
}

function busy(show, text = 'Processando...') {
  $('#busyText').textContent = text;
  $('#busyOverlay').classList.toggle('hidden', !show);
}

function showView(name) {
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === name));
  if (name === 'files') loadFiles();
  if (name === 'memory') loadMemories();
  if (name === 'settings') loadConfig();
  if (name === 'galaxy') reloadGalaxy();
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  $('#activeProject').textContent = status.root;
  $('#projectRoot').value = status.root;
  $('#guiVersion').textContent = status.guiVersion ?? '0.2.0';
  $('#serverDot').classList.add('online');
  $('#serverState').textContent = status.indexed ? 'Índice online' : status.initialized ? 'Aguardando índice' : 'Projeto não iniciado';
  $('#statFiles').textContent = formatNumber(status.stats?.indexed);
  $('#statSymbols').textContent = formatNumber(status.stats?.symbols);
  $('#statEdges').textContent = formatNumber(status.stats?.edges);
  $('#statBasins').textContent = formatNumber(status.stats?.basins);
  $('#statMemory').textContent = formatNumber(status.memoryCount);
  $('#statGit').textContent = status.git?.available ? formatNumber(status.git.commitCount) : 'OFF';

  const list = $('#attractorList');
  if (!status.topAttractors?.length) {
    list.className = 'rank-list empty-state';
    list.textContent = 'Indexe o projeto para descobrir os atratores.';
  } else {
    list.className = 'rank-list';
    list.innerHTML = status.topAttractors.map((item, index) => `
      <div class="rank-item">
        <span class="rank-index">#${String(index + 1).padStart(2, '0')}</span>
        <span class="rank-name" title="${escapeHtml(item.attractor)}">${escapeHtml(item.attractor)}</span>
        <span class="rank-meta">${item.files} arquivos</span>
      </div>`).join('');
  }
}

function renderEvents() {
  const list = $('#eventList');
  if (!state.events.length) {
    list.className = 'event-list empty-state';
    list.textContent = 'Nenhuma operação nesta sessão.';
    return;
  }
  list.className = 'event-list';
  list.innerHTML = state.events.slice(0, 12).map(event => `
    <div class="event-item">
      <div><span class="event-status ${escapeHtml(event.status)}"></span><b>${escapeHtml(event.action)}</b></div>
      <small>${event.durationMs ? `${event.durationMs} ms` : formatDate(event.startedAt)}</small>
    </div>`).join('');
}

async function refreshStatus(silent = false) {
  try {
    state.status = await api('/api/status');
    state.events = await api('/api/events');
    renderStatus();
    renderEvents();
    await loadFilePaths();
  } catch (error) {
    $('#serverDot').classList.remove('online');
    $('#serverState').textContent = 'Servidor indisponível';
    if (!silent) toast(error.message, 'error');
  }
}

async function loadFilePaths() {
  if (!state.status?.indexed) return;
  try {
    state.files = await api('/api/files');
    $('#filePathList').innerHTML = state.files.slice(0, 5000).map(file => `<option value="${escapeHtml(file.path)}"></option>`).join('');
  } catch { /* status can exist while index is being replaced */ }
}

async function runAction(payload, label, options = {}) {
  busy(true, label);
  try {
    const result = await api('/api/action', { method: 'POST', body: JSON.stringify(payload) });
    if (options.target) $(options.target).textContent = result.stdout || result.stderr || 'Concluído.';
    toast(options.success ?? `${payload.action} concluído.`);
    await refreshStatus(true);
    return result;
  } catch (error) {
    if (options.target) $(options.target).textContent = `ERRO\n${error.message}`;
    toast(error.message, 'error');
    throw error;
  } finally {
    busy(false);
  }
}

function renderSearchResults(rows) {
  const output = $('#searchResults');
  if (!rows?.length) {
    output.className = 'result-grid empty-state';
    output.textContent = 'Nenhum resultado encontrado.';
    return;
  }
  output.className = 'result-grid';
  output.innerHTML = rows.map(row => `
    <article class="result-card">
      <div class="score-ring" style="--score:${Math.max(0, Math.min(100, row.score))}%"><span>${row.score.toFixed(1)}%</span></div>
      <div>
        <h3>${escapeHtml(row.path)}</h3>
        <p>${escapeHtml(row.summary)}</p>
      </div>
      <button class="ghost result-open" data-path="${escapeHtml(row.path)}">Abrir</button>
    </article>`).join('');
  $$('.result-open').forEach(button => button.addEventListener('click', async () => {
    showView('files');
    await openFile(button.dataset.path);
  }));
}

function renderImpact(data) {
  const output = $('#impactOutput');
  if (!data) return output.textContent = 'Saída inválida.';
  output.className = 'structured-output';
  output.innerHTML = `
    <div class="risk-badge risk-${escapeHtml(data.risk)}">${escapeHtml(data.risk)} · ${data.score}</div>
    <p><b>Alvo:</b> ${escapeHtml(data.target)}</p>
    <p>${data.direct} dependentes diretos · ${data.indirect} indiretos</p>
    <div class="relation-list">
      ${(data.impacted ?? []).slice(0, 100).map(item => `<div class="relation"><b>${escapeHtml(item.path)}</b><br><small>nível ${item.depth} · ${escapeHtml(item.type)} · peso ${(item.weight ?? 0).toFixed(3)}</small></div>`).join('') || '<span class="hint">Nenhum dependente detectado.</span>'}
    </div>`;
}

function renderOrbit(data) {
  const output = $('#orbitOutput');
  if (!data) return output.textContent = 'Saída inválida.';
  const relation = (title, rows, direction) => `
    <h3>${title}</h3><div class="relation-list">${(rows ?? []).slice(0, 80).map(edge => {
      const target = direction === 'out' ? edge.target : edge.source;
      return `<div class="relation"><b>${escapeHtml(target)}</b><br><small>${escapeHtml(edge.type)} · peso ${(edge.weight ?? 0).toFixed(3)} · confiança ${(edge.confidence ?? 0).toFixed(2)}</small></div>`;
    }).join('') || '<span class="hint">Nenhuma relação.</span>'}</div>`;
  output.className = 'structured-output';
  output.innerHTML = `<p><b>Atrator:</b> ${escapeHtml(data.attractor)}</p>${relation('Saídas', data.outgoing, 'out')}${relation('Entradas', data.incoming, 'in')}`;
}

async function loadFiles() {
  try {
    if (!state.status?.indexed) {
      $('#fileList').textContent = 'Indexe o projeto primeiro.';
      return;
    }
    if (!state.files.length) state.files = await api('/api/files');
    renderFileList();
  } catch (error) { toast(error.message, 'error'); }
}

function renderFileList() {
  const filter = $('#fileFilter').value.trim().toLowerCase();
  const rows = state.files.filter(file => !filter || `${file.path} ${file.language} ${file.basin}`.toLowerCase().includes(filter)).slice(0, 2500);
  const output = $('#fileList');
  output.className = 'file-list';
  output.innerHTML = rows.map(file => `
    <div class="file-item" data-path="${escapeHtml(file.path)}">
      <strong title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</strong>
      <small>${escapeHtml(file.language)} · ${file.lines} linhas · ${file.symbols} símbolos · ${(file.centrality * 100).toFixed(1)}%</small>
    </div>`).join('') || '<div class="empty-state">Nenhum arquivo corresponde ao filtro.</div>';
  $$('.file-item').forEach(item => item.addEventListener('click', () => openFile(item.dataset.path)));
}

async function openFile(filePath) {
  busy(true, `Abrindo ${filePath}`);
  try {
    const file = await api(`/api/file?path=${encodeURIComponent(filePath)}`);
    state.selectedFileContent = file.content;
    $('#fileViewerTitle').textContent = file.path;
    $('#fileViewer').textContent = file.content;
    $$('.file-item').forEach(item => item.classList.toggle('active', item.dataset.path === filePath));
  } catch (error) { toast(error.message, 'error'); }
  finally { busy(false); }
}

async function loadMemories() {
  try {
    state.memories = await api('/api/memories');
    renderMemories();
  } catch (error) { toast(error.message, 'error'); }
}

function renderMemories() {
  const filter = $('#memoryFilter').value.trim().toLowerCase();
  const rows = state.memories.filter(memory => !filter || `${memory.title} ${memory.content} ${(memory.tags ?? []).join(' ')}`.toLowerCase().includes(filter));
  const output = $('#memoryList');
  if (!rows.length) {
    output.className = 'memory-list empty-state';
    output.textContent = 'Nenhuma memória encontrada.';
    return;
  }
  output.className = 'memory-list';
  output.innerHTML = rows.map(memory => `
    <article class="memory-item">
      <h3>${escapeHtml(memory.title)}</h3>
      <p>${escapeHtml(memory.content)}</p>
      <div class="memory-tags">
        <span class="tag">${escapeHtml(memory.status)}</span>
        ${(memory.tags ?? []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        <span class="tag">${escapeHtml(formatDate(memory.createdAt))}</span>
      </div>
    </article>`).join('');
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    if (!config) return;
    $('#cfgProjectName').value = config.projectName ?? '';
    $('#cfgMaxFileSize').value = config.maxFileSize ?? 2500000;
    $('#cfgVectorDimensions').value = config.vectorDimensions ?? 128;
    $('#cfgTokenBudget').value = config.tokenBudget ?? 6000;
    $('#cfgMaxContextFiles').value = config.maxContextFiles ?? 15;
    $('#cfgGitCommitLimit').value = config.gitCommitLimit ?? 500;
    $('#cfgIgnore').value = (config.ignore ?? []).join('\n');
  } catch (error) { toast(error.message, 'error'); }
}

async function saveConfig() {
  const config = {
    version: state.status?.config?.version ?? 1,
    projectName: $('#cfgProjectName').value.trim(),
    maxFileSize: Number($('#cfgMaxFileSize').value),
    vectorDimensions: Number($('#cfgVectorDimensions').value),
    tokenBudget: Number($('#cfgTokenBudget').value),
    maxContextFiles: Number($('#cfgMaxContextFiles').value),
    gitCommitLimit: Number($('#cfgGitCommitLimit').value),
    ignore: $('#cfgIgnore').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  };
  busy(true, 'Salvando configurações');
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(config) });
    toast('Configurações salvas.');
    await refreshStatus(true);
  } catch (error) { toast(error.message, 'error'); }
  finally { busy(false); }
}

function reloadGalaxy() {
  $('#galaxyFrame').src = `/api/galaxy?t=${Date.now()}`;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function bind() {
  $('#nav').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) showView(button.dataset.view);
  });
  $$('[data-go]').forEach(button => button.addEventListener('click', () => showView(button.dataset.go)));
  $('#refreshBtn').addEventListener('click', () => refreshStatus());
  $('#switchProjectBtn').addEventListener('click', async () => {
    const root = $('#projectRoot').value.trim();
    if (!root) return toast('Informe a pasta do projeto.', 'error');
    busy(true, 'Trocando projeto');
    try {
      state.status = await api('/api/project', { method: 'POST', body: JSON.stringify({ root }) });
      state.files = [];
      state.memories = [];
      renderStatus();
      toast('Projeto carregado.');
    } catch (error) { toast(error.message, 'error'); }
    finally { busy(false); }
  });

  $$('[data-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.action;
    const force = action === 'force-index';
    const coreAction = force ? 'index' : action;
    const labels = { init: 'Inicializando projeto', index: force ? 'Reconstruindo todo o índice' : 'Indexando projeto', update: 'Atualizando índice incremental' };
    try {
      const result = await runAction({ action: coreAction, force }, labels[coreAction], { target: '#projectLog', success: 'Operação concluída.' });
      $('#projectLog').textContent = result.stdout || 'Concluído.';
    } catch { /* already surfaced */ }
  }));
  $('#clearProjectLog').addEventListener('click', () => $('#projectLog').textContent = 'Pronto.');

  $('#searchBtn').addEventListener('click', async () => {
    const query = $('#searchQuery').value.trim();
    if (!query) return toast('Digite uma consulta.', 'error');
    try {
      const result = await runAction({ action: 'query', query, limit: Number($('#searchLimit').value) }, 'Consultando o índice');
      renderSearchResults(result.data);
    } catch { /* surfaced */ }
  });
  $('#searchQuery').addEventListener('keydown', event => { if (event.key === 'Enter') $('#searchBtn').click(); });

  $('#contextBtn').addEventListener('click', async () => {
    const query = $('#contextQuery').value.trim();
    if (!query) return toast('Descreva a tarefa.', 'error');
    try {
      const result = await runAction({
        action: 'context', query,
        budget: Number($('#contextBudget').value),
        save: $('#contextSave').value.trim() || undefined
      }, 'Montando contexto otimizado', { success: 'Contexto gerado.' });
      state.contextMarkdown = result.stdout;
      $('#contextOutput').textContent = result.stdout;
    } catch { /* surfaced */ }
  });
  $('#copyContextBtn').addEventListener('click', async () => {
    if (!state.contextMarkdown) return toast('Gere um contexto primeiro.', 'error');
    await navigator.clipboard.writeText(state.contextMarkdown);
    toast('Contexto copiado.');
  });
  $('#downloadContextBtn').addEventListener('click', () => {
    if (!state.contextMarkdown) return toast('Gere um contexto primeiro.', 'error');
    downloadText($('#contextSave').value.trim() || 'suprememind-context.md', state.contextMarkdown);
  });

  $('#generateGalaxyBtn').addEventListener('click', async () => {
    try {
      await runAction({ action: 'graph' }, 'Gerando Galaxy', { success: 'Galaxy atualizada.' });
      reloadGalaxy();
    } catch { /* surfaced */ }
  });
  $('#reloadGalaxyBtn').addEventListener('click', reloadGalaxy);

  $('#impactBtn').addEventListener('click', async () => {
    const filePath = $('#analysisPath').value.trim();
    if (!filePath) return toast('Informe um arquivo.', 'error');
    try {
      const result = await runAction({ action: 'impact', path: filePath, depth: Number($('#analysisDepth').value) }, 'Calculando raio de explosão');
      renderImpact(result.data);
    } catch { /* surfaced */ }
  });
  $('#orbitBtn').addEventListener('click', async () => {
    const filePath = $('#analysisPath').value.trim();
    if (!filePath) return toast('Informe um arquivo.', 'error');
    try {
      const result = await runAction({ action: 'orbit', path: filePath, depth: Number($('#analysisDepth').value) }, 'Mapeando órbita estrutural');
      renderOrbit(result.data);
    } catch { /* surfaced */ }
  });

  $('#fileFilter').addEventListener('input', renderFileList);
  $('#copyFileBtn').addEventListener('click', async () => {
    if (!state.selectedFileContent) return toast('Selecione um arquivo.', 'error');
    await navigator.clipboard.writeText(state.selectedFileContent);
    toast('Arquivo copiado.');
  });

  $('#saveMemoryBtn').addEventListener('click', async () => {
    const title = $('#memoryTitle').value.trim();
    const content = $('#memoryContent').value.trim();
    if (!title || !content) return toast('Título e conteúdo são obrigatórios.', 'error');
    try {
      await runAction({
        action: 'remember', title, content,
        files: $('#memoryFiles').value.split(',').map(value => value.trim()).filter(Boolean),
        tags: $('#memoryTags').value.split(',').map(value => value.trim()).filter(Boolean),
        status: $('#memoryStatus').value
      }, 'Gravando memória', { success: 'Memória persistida.' });
      $('#memoryTitle').value = '';
      $('#memoryContent').value = '';
      await loadMemories();
    } catch { /* surfaced */ }
  });
  $('#refreshMemoryBtn').addEventListener('click', loadMemories);
  $('#memoryFilter').addEventListener('input', renderMemories);
  $('#saveConfigBtn').addEventListener('click', saveConfig);

  $('#doctorBtn').addEventListener('click', async () => {
    try { await runAction({ action: 'doctor' }, 'Executando diagnóstico', { target: '#doctorOutput', success: 'Diagnóstico concluído.' }); } catch { /* surfaced */ }
  });
  $('#benchmarkBtn').addEventListener('click', async () => {
    try { await runAction({ action: 'benchmark' }, 'Executando benchmark', { target: '#benchmarkOutput', success: 'Benchmark concluído.' }); } catch { /* surfaced */ }
  });
}

async function bootstrap() {
  bind();
  await refreshStatus();
  setInterval(() => refreshStatus(true), 12000);
}

bootstrap();
