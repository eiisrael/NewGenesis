const gpuFetch = window.fetch.bind(window);

const acceleration = {
  adapter: null,
  device: null,
  pipeline: null,
  index: null,
  matrixBuffer: null,
  renderer: 'GPU não identificada',
  mode: 'initializing',
  error: null
};

document.documentElement.classList.add('sm-gpu-ui');

function emitProgress(detail) {
  window.dispatchEvent(new CustomEvent('suprememind-progress', {
    detail: { at: new Date().toISOString(), ...detail }
  }));
}

function progressStage(percent, stage, current = '', message = '') {
  emitProgress({ type: 'progress', mode: 'determinate', completed: percent, total: 100, percent, stage, current });
  if (message) emitProgress({ type: 'log', level: 'info', message });
}

function progressWaiting(stage, current = '', message = '') {
  emitProgress({ type: 'progress', mode: 'indeterminate', stage, current });
  if (message) emitProgress({ type: 'log', level: 'info', message });
}

function decodeFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}

function detectRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const options = { alpha: false, antialias: false, desynchronized: true, powerPreference: 'high-performance' };
    const context = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options);
    if (!context) return 'Aceleração gráfica indisponível';
    const extension = context.getExtension('WEBGL_debug_renderer_info');
    return extension
      ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : context.getParameter(context.RENDERER) || 'GPU via WebGL';
  } catch {
    return 'GPU via navegador';
  }
}

function statusCard() {
  let card = document.querySelector('.sm-gpu-status');
  if (card) return card;
  const footer = document.querySelector('.sidebar-footer');
  if (!footer) return null;
  card = document.createElement('section');
  card.className = 'sm-gpu-status';
  card.innerHTML = '<strong>GPU · DETECTANDO</strong><span>Verificando WebGPU...</span><span class="sm-gpu-renderer"></span>';
  footer.insertBefore(card, footer.firstChild);
  return card;
}

function renderStatus() {
  const card = statusCard();
  if (!card) return;
  card.classList.toggle('is-active', acceleration.mode === 'webgpu');
  card.classList.toggle('is-fallback', acceleration.mode === 'visual' || acceleration.mode === 'error');
  const title = card.querySelector('strong');
  const details = card.querySelector('span:not(.sm-gpu-renderer)');
  const renderer = card.querySelector('.sm-gpu-renderer');
  if (acceleration.mode === 'webgpu') {
    title.textContent = 'GPU · COMPUTE DISPONÍVEL';
    details.textContent = 'Será usada quando o projeto possuir índice';
  } else if (acceleration.mode === 'visual') {
    title.textContent = 'GPU · ACELERAÇÃO VISUAL';
    details.textContent = 'Interface na GPU; busca em modo CPU';
  } else if (acceleration.mode === 'error') {
    title.textContent = 'GPU · FALLBACK CPU';
    details.textContent = acceleration.error || 'WebGPU não pôde ser iniciada';
  } else {
    title.textContent = 'GPU · DETECTANDO';
    details.textContent = 'Verificando WebGPU...';
  }
  renderer.textContent = acceleration.renderer;
  renderer.title = acceleration.renderer;
}

async function adapterName(adapter) {
  try {
    const info = adapter.info || await adapter.requestAdapterInfo?.();
    return [info?.vendor, info?.architecture, info?.device, info?.description].filter(Boolean).join(' · ');
  } catch {
    return '';
  }
}

function destroyGpuIndex() {
  acceleration.matrixBuffer?.destroy?.();
  acceleration.matrixBuffer = null;
  acceleration.index = null;
}

async function initializeWebGPU() {
  acceleration.renderer = detectRenderer();
  renderStatus();
  if (!navigator.gpu) {
    acceleration.mode = 'visual';
    renderStatus();
    return false;
  }
  try {
    acceleration.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!acceleration.adapter) throw new Error('Nenhum adaptador WebGPU compatível');
    acceleration.device = await acceleration.adapter.requestDevice();
    const name = await adapterName(acceleration.adapter);
    if (name) acceleration.renderer = name;
    acceleration.device.lost.then(info => {
      acceleration.device = null;
      acceleration.pipeline = null;
      destroyGpuIndex();
      acceleration.mode = 'visual';
      acceleration.error = `Dispositivo GPU perdido: ${info.message || info.reason}`;
      renderStatus();
    });
    acceleration.mode = 'webgpu';
    acceleration.error = null;
    renderStatus();
    return true;
  } catch (error) {
    acceleration.mode = 'visual';
    acceleration.error = error.message;
    renderStatus();
    return false;
  }
}

