import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_DIR = '.suprememind';
const MAX_BODY = 2 * 1024 * 1024;
const STOP = new Set('a ao aos as com como da das de do dos e em entre essa esse esta este na nas no nos o os ou para por que se sem ser sua um uma the and or of to in for on is are with from this that return const let var public private protected static void'.split(' '));
const cache = new Map();
const now = () => new Date().toISOString();

function httpError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function tokenize(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z_][a-z0-9_]{1,}|[0-9]{2,}/g)
    ?.filter(token => !STOP.has(token)) ?? [];
}

function fnv(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function vector(text, dimensions) {
  const output = new Float32Array(dimensions);
  const features = [];
  for (const term of tokenize(text)) {
    features.push(term);
    if (term.length >= 4) {
      for (let index = 0; index <= term.length - 3; index++) features.push(`#${term.slice(index, index + 3)}`);
    }
  }
  for (const feature of features) {
    const hash = fnv(feature);
    output[hash % dimensions] += (hash & 0x80000000) ? -1 : 1;
  }
  let norm = 0;
  for (const value of output) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm) for (let index = 0; index < output.length; index++) output[index] /= norm;
  return output;
}

function bm25(files, queryTokens) {
  const averageLength = files.reduce((sum, file) => sum + (file.termCount ?? 0), 0) / Math.max(files.length, 1) || 1;
  const documentFrequency = {};
  for (const token of new Set(queryTokens)) {
    documentFrequency[token] = files.reduce((sum, file) => sum + (file.terms?.[token] ? 1 : 0), 0);
  }
  const output = new Float32Array(files.length);
  let maximum = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    let score = 0;
    for (const token of queryTokens) {
      const termFrequency = file.terms?.[token] ?? 0;
      if (!termFrequency) continue;
      const frequency = documentFrequency[token] ?? 0;
      const inverseFrequency = Math.log(1 + (files.length - frequency + 0.5) / (frequency + 0.5));
      score += inverseFrequency * (termFrequency * 2.5) /
        (termFrequency + 1.5 * (1 - 0.75 + 0.75 * (file.termCount ?? 0) / averageLength));
    }
    output[fileIndex] = score;
    if (score > maximum) maximum = score;
  }
  if (maximum) for (let index = 0; index < output.length; index++) output[index] /= maximum;
  return output;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError('Corpo da requisição excede 2 MB.', 'BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

async function readMemories(root) {
  try {
    const text = await fs.readFile(path.join(root, STATE_DIR, 'memories.jsonl'), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function loadGpuIndex(root) {
  const resolvedRoot = path.resolve(root);
  const file = path.join(resolvedRoot, STATE_DIR, 'index.json');
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw httpError('O projeto ainda não possui índice. Inicialize e indexe antes de ativar a GPU.', 'INDEX_REQUIRED', 409);
    }
    throw error;
  }

  const existing = cache.get(resolvedRoot);
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return existing;

  let index;
  try {
    index = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw httpError(`O índice não pôde ser lido: ${error.message}`, 'INDEX_CORRUPT', 409);
  }
  const dimensions = Number(index.config?.vectorDimensions ?? 128);
  const count = index.files?.length ?? 0;
  if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 4096) {
    throw httpError(`Dimensão vetorial inválida: ${dimensions}`, 'INDEX_INVALID', 409);
  }
  if (!count) throw httpError('O índice existe, mas não contém arquivos.', 'INDEX_EMPTY', 409);

  const matrix = new Float32Array(count * dimensions);
  const files = new Array(count);
  for (let row = 0; row < count; row++) {
    const fileEntry = index.files[row];
    const sourceVector = fileEntry.vector ?? [];
    const offset = row * dimensions;
    for (let column = 0; column < dimensions; column++) matrix[offset + column] = Number(sourceVector[column] ?? 0);
    files[row] = {
      path: fileEntry.path,
      language: fileEntry.language,
      summary: fileEntry.summary,
      basin: index.graph?.basins?.nodeToAttractor?.[fileEntry.path] ?? fileEntry.path,
      symbols: (fileEntry.symbols ?? []).slice(0, 12)
    };
  }

  const key = `${resolvedRoot}|${index.generatedAt ?? stat.mtimeMs}|${stat.size}|${count}|${dimensions}`;
  const entry = {
    root: resolvedRoot,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    key,
    index,
    count,
    dimensions,
    files,
    matrixBase64: Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength).toString('base64')
  };
  cache.set(resolvedRoot, entry);
  return entry;
}

