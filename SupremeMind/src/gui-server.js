import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { handleGpuRequest, injectGpuAssets, invalidateGpuCache } from './gpu-server.js';
import { handleProgressRequest, injectProgressAssets } from './progress-server.js';

const execFileAsync = promisify(execFile);
const GUI_DIR = fileURLToPath(new URL('../gui/', import.meta.url));
const CLI_FILE = fileURLToPath(new URL('../bin/suprememind.js', import.meta.url));
const STATE_DIR = '.suprememind';
const CONFIG_FILE = 'suprememind.config.json';
const GUI_VERSION = '0.2.3';
const MAX_BODY = 2 * 1024 * 1024;
const MAX_OUTPUT = 128 * 1024 * 1024;
const ALLOWED_ACTIONS = new Set([
  'init', 'index', 'update', 'query', 'context', 'orbit', 'impact',
  'remember', 'recall', 'graph', 'doctor', 'benchmark'
]);
const ACTION_TIMEOUTS = Object.freeze({
  init: 60_000,
  query: 120_000,
  orbit: 120_000,
  impact: 120_000,
  remember: 120_000,
  recall: 120_000,
  doctor: 120_000,
  context: 5 * 60_000,
  graph: 10 * 60_000,
  benchmark: 10 * 60_000,
  index: 15 * 60_000,
  update: 15 * 60_000
});

const now = () => new Date().toISOString();
const exists = async file => fs.access(file).then(() => true).catch(() => false);
const isLoopback = host => ['127.0.0.1', 'localhost', '::1'].includes(host);

function httpError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function safeProjectPath(root, relative) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(relative ?? ''));
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (target !== base && !target.startsWith(prefix)) throw httpError('Caminho fora do projeto.', 'PATH_OUTSIDE_PROJECT', 403);
  return target;
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
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw httpError('JSON inválido na requisição.', 'INVALID_JSON', 400);
  }
}

function sendJson(res, status, value) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer'
  });
  res.end(body);
}

async function readJsonSafe(file) {
  try {
    return { value: JSON.parse(await fs.readFile(file, 'utf8')), error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: null, error: null };
    return { value: null, error: error.message };
  }
}

function parseQueryOutput(stdout) {
  const rows = [];
  const lines = stdout.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*(\d+)\.\s+([\d.]+)%\s+(.+)$/);
    if (!match) continue;
    rows.push({
      rank: Number(match[1]),
      score: Number(match[2]),
      path: match[3].trim(),
      summary: lines[index + 1]?.trim() ?? ''
    });
  }
  return rows;
}