function createPipeline() {
  if (acceleration.pipeline) return acceleration.pipeline;
  if (!acceleration.device) throw new Error('Dispositivo WebGPU indisponível.');
  const shader = acceleration.device.createShaderModule({
    label: 'SupremeMind cosine similarity',
    code: `
      struct Params {
        count: u32,
        dimensions: u32,
        padding0: u32,
        padding1: u32,
      }
      @group(0) @binding(0) var<storage, read> matrix: array<f32>;
      @group(0) @binding(1) var<storage, read> query: array<f32>;
      @group(0) @binding(2) var<storage, read_write> output: array<f32>;
      @group(0) @binding(3) var<uniform> params: Params;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
        let row = invocation.x;
        if (row >= params.count) { return; }
        var dot = 0.0;
        let offset = row * params.dimensions;
        for (var column = 0u; column < params.dimensions; column = column + 1u) {
          dot = dot + matrix[offset + column] * query[column];
        }
        output[row] = dot;
      }
    `
  });
  acceleration.pipeline = acceleration.device.createComputePipeline({
    label: 'SupremeMind GPU semantic ranking',
    layout: 'auto',
    compute: { module: shader, entryPoint: 'main' }
  });
  return acceleration.pipeline;
}

async function fetchJson(url, options) {
  const response = await gpuFetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload.code || 'GPU_REQUEST_FAILED';
    throw error;
  }
  return payload;
}

async function ensureGpuIndex() {
  progressWaiting('Lendo matriz vetorial', 'Solicitando índice ao núcleo');
  const payload = await fetchJson('/api/gpu/index');
  if (!payload.count) {
    const error = new Error('O índice não contém arquivos para processar.');
    error.status = 409;
    error.code = 'INDEX_EMPTY';
    throw error;
  }
  if (acceleration.index?.key === payload.key && acceleration.matrixBuffer) {
    emitProgress({ type: 'log', level: 'info', message: `Matriz GPU reutilizada: ${payload.count} arquivos × ${payload.dimensions} dimensões` });
    return acceleration.index;
  }

  progressStage(8, 'Decodificando matriz vetorial', `${payload.count} arquivos × ${payload.dimensions} dimensões`);
  const matrix = decodeFloat32(payload.matrixBase64);
  destroyGpuIndex();
  acceleration.matrixBuffer = acceleration.device.createBuffer({
    label: `SupremeMind index vectors ${payload.count}x${payload.dimensions}`,
    size: Math.max(4, matrix.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  acceleration.device.queue.writeBuffer(acceleration.matrixBuffer, 0, matrix);
  acceleration.index = {
    key: payload.key,
    count: payload.count,
    dimensions: payload.dimensions,
    files: payload.files
  };
  emitProgress({ type: 'log', level: 'success', message: `${matrix.byteLength.toLocaleString('pt-BR')} bytes enviados para a GPU` });
  return acceleration.index;
}

async function semanticScores(queryVector, index) {
  const device = acceleration.device;
  const pipeline = createPipeline();
  const query = new Float32Array(queryVector);
  const outputSize = Math.max(4, index.count * Float32Array.BYTES_PER_ELEMENT);
  const queryBuffer = device.createBuffer({ size: Math.max(4, query.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outputBuffer = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuffer = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const paramsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  try {
    device.queue.writeBuffer(queryBuffer, 0, query);
    device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([index.count, index.dimensions, 0, 0]));
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: acceleration.matrixBuffer } },
        { binding: 1, resource: { buffer: queryBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } }
      ]
    });
    const encoder = device.createCommandEncoder({ label: 'SupremeMind GPU query encoder' });
    const pass = encoder.beginComputePass({ label: 'SupremeMind GPU cosine pass' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(index.count / 64));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, outputSize);
    device.queue.submit([encoder.finish()]);
    await readBuffer.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    return result;
  } finally {
    queryBuffer.destroy();
    outputBuffer.destroy();
    readBuffer.destroy();
    paramsBuffer.destroy();
  }
}