function createEvent(events, action, details = {}) {
  const startedAt = Date.now();
  const event = {
    id: `${startedAt}-${Math.random().toString(16).slice(2)}`,
    action,
    status: 'running',
    startedAt: now(),
    acceleration: 'webgpu',
    ...details
  };
  events.unshift(event);
  events.splice(200);
  return event;
}

async function createQueryPlan(root, input, events) {
  const query = String(input.query ?? '').trim();
  if (!query) throw httpError('Digite uma consulta para usar a busca acelerada.', 'INVALID_QUERY', 400);
  const entry = await loadGpuIndex(root);
  if (input.indexKey && input.indexKey !== entry.key) return { stale: true, indexKey: entry.key };

  const tokens = tokenize(query);
  const lexical = bm25(entry.index.files, tokens);
  const queryVector = vector(query, entry.dimensions);
  const memories = await readMemories(root);
  const affinity = new Map();
  for (const memory of memories) {
    const haystack = `${memory.title ?? ''} ${memory.content ?? ''}`.toLowerCase();
    const overlap = tokens.filter(token => haystack.includes(token)).length / Math.max(tokens.length, 1);
    if (!overlap) continue;
    for (const file of memory.files ?? []) affinity.set(file, Math.max(affinity.get(file) ?? 0, overlap));
  }

  const normalizedQuery = query.toLowerCase();
  const baseScores = new Float32Array(entry.count);
  for (let fileIndex = 0; fileIndex < entry.count; fileIndex++) {
    const file = entry.index.files[fileIndex];
    const exact = file.path.toLowerCase().includes(normalizedQuery) ? 1 : 0;
    const centrality = entry.index.graph?.pageRank?.[file.path] ?? 0;
    const memory = affinity.get(file.path) ?? 0;
    baseScores[fileIndex] = 0.30 * lexical[fileIndex] + 0.12 * exact + 0.10 * centrality + 0.09 * memory;
  }

  const event = createEvent(events, 'query', { query, engine: 'WebGPU hybrid search' });
  return {
    stale: false,
    eventId: event.id,
    indexKey: entry.key,
    count: entry.count,
    dimensions: entry.dimensions,
    queryVector: Array.from(queryVector),
    baseScoresBase64: Buffer.from(baseScores.buffer, baseScores.byteOffset, baseScores.byteLength).toString('base64')
  };
}

function completeEvent(events, input) {
  const event = events.find(item => item.id === input.eventId);
  if (!event) return false;
  event.status = input.status === 'error' ? 'error' : 'success';
  event.finishedAt = now();
  event.durationMs = Number(input.durationMs ?? 0);
  event.stderr = input.error ? String(input.error).slice(0, 12000) : '';
  event.stdout = event.status === 'success' ? 'Consulta semântica executada com aceleração WebGPU.' : '';
  return true;
}

export function invalidateGpuCache(root) {
  if (root) cache.delete(path.resolve(root));
  else cache.clear();
}

export function injectGpuAssets(html) {
  let output = html;
  if (!output.includes('/gpu-acceleration.css')) output = output.replace('</head>', '  <link rel="stylesheet" href="/gpu-acceleration.css">\n</head>');
  if (!output.includes('/gpu-acceleration.js')) {
    output = output.replace(
      '<script type="module" src="/app.js"></script>',
      '<script type="module" src="/gpu-acceleration.js"></script>\n  <script type="module" src="/app.js"></script>'
    );
  }
  return output;
}

export async function handleGpuRequest(req, res, url, root, events) {
  if (url.pathname === '/api/gpu/index' && req.method === 'GET') {
    const entry = await loadGpuIndex(root);
    sendJson(res, 200, {
      key: entry.key,
      count: entry.count,
      dimensions: entry.dimensions,
      files: entry.files,
      matrixBase64: entry.matrixBase64
    });
    return true;
  }
  if (url.pathname === '/api/gpu/query-plan' && req.method === 'POST') {
    sendJson(res, 200, await createQueryPlan(root, await readBody(req), events));
    return true;
  }
  if (url.pathname === '/api/gpu/query-complete' && req.method === 'POST') {
    const body = await readBody(req);
    sendJson(res, 200, { ok: completeEvent(events, body) });
    return true;
  }
  return false;
}