function parseJsonOutput(stdout) {
  const start = Math.min(...['{', '['].map(character => {
    const index = stdout.indexOf(character);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  }));
  if (!Number.isFinite(start)) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

function parseArgs(input = {}) {
  const action = String(input.action ?? '').trim();
  if (!ALLOWED_ACTIONS.has(action)) throw httpError(`Ação não permitida: ${action}`, 'ACTION_NOT_ALLOWED', 400);
  const args = [action];
  const add = value => { if (value !== undefined && value !== null && value !== '') args.push(String(value)); };
  const flag = (name, value) => {
    if (value === undefined || value === null || value === false || value === '') return;
    args.push(`--${name}`);
    if (value !== true) args.push(String(value));
  };
  if (action === 'init') add(input.root);
  if (action === 'index' || action === 'update') {
    add(input.root);
    flag('force', input.force);
  }
  if (action === 'query') {
    add(input.query);
    flag('limit', input.limit ?? 20);
  }
  if (action === 'context') {
    add(input.query);
    flag('budget', input.budget ?? 6000);
    if (input.save) flag('save', input.save);
  }
  if (action === 'orbit' || action === 'impact') {
    add(input.path);
    flag('depth', input.depth ?? (action === 'orbit' ? 2 : 3));
  }
  if (action === 'remember') {
    flag('title', input.title);
    flag('content', input.content);
    flag('files', Array.isArray(input.files) ? input.files.join(',') : input.files);
    flag('tags', Array.isArray(input.tags) ? input.tags.join(',') : input.tags);
    flag('status', input.status ?? 'recorded');
  }
  if (action === 'recall') {
    add(input.query);
    flag('limit', input.limit ?? 25);
  }
  if (action === 'graph') flag('output', input.output ?? `${STATE_DIR}/suprememind-galaxy.html`);
  return args;
}

function actionTimeout(action) {
  return ACTION_TIMEOUTS[action] ?? 5 * 60_000;
}

async function runCore(root, input, events) {
  const args = parseArgs({ ...input, root });
  const startedAt = Date.now();
  const timeoutMs = actionTimeout(input.action);
  const event = {
    id: `${startedAt}-${Math.random().toString(16).slice(2)}`,
    action: input.action,
    status: 'running',
    startedAt: now(),
    timeoutMs,
    acceleration: input.action === 'query' ? 'cpu-fallback' : 'cpu'
  };
  events.unshift(event);
  events.splice(200);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_FILE, ...args], {
      cwd: root,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      env: { ...process.env, NO_COLOR: '1' }
    });
    event.status = 'success';
    event.finishedAt = now();
    event.durationMs = Date.now() - startedAt;
    event.stdout = stdout.slice(-12000);
    event.stderr = stderr.slice(-12000);
    let data = null;
    if (input.action === 'query') data = parseQueryOutput(stdout);
    if (['orbit', 'impact', 'recall'].includes(input.action)) data = parseJsonOutput(stdout);
    return { ok: true, action: input.action, stdout, stderr, data, durationMs: event.durationMs, acceleration: event.acceleration };
  } catch (error) {
    event.status = 'error';
    event.finishedAt = now();
    event.durationMs = Date.now() - startedAt;
    const timedOut = error?.killed === true || error?.signal === 'SIGTERM' || /timed?\s*out/i.test(error?.message ?? '');
    event.stderr = timedOut
      ? `A operação "${input.action}" excedeu ${Math.round(timeoutMs / 1000)} segundos e foi encerrada.`
      : `${error.stderr ?? ''}\n${error.message ?? error}`.trim().slice(-12000);
    throw httpError(event.stderr || 'Falha ao executar o comando.', timedOut ? 'ACTION_TIMEOUT' : 'ACTION_FAILED', timedOut ? 504 : 500);
  }
}

async function readMemories(root) {
  const file = path.join(root, STATE_DIR, 'memories.jsonl');
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).reverse();
  } catch {
    return [];
  }
}

async function readStatus(root) {
  const configResult = await readJsonSafe(path.join(root, CONFIG_FILE));
  const indexResult = await readJsonSafe(path.join(root, STATE_DIR, 'index.json'));
  const config = configResult.value;
  const index = indexResult.value;
  const memories = await readMemories(root);
  const topAttractors = index
    ? Object.entries(index.graph?.basins?.groups ?? {})
        .map(([attractor, nodes]) => ({ attractor, files: nodes.length, centrality: index.graph?.pageRank?.[attractor] ?? 0 }))
        .sort((left, right) => right.files - left.files || right.centrality - left.centrality)
        .slice(0, 12)
    : [];
  return {
    product: 'SupremeMind',
    guiVersion: GUI_VERSION,
    root,
    initialized: Boolean(config),
    indexed: Boolean(index),
    config,
    configError: configResult.error,
    indexError: indexResult.error,
    generatedAt: index?.generatedAt ?? null,
    stats: index?.stats ?? null,
    git: index?.git ? {
      available: index.git.available,
      commitCount: index.git.commitCount ?? 0,
      reason: index.git.reason ?? null
    } : null,
    memoryCount: memories.length,
    topAttractors,
    acceleration: { browserGpu: true, semanticWebGpu: true, cpuFallback: true }
  };
}

async function requireIndex(root) {
  const result = await readJsonSafe(path.join(root, STATE_DIR, 'index.json'));
  if (result.error) throw httpError(`O índice não pôde ser lido: ${result.error}`, 'INDEX_CORRUPT', 409);
  if (!result.value) throw httpError('O projeto ainda não possui índice. Inicialize e indexe primeiro.', 'INDEX_REQUIRED', 409);
  return result.value;
}

async function readIndexedFiles(root) {
  const index = await requireIndex(root);
  return (index.files ?? []).map(file => ({
    path: file.path,
    language: file.language,
    lines: file.lines,
    symbols: file.symbols?.length ?? 0,
    tokenEstimate: file.tokenEstimate,
    summary: file.summary,
    centrality: index.graph?.pageRank?.[file.path] ?? 0,
    basin: index.graph?.basins?.nodeToAttractor?.[file.path] ?? file.path
  })).sort((left, right) => right.centrality - left.centrality || left.path.localeCompare(right.path));
}

async function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  await execFileAsync(command, args, { windowsHide: true }).catch(() => {});
}