async function completeGpuEvent(eventId, durationMs, status = 'success', error = null) {
  if (!eventId) return;
  try {
    await gpuFetch('/api/gpu/query-complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, durationMs, status, error })
    });
  } catch {
    // Telemetria local opcional.
  }
}

function isProjectStateError(error) {
  return ['INDEX_REQUIRED', 'INDEX_EMPTY', 'INVALID_QUERY'].includes(error?.code);
}

async function runGpuQuery(payload, retry = 0) {
  const started = performance.now();
  let eventId = null;
  progressStage(0, 'Preparando consulta WebGPU', payload.query || '', 'Fluxo WebGPU iniciado.');
  try {
    const index = await ensureGpuIndex();
    progressStage(20, 'Matriz vetorial pronta', `${index.count} arquivos × ${index.dimensions} dimensões`);
    const plan = await fetchJson('/api/gpu/query-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: payload.query || '', limit: payload.limit || 20, indexKey: index.key })
    });
    eventId = plan.eventId;
    if (plan.stale || plan.indexKey !== index.key) {
      if (retry >= 1) throw new Error('O índice mudou repetidamente durante a consulta. Atualize a página e tente novamente.');
      emitProgress({ type: 'log', level: 'warning', message: 'O índice mudou. Recarregando a matriz GPU uma vez.' });
      destroyGpuIndex();
      return runGpuQuery(payload, retry + 1);
    }
    progressStage(35, 'Plano híbrido preparado', `${plan.count} candidatos`);
    progressWaiting('Executando shader WebGPU', `${Math.ceil(index.count / 64)} grupos de trabalho`, 'A GPU não expõe conclusão parcial dos grupos; a porcentagem fica no último ponto confirmado.');
    const semantic = await semanticScores(plan.queryVector, index);
    progressStage(58, 'Shader WebGPU concluído', `${semantic.length} resultados semânticos`);

    const baseScores = decodeFloat32(plan.baseScoresBase64);
    const ranked = new Array(index.count);
    for (let fileIndex = 0; fileIndex < index.count; fileIndex++) {
      const semanticScore = Math.max(0, semantic[fileIndex] || 0);
      const score = Math.min(1, 0.39 * semanticScore + (baseScores[fileIndex] || 0));
      const file = index.files[fileIndex];
      ranked[fileIndex] = {
        path: file.path,
        language: file.language,
        summary: file.summary,
        score: score * 100,
        factors: { semantic: semanticScore },
        basin: file.basin,
        symbols: file.symbols || []
      };
      const percent = 58 + 34 * (fileIndex + 1) / Math.max(index.count, 1);
      progressStage(percent, 'Combinando resultados', `${fileIndex + 1}/${index.count} · ${file.path}`);
      emitProgress({ type: 'log', level: 'info', message: `[${fileIndex + 1}/${index.count}] Ranking · ${file.path} · ${(score * 100).toFixed(2)}%` });
      if ((fileIndex & 255) === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }

    progressStage(94, 'Ordenando ranking final', `${ranked.length} arquivos`);
    ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const data = ranked.slice(0, Math.max(1, Number(payload.limit || 20)));
    progressStage(98, 'Serializando resposta', `${data.length} resultados`);
    const durationMs = performance.now() - started;
    await completeGpuEvent(eventId, durationMs);
    const stdout = data.map((row, position) => `${String(position + 1).padStart(2, '0')}. ${row.score.toFixed(1)}% ${row.path}\n    ${String(row.summary ?? '').slice(0, 180)}`).join('\n');
    progressStage(100, 'Consulta WebGPU concluída', `${durationMs.toFixed(1)} ms`);
    return new Response(JSON.stringify({ ok: true, action: 'query', stdout, stderr: '', data, durationMs, acceleration: 'webgpu' }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  } catch (error) {
    await completeGpuEvent(eventId, performance.now() - started, 'error', error.message);
    if (!isProjectStateError(error)) {
      acceleration.error = error.message;
      acceleration.mode = 'visual';
      renderStatus();
    }
    throw error;
  }
}

window.SupremeMindGPU = {
  get mode() { return acceleration.mode; },
  get renderer() { return acceleration.renderer; },
  get active() { return acceleration.mode === 'webgpu' && Boolean(acceleration.device); },
  runQuery: runGpuQuery,
  refresh: initializeWebGPU,
  invalidate: destroyGpuIndex
};

initializeWebGPU();