function injectGuardrails(html) {
  if (html.includes('/runtime-guardrails.js')) return html;
  return html.replace(
    '<script type="module" src="/app.js"></script>',
    '<script type="module" src="/runtime-guardrails.js"></script>\n  <script type="module" src="/app.js"></script>'
  );
}

function injectPageAssets(html) {
  return injectGuardrails(injectProgressAssets(injectGpuAssets(html)));
}

export async function startGuiServer(options = {}) {
  let activeRoot = path.resolve(options.root ?? process.cwd());
  const host = options.host ?? '127.0.0.1';
  const port = Number(options.port ?? 7331);
  const events = [];
  if (!isLoopback(host)) console.warn('[SupremeMind GUI] AVISO: interface exposta fora do loopback. Use autenticação e firewall.');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
      if (url.pathname.startsWith('/api/')) {
        if (await handleProgressRequest(req, res, url, activeRoot, events)) return;
        if (await handleGpuRequest(req, res, url, activeRoot, events)) return;
        if (url.pathname === '/api/status' && req.method === 'GET') return sendJson(res, 200, await readStatus(activeRoot));
        if (url.pathname === '/api/events' && req.method === 'GET') return sendJson(res, 200, events);
        if (url.pathname === '/api/files' && req.method === 'GET') return sendJson(res, 200, await readIndexedFiles(activeRoot));
        if (url.pathname === '/api/memories' && req.method === 'GET') return sendJson(res, 200, await readMemories(activeRoot));
        if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, (await readJsonSafe(path.join(activeRoot, CONFIG_FILE))).value);
        if (url.pathname === '/api/config' && req.method === 'PUT') {
          const body = await readBody(req);
          await fs.writeFile(path.join(activeRoot, CONFIG_FILE), `${JSON.stringify(body, null, 2)}\n`);
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/project' && req.method === 'POST') {
          const body = await readBody(req);
          const candidate = path.resolve(String(body.root ?? ''));
          const stat = await fs.stat(candidate).catch(() => null);
          if (!stat?.isDirectory()) throw httpError('O caminho selecionado não é uma pasta.', 'INVALID_PROJECT_PATH', 400);
          activeRoot = candidate;
          invalidateGpuCache();
          return sendJson(res, 200, await readStatus(activeRoot));
        }
        if (url.pathname === '/api/action' && req.method === 'POST') {
          const body = await readBody(req);
          const result = await runCore(activeRoot, body, events);
          if (body.action === 'index' || body.action === 'update') invalidateGpuCache(activeRoot);
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/file' && req.method === 'GET') {
          const relative = url.searchParams.get('path') ?? '';
          const file = safeProjectPath(activeRoot, relative);
          const stat = await fs.stat(file).catch(() => null);
          if (!stat?.isFile()) throw httpError('Arquivo inválido.', 'INVALID_FILE', 404);
          if (stat.size > 2_000_000) throw httpError('Arquivo maior que 2 MB.', 'FILE_TOO_LARGE', 413);
          return sendJson(res, 200, { path: relative, content: await fs.readFile(file, 'utf8'), size: stat.size });
        }
        if (url.pathname === '/api/galaxy' && req.method === 'GET') {
          const file = path.join(activeRoot, STATE_DIR, 'suprememind-galaxy.html');
          if (!await exists(file)) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            return res.end('Galaxy ainda não gerada.');
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(await fs.readFile(file));
        }
        throw httpError('Endpoint não encontrado.', 'ENDPOINT_NOT_FOUND', 404);
      }

      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = path.resolve(GUI_DIR, relative);
      const prefix = GUI_DIR.endsWith(path.sep) ? GUI_DIR : `${GUI_DIR}${path.sep}`;
      if (file !== path.join(GUI_DIR, 'index.html') && !file.startsWith(prefix)) throw httpError('Caminho inválido.', 'INVALID_ASSET_PATH', 403);
      if (!await exists(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'content-type': contentType(file),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'"
      });
      const body = await fs.readFile(file);
      if (relative === 'index.html') return res.end(injectPageAssets(body.toString('utf8')));
      res.end(body);
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      sendJson(res, Number(error.statusCode ?? 500), {
        error: error.message ?? String(error),
        code: error.code ?? 'INTERNAL_ERROR'
      });
    }
  });

  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const url = `http://${host}:${port}`;
  if (options.open !== false) await openBrowser(url);
  return { server, url, getRoot: () => activeRoot };
}
