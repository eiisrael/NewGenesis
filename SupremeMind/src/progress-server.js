import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_FILE = fileURLToPath(new URL('../bin/suprememind.js', import.meta.url));
const STATE_DIR = '.suprememind';
const CONFIG_FILE = 'suprememind.config.json';
const MAX_BODY = 2 * 1024 * 1024;
const STOP = new Set('a ao aos as com como da das de do dos e em entre essa esse esta este na nas no nos o os ou para por que se sem ser sua um uma the and or of to in for on is are with from this that return const let var public private protected static void'.split(' '));
const TIMEOUTS = Object.freeze({
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
const norm = value => value.split(path.sep).join('/').replace(/^\.\//, '');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const id = (kind, value) => `${kind}:${sha(value).slice(0, 24)}`;
const immediate = () => new Promise(resolve => setImmediate(resolve));

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
  let length = 0;
  for (const value of output) length += value * value;
  length = Math.sqrt(length);
  if (length) for (let index = 0; index < output.length; index++) output[index] /= length;
  return output;
}

function cosine(queryVector, fileVector) {
  if (!fileVector || queryVector.length !== fileVector.length) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < queryVector.length; index++) {
    const a = queryVector[index];
    const b = Number(fileVector[index] ?? 0);
    dot += a * b;
    left += a * a;
    right += b * b;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Corpo da requisição excede 2 MB.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function createEmitter(res) {
  let closed = false;
  res.on('close', () => { closed = true; });
  return payload => {
    if (closed || res.writableEnded) return false;
    res.write(`${JSON.stringify({ at: now(), ...payload })}\n`);
    return true;
  };
}

function createProgress(emit) {
  const log = (message, level = 'info', context = {}) => emit({ type: 'log', level, message: String(message), ...context });
  const update = ({ completed = 0, total = 0, stage = '', current = '', mode = 'determinate', message = '' }) => {
    const percent = mode === 'determinate' && total > 0
      ? Math.max(0, Math.min(100, completed / total * 100))
      : null;
    emit({ type: 'progress', mode, completed, total, percent, stage, current, message });
  };
  return { emit, log, update };
}

async function readJsonStream(file, progress, options = {}) {
  const stat = await fs.stat(file);
  const chunks = [];
  let loaded = 0;
  const start = Number(options.start ?? 0);
  const end = Number(options.end ?? 100);
  const stage = options.stage ?? 'Lendo arquivo';
  progress.log(`${stage}: ${file}`);
  for await (const chunk of createReadStream(file)) {
    chunks.push(chunk);
    loaded += chunk.length;
    const local = stat.size ? loaded / stat.size : 1;
    const mapped = start + (end - start) * local;
    progress.update({ completed: mapped, total: 100, stage, current: `${loaded.toLocaleString('pt-BR')}/${stat.size.toLocaleString('pt-BR')} bytes` });
  }
  progress.log(`${stage} concluída: ${loaded.toLocaleString('pt-BR')} bytes`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function loadIndex(root, progress, start = 0, end = 12) {
  const file = path.join(root, STATE_DIR, 'index.json');
  try {
    return await readJsonStream(file, progress, { start, end, stage: 'Lendo índice' });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('O projeto ainda não possui índice. Inicialize e indexe primeiro.');
    throw error;
  }
}

async function readMemories(root) {
  try {
    const text = await fs.readFile(path.join(root, STATE_DIR, 'memories.jsonl'), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function mappedProgress(progress, start, end, stagePrefix = '') {
  return {
    log: progress.log,
    update(value) {
      const local = value.mode === 'determinate' && value.total > 0 ? value.completed / value.total : null;
      if (local === null) return progress.update({ ...value, stage: `${stagePrefix}${value.stage}`.trim(), mode: 'indeterminate' });
      progress.update({
        ...value,
        completed: start + (end - start) * local,
        total: 100,
        stage: `${stagePrefix}${value.stage}`.trim()
      });
    }
  };
}

async function searchCpu(root, index, query, limit, progress) {
  const files = index.files ?? [];
  const queryTokens = tokenize(query);
  const uniqueTokens = [...new Set(queryTokens)];
  const memories = await readMemories(root);
  const totalUnits = Math.max(1, uniqueTokens.length * files.length + files.length * 2 + memories.length + 1);
  let completed = 0;
  const tick = (stage, current, logMessage) => {
    completed++;
    progress.update({ completed, total: totalUnits, stage, current });
    if (logMessage) progress.log(logMessage);
  };

  progress.log(`Consulta recebida: ${query}`);
  progress.log(`Índice: ${files.length.toLocaleString('pt-BR')} arquivos · ${uniqueTokens.length} termos únicos`);
  const documentFrequency = {};
  for (const token of uniqueTokens) {
    let frequency = 0;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      if (files[fileIndex].terms?.[token]) frequency++;
      tick('Calculando frequência lexical', `${token} · ${fileIndex + 1}/${files.length}`);
      if ((fileIndex & 127) === 0) await immediate();
    }
    documentFrequency[token] = frequency;
    progress.log(`Termo "${token}": presente em ${frequency} arquivos`);
  }

  const averageLength = files.reduce((sum, file) => sum + (file.termCount ?? 0), 0) / Math.max(files.length, 1) || 1;
  const lexicalRaw = new Float32Array(files.length);
  let lexicalMaximum = 0;
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
    lexicalRaw[fileIndex] = score;
    if (score > lexicalMaximum) lexicalMaximum = score;
    tick('Pontuando BM25', `${fileIndex + 1}/${files.length}`, `BM25 · ${file.path}`);
    if ((fileIndex & 63) === 0) await immediate();
  }

  const affinity = new Map();
  for (let memoryIndex = 0; memoryIndex < memories.length; memoryIndex++) {
    const memory = memories[memoryIndex];
    const haystack = `${memory.title ?? ''} ${memory.content ?? ''}`.toLowerCase();
    const overlap = queryTokens.filter(token => haystack.includes(token)).length / Math.max(queryTokens.length, 1);
    if (overlap) for (const file of memory.files ?? []) affinity.set(file, Math.max(affinity.get(file) ?? 0, overlap));
    tick('Aplicando memórias', `${memoryIndex + 1}/${memories.length}`, `Memória · ${memory.title ?? memory.id ?? memoryIndex + 1}`);
  }

  const queryVector = vector(query, Number(index.config?.vectorDimensions ?? 128));
  const normalizedQuery = query.toLowerCase().trim();
  const ranked = new Array(files.length);
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const semantic = Math.max(0, cosine(queryVector, file.vector));
    const lexical = lexicalMaximum ? lexicalRaw[fileIndex] / lexicalMaximum : 0;
    const exact = file.path.toLowerCase().includes(normalizedQuery) ? 1 : 0;
    const centrality = index.graph?.pageRank?.[file.path] ?? 0;
    const memory = affinity.get(file.path) ?? 0;
    const score = Math.min(1, 0.39 * semantic + 0.30 * lexical + 0.12 * exact + 0.10 * centrality + 0.09 * memory);
    ranked[fileIndex] = {
      path: file.path,
      language: file.language,
      summary: file.summary,
      score,
      factors: { semantic, lexical, centrality, memory },
      basin: index.graph?.basins?.nodeToAttractor?.[file.path] ?? file.path,
      symbols: (file.symbols ?? []).slice(0, 12)
    };
    tick('Comparando arquivos', `${fileIndex + 1}/${files.length}`, `Comparação · ${file.path}`);
    if ((fileIndex & 63) === 0) await immediate();
  }

  tick('Ordenando resultados', `${files.length} candidatos`, 'Ordenando candidatos por relevância');
  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const result = ranked.slice(0, Math.max(1, Number(limit ?? 20)));
  progress.log(`Busca concluída: ${result.length} resultados retornados`);
  return result;
}

function adjacency(index) {
  const outgoing = new Map((index.files ?? []).map(file => [file.path, []]));
  const incoming = new Map((index.files ?? []).map(file => [file.path, []]));
  for (const edge of index.graph?.edges ?? []) {
    outgoing.get(edge.source)?.push(edge);
    incoming.get(edge.target)?.push(edge);
  }
  return { outgoing, incoming };
}

async function buildContext(root, index, query, budget, progress) {
  const searchProgress = mappedProgress(progress, 12, 72, 'Busca · ');
  const results = await searchCpu(root, index, query, Math.max(40, (index.config?.maxContextFiles ?? 15) * 4), searchProgress);
  const { outgoing, incoming } = adjacency(index);
  const fileMap = new Map((index.files ?? []).map(file => [file.path, file]));
  const candidates = new Map(results.map(result => [result.path, { ...result, source: 'search' }]));
  const neighborhoods = results.slice(0, 8);
  let relationDone = 0;
  const relationTotal = Math.max(1, neighborhoods.reduce((sum, result) => sum + (outgoing.get(result.path)?.length ?? 0) + (incoming.get(result.path)?.length ?? 0), 0));
  for (const result of neighborhoods) {
    for (const edge of [...(outgoing.get(result.path) ?? []), ...(incoming.get(result.path) ?? [])]) {
      const relatedPath = edge.source === result.path ? edge.target : edge.source;
      const relatedFile = fileMap.get(relatedPath);
      relationDone++;
      progress.update({ completed: 72 + 16 * relationDone / relationTotal, total: 100, stage: 'Expandindo vizinhança estrutural', current: relatedPath });
      progress.log(`Relação ${edge.type} · ${result.path} ↔ ${relatedPath}`);
      if (!relatedFile) continue;
      const score = result.score * 0.72 + edge.weight * 0.28;
      const old = candidates.get(relatedPath);
      if (!old || score > old.score) candidates.set(relatedPath, {
        path: relatedPath,
        language: relatedFile.language,
        summary: relatedFile.summary,
        score,
        symbols: (relatedFile.symbols ?? []).slice(0, 12),
        basin: index.graph?.basins?.nodeToAttractor?.[relatedPath] ?? relatedPath,
        source: `graph:${edge.type}`
      });
    }
    await immediate();
  }

  const ordered = [...candidates.values()].sort((left, right) => right.score - left.score);
  const selected = [];
  let used = 100;
  const maxFiles = Number(index.config?.maxContextFiles ?? 15);
  for (let candidateIndex = 0; candidateIndex < ordered.length; candidateIndex++) {
    const candidate = ordered[candidateIndex];
    const source = `${candidate.path}\n${candidate.summary}\n${candidate.symbols.map(symbol => symbol.signature).join('\n')}`;
    const tokens = Math.max(1, Math.ceil(Math.max(source.length / 4, source.trim().split(/\s+/).filter(Boolean).length * 1.25))) + 45;
    if (selected.length < maxFiles && used + tokens <= budget) {
      selected.push({ ...candidate, estimatedTokens: tokens });
      used += tokens;
      progress.log(`Selecionado · ${candidate.path} · ${tokens} tokens`);
    } else {
      progress.log(`Ignorado pelo orçamento · ${candidate.path}`, 'debug');
    }
    progress.update({ completed: 88 + 10 * (candidateIndex + 1) / Math.max(ordered.length, 1), total: 100, stage: 'Montando orçamento de contexto', current: `${used}/${budget} tokens` });
    if ((candidateIndex & 31) === 0) await immediate();
  }

  const lines = [
    '# SupremeMind — Contexto Estrutural', '',
    `**Consulta:** ${query}`,
    `**Projeto:** ${index.projectName}`,
    `**Orçamento:** ${used}/${budget} tokens`, ''
  ];
  if (selected[0]) lines.push('## L0 — Core Attractor', '', `### \`${selected[0].path}\``, '', selected[0].summary, '');
  lines.push('## L1/L2 — Arquivos prioritários', '');
  for (const [selectedIndex, candidate] of selected.entries()) {
    lines.push(
      `### ${selectedIndex + 1}. \`${candidate.path}\``, '',
      `- Relevância: **${(candidate.score * 100).toFixed(1)}%**`,
      `- Origem: \`${candidate.source}\``,
      `- Bacia: \`${candidate.basin}\``,
      `- Tokens: ${candidate.estimatedTokens}`, '',
      candidate.summary, ''
    );
    const outs = (outgoing.get(candidate.path) ?? []).slice(0, 5);
    const ins = (incoming.get(candidate.path) ?? []).slice(0, 5);
    if (outs.length) lines.push(`- **Saídas:** ${outs.map(edge => `\`${edge.target}\` (${edge.type})`).join(', ')}`);
    if (ins.length) lines.push(`- **Entradas:** ${ins.map(edge => `\`${edge.source}\` (${edge.type})`).join(', ')}`);
    lines.push('');
  }
  lines.push('## Orientação', '', '1. Comece pelo L0 e pelos primeiros arquivos L1.', '2. Verifique relações de baixa confiança diretamente no código.', '3. Execute `suprememind impact <arquivo>` antes de alterar nós centrais.', '4. Rode testes e registre a decisão validada.', '');
  progress.update({ completed: 100, total: 100, stage: 'Contexto concluído', current: `${selected.length} arquivos · ${used} tokens` });
  return { query, budget, usedTokens: used, selected, markdown: lines.join('\n') };
}

async function runIndexProcess(root, input, progress, signal) {
  const args = [CLI_FILE, input.action, root];
  if (input.force) args.push('--force');
  const startedAt = Date.now();
  progress.update({ mode: 'indeterminate', stage: 'Descobrindo arquivos', current: root });
  progress.log(`Executando: node ${args.map(value => JSON.stringify(value)).join(' ')}`);
  const child = spawn(process.execPath, args, {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const onAbort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', onAbort, { once: true });
  let stdout = '';
  let stderr = '';
  let pending = '';
  const consume = text => {
    pending += text;
    const parts = pending.split(/[\r\n]+/);
    pending = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      stdout += `${line}\n`;
      const match = line.match(/\[SupremeMind\]\s+(\d+)\/(\d+)\s+(.+)/);
      if (match) {
        const completed = Number(match[1]);
        const total = Number(match[2]);
        const current = match[3].trim();
        progress.update({ completed, total, stage: 'Lendo e processando arquivos', current });
        progress.log(`[${completed}/${total}] ${current}`);
        if (completed >= total) {
          progress.update({ mode: 'indeterminate', stage: 'Construindo grafo, Git e salvando índice', current: 'Leitura de arquivos concluída' });
          progress.log('Leitura concluída. Finalizando relações, bacias e persistência.');
        }
      } else {
        progress.log(line);
      }
    }
  };
  child.stdout.on('data', chunk => consume(chunk.toString('utf8')));
  child.stderr.on('data', chunk => {
    const text = chunk.toString('utf8');
    stderr += text;
    for (const line of text.split(/\r?\n/).filter(Boolean)) progress.log(line, 'error');
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), TIMEOUTS[input.action] ?? 15 * 60_000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  signal.removeEventListener('abort', onAbort);
  if (pending.trim()) consume(`${pending}\n`);
  if (code !== 0) throw new Error(stderr.trim() || `Processo encerrado com código ${code}.`);
  progress.update({ completed: 100, total: 100, stage: 'Índice concluído', current: `Duração: ${Date.now() - startedAt} ms` });
  return { ok: true, action: input.action, stdout: stdout.trim(), stderr, data: null, durationMs: Date.now() - startedAt, acceleration: 'cpu' };
}

function orbit(index, target, depth, progress) {
  const { outgoing, incoming } = adjacency(index);
  const visited = new Set([target]);
  const levels = [{ depth: 0, nodes: [target] }];
  let frontier = [target];
  for (let level = 1; level <= depth; level++) {
    const next = [];
    for (const node of frontier) {
      progress.log(`Órbita nível ${level} · analisando ${node}`);
      for (const edge of [...(outgoing.get(node) ?? []), ...(incoming.get(node) ?? [])]) {
        const related = edge.source === node ? edge.target : edge.source;
        if (!visited.has(related)) {
          visited.add(related);
          next.push(related);
          progress.log(`Encontrado ${related} via ${edge.type}`);
        }
      }
    }
    levels.push({ depth: level, nodes: next.sort() });
    frontier = next;
    progress.update({ completed: level, total: Math.max(depth, 1), stage: 'Mapeando níveis da órbita', current: `Nível ${level} · ${next.length} nós` });
  }
  return {
    target,
    attractor: index.graph?.basins?.nodeToAttractor?.[target] ?? target,
    outgoing: (outgoing.get(target) ?? []).sort((left, right) => right.weight - left.weight),
    incoming: (incoming.get(target) ?? []).sort((left, right) => right.weight - left.weight),
    levels
  };
}

async function impact(index, target, depth, progress) {
  const { incoming } = adjacency(index);
  const seen = new Set([target]);
  const queue = [{ path: target, depth: 0, weight: 1 }];
  const items = [];
  const possible = Math.max(1, index.files?.length ?? 1);
  let processed = 0;
  while (queue.length) {
    const current = queue.shift();
    processed++;
    progress.update({ completed: Math.min(seen.size, possible), total: possible, stage: 'Percorrendo dependentes', current: `${current.path} · fila ${queue.length}` });
    progress.log(`Visitando ${current.path} · profundidade ${current.depth}`);
    if (current.depth >= depth) continue;
    for (const edge of incoming.get(current.path) ?? []) {
      if (seen.has(edge.source)) continue;
      seen.add(edge.source);
      const weight = current.weight * edge.weight;
      const item = { path: edge.source, depth: current.depth + 1, via: current.path, type: edge.type, weight };
      items.push(item);
      queue.push(item);
      progress.log(`Impactado ${item.path} via ${item.via} (${item.type})`);
    }
    if ((processed & 31) === 0) await immediate();
  }
  items.sort((left, right) => right.weight - left.weight);
  const direct = items.filter(item => item.depth === 1).length;
  const score = Math.min(100, direct * 9 + (items.length - direct) * 3 + (index.graph?.pageRank?.[target] ?? 0) * 45);
  const risk = score >= 70 ? 'CRITICAL' : score >= 45 ? 'HIGH' : score >= 20 ? 'MODERATE' : 'LOW';
  progress.update({ completed: 100, total: 100, stage: 'Impacto concluído', current: `${items.length} dependentes · ${risk}` });
  return { target, risk, score: Number(score.toFixed(2)), direct, indirect: items.length - direct, impacted: items };
}

function galaxyHtml(index, nodes, edges, basinCount) {
  const data = JSON.stringify({ nodes, edges });
  return `<!doctype html><meta charset="utf-8"><title>SupremeMind Galaxy</title><style>html,body{margin:0;background:#070a14;color:#eef;font:14px system-ui;overflow:hidden}header{height:50px;padding:0 16px;display:flex;align-items:center;background:#0d1121;border-bottom:1px solid #29304c;color:#65d9ff;font-weight:800}main{display:grid;grid-template-columns:1fr 320px;height:calc(100vh - 51px)}canvas{width:100%;height:100%}aside{padding:14px;background:#0c1020;border-left:1px solid #29304c;overflow:auto}input{width:100%;padding:10px;box-sizing:border-box;background:#151a2b;color:white;border:1px solid #303958;border-radius:8px}.muted{color:#95a0c1;font-size:12px;white-space:pre-wrap}</style><header>🧠 SupremeMind Galaxy — ${index.projectName}</header><main><canvas id="c"></canvas><aside><input id="q" placeholder="Buscar arquivo"><h3>Node Inspector</h3><div id="i" class="muted">Clique em um nó.</div><p class="muted">${nodes.length} nós · ${edges.length} arestas · ${basinCount} bacias</p></aside></main><script>const D=${data},c=document.getElementById('c'),x=c.getContext('2d'),M=new Map(D.nodes.map(n=>[n.id,n]));let s=.72,ox=0,oy=0,drag=false,lx=0,ly=0,sel=null,q='';function R(){let r=c.getBoundingClientRect(),d=devicePixelRatio||1;c.width=r.width*d;c.height=r.height*d;x.setTransform(d,0,0,d,0,0);W()}function P(n){return{x:c.clientWidth/2+ox+n.x*s,y:c.clientHeight/2+oy+n.y*s}}function C(t){let h=0;for(let z of t)h=(h*31+z.charCodeAt())%360;return'hsl('+h+' 78% 65%)'}function W(){x.clearRect(0,0,c.clientWidth,c.clientHeight);for(let e of D.edges){let a=M.get(e.source),b=M.get(e.target);if(!a||!b)continue;a=P(a);b=P(b);x.beginPath();x.moveTo(a.x,a.y);x.lineTo(b.x,b.y);x.strokeStyle=e.type==='co_change'?'#ff617c22':'#5e7ebe22';x.stroke()}for(let n of D.nodes){let p=P(n),m=!q||n.path.toLowerCase().includes(q);x.beginPath();x.arc(p.x,p.y,Math.max(2,n.size*s),0,7);x.fillStyle=m?C(n.language):'#5552';x.fill();if(n===sel){x.strokeStyle='white';x.lineWidth=2;x.stroke()}}}function K(a,b){let best=null,d=1e9;for(let n of D.nodes){let p=P(n),v=Math.hypot(a-p.x,b-p.y);if(v<Math.max(9,n.size*s+5)&&v<d){best=n;d=v}}return best}c.onmousedown=e=>{drag=true;lx=e.clientX;ly=e.clientY};onmouseup=()=>drag=false;c.onmousemove=e=>{if(drag){ox+=e.clientX-lx;oy+=e.clientY-ly;lx=e.clientX;ly=e.clientY;W()}};c.onclick=e=>{let r=c.getBoundingClientRect();sel=K(e.clientX-r.left,e.clientY-r.top);if(sel)document.getElementById('i').textContent=sel.path+'\n\n'+sel.summary;W()};c.onwheel=e=>{e.preventDefault();s=Math.max(.08,Math.min(4,s*(e.deltaY<0?1.12:.89)));W()};document.getElementById('q').oninput=e=>{q=e.target.value.toLowerCase();W()};onresize=R;R()</script>`;
}

async function generateGalaxy(root, index, output, progress) {
  const files = [...(index.files ?? [])]
    .sort((left, right) => (index.graph?.pageRank?.[right.path] ?? 0) - (index.graph?.pageRank?.[left.path] ?? 0))
    .slice(0, 5000);
  const basins = Object.entries(index.graph?.basins?.groups ?? {}).sort((left, right) => right[1].length - left[1].length);
  const basinIndex = new Map(basins.map(([attractor], indexValue) => [attractor, indexValue]));
  const nodes = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const attractor = index.graph?.basins?.nodeToAttractor?.[file.path] ?? file.path;
    const basin = basinIndex.get(attractor) ?? 0;
    const basinAngle = 2 * Math.PI * basin / Math.max(1, basins.length);
    const localIndex = index.graph?.basins?.groups?.[attractor]?.indexOf(file.path) ?? fileIndex;
    const localAngle = localIndex * 2.3999632297;
    const basinRadius = 220 + Math.sqrt(basin) * 55;
    const localRadius = 16 + Math.sqrt(localIndex) * 13;
    nodes.push({
      id: file.path,
      path: file.path,
      label: path.basename(file.path),
      language: file.language,
      summary: file.summary,
      attractor,
      centrality: index.graph?.pageRank?.[file.path] ?? 0,
      size: 4 + Math.sqrt((index.graph?.pageRank?.[file.path] ?? 0) * 700),
      x: Math.cos(basinAngle) * basinRadius + Math.cos(localAngle) * localRadius,
      y: Math.sin(basinAngle) * basinRadius + Math.sin(localAngle) * localRadius
    });
    progress.update({ completed: fileIndex + 1, total: Math.max(files.length, 1), stage: 'Preparando nós da Galaxy', current: file.path });
    progress.log(`Nó ${fileIndex + 1}/${files.length} · ${file.path}`);
    if ((fileIndex & 63) === 0) await immediate();
  }
  const allowed = new Set(nodes.map(node => node.path));
  const sourceEdges = index.graph?.edges ?? [];
  const edges = [];
  for (let edgeIndex = 0; edgeIndex < sourceEdges.length && edges.length < 30000; edgeIndex++) {
    const edge = sourceEdges[edgeIndex];
    if (allowed.has(edge.source) && allowed.has(edge.target)) edges.push(edge);
    progress.update({ completed: edgeIndex + 1, total: Math.max(sourceEdges.length, 1), stage: 'Filtrando arestas da Galaxy', current: `${edge.source} → ${edge.target}` });
    if ((edgeIndex & 255) === 0) await immediate();
  }
  const target = path.resolve(root, output ?? `${STATE_DIR}/suprememind-galaxy.html`);
  progress.update({ mode: 'indeterminate', stage: 'Serializando Galaxy', current: `${nodes.length} nós · ${edges.length} arestas` });
  progress.log(`Gravando relatório em ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, galaxyHtml(index, nodes, edges, basins.length));
  progress.update({ completed: 100, total: 100, stage: 'Galaxy concluída', current: target });
  return target;
}

async function runAction(root, input, progress, signal) {
  const startedAt = Date.now();
  const action = String(input.action ?? '');
  if (action === 'index' || action === 'update') return runIndexProcess(root, input, progress, signal);

  if (action === 'init') {
    const statePath = path.join(root, STATE_DIR);
    const configPath = path.join(root, CONFIG_FILE);
    const ignorePath = path.join(root, '.suprememindignore');
    progress.update({ completed: 0, total: 3, stage: 'Inicializando projeto', current: statePath });
    await fs.mkdir(statePath, { recursive: true });
    progress.log(`Pasta de estado pronta: ${statePath}`);
    progress.update({ completed: 1, total: 3, stage: 'Inicializando projeto', current: configPath });
    try { await fs.access(configPath); } catch {
      await fs.writeFile(configPath, `${JSON.stringify({ version: 1, projectName: path.basename(root), maxFileSize: 2500000, vectorDimensions: 128, tokenBudget: 6000, maxContextFiles: 15, gitCommitLimit: 500, ignore: ['.git', '.suprememind', 'node_modules', 'vendor', 'third_party', 'dist', 'build', 'bin', 'obj', 'Library', 'Temp', 'coverage'] }, null, 2)}\n`);
    }
    progress.log(`Configuração pronta: ${configPath}`);
    progress.update({ completed: 2, total: 3, stage: 'Inicializando projeto', current: ignorePath });
    try { await fs.access(ignorePath); } catch { await fs.writeFile(ignorePath, '# Regras adicionais, uma por linha\n'); }
    progress.log(`Regras de exclusão prontas: ${ignorePath}`);
    progress.update({ completed: 3, total: 3, stage: 'Projeto inicializado', current: root });
    return { ok: true, action, stdout: `[SupremeMind] Inicializado em ${root}`, stderr: '', data: null, durationMs: Date.now() - startedAt };
  }

  const index = await loadIndex(root, progress, 0, action === 'query' ? 10 : 12);
  if (action === 'query') {
    const results = await searchCpu(root, index, String(input.query ?? ''), Number(input.limit ?? 20), mappedProgress(progress, 10, 100));
    const data = results.map(result => ({ ...result, score: result.score * 100 }));
    const stdout = data.map((result, resultIndex) => `${String(resultIndex + 1).padStart(2, '0')}. ${result.score.toFixed(1)}% ${result.path}\n    ${String(result.summary ?? '').slice(0, 180)}`).join('\n');
    return { ok: true, action, stdout, stderr: '', data, durationMs: Date.now() - startedAt, acceleration: 'cpu-fallback' };
  }
  if (action === 'context') {
    const context = await buildContext(root, index, String(input.query ?? ''), Number(input.budget ?? index.config?.tokenBudget ?? 6000), progress);
    if (input.save) {
      const target = path.resolve(root, String(input.save));
      await fs.writeFile(target, `${context.markdown}\n`);
      progress.log(`Contexto salvo em ${target}`);
    }
    return { ok: true, action, stdout: context.markdown, stderr: '', data: context, durationMs: Date.now() - startedAt };
  }
  if (action === 'orbit') {
    const data = orbit(index, String(input.path ?? ''), Number(input.depth ?? 2), mappedProgress(progress, 12, 100));
    return { ok: true, action, stdout: JSON.stringify(data, null, 2), stderr: '', data, durationMs: Date.now() - startedAt };
  }
  if (action === 'impact') {
    const data = await impact(index, String(input.path ?? ''), Number(input.depth ?? 3), mappedProgress(progress, 12, 100));
    return { ok: true, action, stdout: JSON.stringify(data, null, 2), stderr: '', data, durationMs: Date.now() - startedAt };
  }
  if (action === 'recall') {
    const memories = await readMemories(root);
    const terms = tokenize(input.query ?? '');
    const scored = [];
    for (let memoryIndex = 0; memoryIndex < memories.length; memoryIndex++) {
      const memory = memories[memoryIndex];
      const score = terms.filter(term => `${memory.title} ${memory.content}`.toLowerCase().includes(term)).length;
      if (score || !terms.length) scored.push({ ...memory, score });
      progress.update({ completed: memoryIndex + 1, total: Math.max(memories.length, 1), stage: 'Consultando memórias', current: memory.title ?? memory.id });
      progress.log(`Memória ${memoryIndex + 1}/${memories.length} · ${memory.title ?? memory.id}`);
    }
    const data = scored.sort((left, right) => right.score - left.score).slice(0, Number(input.limit ?? 25));
    progress.update({ completed: 100, total: 100, stage: 'Memórias consultadas', current: `${data.length} resultados` });
    return { ok: true, action, stdout: JSON.stringify(data, null, 2), stderr: '', data, durationMs: Date.now() - startedAt };
  }
  if (action === 'graph') {
    const target = await generateGalaxy(root, index, input.output ?? `${STATE_DIR}/suprememind-galaxy.html`, mappedProgress(progress, 12, 100));
    const stdout = `[SupremeMind] Galaxy gerada em ${target}`;
    return { ok: true, action, stdout, stderr: '', data: { target }, durationMs: Date.now() - startedAt };
  }
  if (action === 'doctor') {
    progress.update({ completed: 1, total: 3, stage: 'Verificando índice', current: `${index.stats?.indexed ?? 0} arquivos` });
    progress.log(`Índice: ${index.stats?.indexed ?? 0} arquivos, ${index.stats?.symbols ?? 0} símbolos`);
    progress.update({ completed: 2, total: 3, stage: 'Verificando Git', current: index.git?.available ? 'Disponível' : 'Indisponível' });
    progress.log(`Git: ${index.git?.available ? 'OK' : index.git?.reason ?? 'indisponível'}`);
    progress.update({ completed: 3, total: 3, stage: 'Diagnóstico concluído', current: 'Estado saudável' });
    const stdout = `SupremeMind Doctor\n- Versão: 0.2.2\n- Node: ${process.version}\n- Projeto: ${root}\n- Índice: OK (${index.stats?.indexed ?? 0} arquivos)\n- Git: ${index.git?.available ? 'OK' : 'indisponível'}\n- Bacias: ${index.stats?.basins ?? 0}\n- Estado: saudável`;
    return { ok: true, action, stdout, stderr: '', data: null, durationMs: Date.now() - startedAt };
  }
  if (action === 'benchmark') {
    const queries = ['login authentication', 'database persistence', 'network packet', 'user interface', 'configuration'];
    const rows = [];
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
      const query = queries[queryIndex];
      progress.log(`Benchmark ${queryIndex + 1}/${queries.length}: ${query}`);
      const searchStarted = performance.now();
      const results = await searchCpu(root, index, query, 10, mappedProgress(progress, queryIndex / queries.length * 100, (queryIndex + 0.75) / queries.length * 100, `Benchmark ${queryIndex + 1} · `));
      const searchMs = performance.now() - searchStarted;
      rows.push({ query, searchMs: Number(searchMs.toFixed(2)), top: results[0]?.path ?? '', files: results.length });
      progress.update({ completed: queryIndex + 1, total: queries.length, stage: 'Benchmark', current: query });
    }
    const stdout = rows.map(row => `${row.query.padEnd(22)} ${String(row.searchMs).padStart(9)} ms  ${row.top}`).join('\n');
    return { ok: true, action, stdout, stderr: '', data: rows, durationMs: Date.now() - startedAt };
  }

  throw new Error(`Ação sem suporte no fluxo detalhado: ${action}`);
}

async function runRemember(root, input, progress) {
  const startedAt = Date.now();
  const file = path.join(root, STATE_DIR, 'memories.jsonl');
  progress.update({ completed: 1, total: 3, stage: 'Preparando memória', current: input.title ?? 'Memória' });
  await fs.mkdir(path.dirname(file), { recursive: true });
  const memory = {
    id: id('memory', `${Date.now()}:${input.title}:${input.content}`),
    type: input.type ?? 'task',
    title: input.title ?? 'Memória',
    content: input.content,
    status: input.status ?? 'recorded',
    files: Array.isArray(input.files) ? input.files : String(input.files ?? '').split(',').map(value => value.trim()).filter(Boolean),
    tags: Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(',').map(value => value.trim()).filter(Boolean),
    createdAt: now()
  };
  progress.log(`Memória criada: ${memory.id}`);
  progress.update({ completed: 2, total: 3, stage: 'Gravando memória', current: file });
  await fs.appendFile(file, `${JSON.stringify(memory)}\n`);
  progress.log(`Memória persistida em ${file}`);
  progress.update({ completed: 3, total: 3, stage: 'Memória concluída', current: memory.title });
  return { ok: true, action: 'remember', stdout: `[SupremeMind] Memória salva: ${memory.id}`, stderr: '', data: memory, durationMs: Date.now() - startedAt };
}

export function injectProgressAssets(html) {
  let output = html;
  if (!output.includes('/live-progress.css')) output = output.replace('</head>', '  <link rel="stylesheet" href="/live-progress.css">\n</head>');
  if (!output.includes('/live-progress.js')) {
    output = output.replace(
      '<script type="module" src="/app.js"></script>',
      '<script type="module" src="/live-progress.js"></script>\n  <script type="module" src="/app.js"></script>'
    );
  }
  return output;
}

export async function handleProgressRequest(req, res, url, root, events) {
  if (url.pathname !== '/api/action-stream' || req.method !== 'POST') return false;
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
    connection: 'keep-alive'
  });
  res.flushHeaders?.();
  const emit = createEmitter(res);
  const progress = createProgress(emit);
  const input = await readBody(req);
  const action = String(input.action ?? '');
  const startedAt = Date.now();
  const event = {
    id: `${startedAt}-${Math.random().toString(16).slice(2)}`,
    action,
    status: 'running',
    startedAt: now(),
    acceleration: action === 'query' ? 'cpu-fallback' : 'cpu',
    verbose: true
  };
  events.unshift(event);
  events.splice(200);
  const controller = new AbortController();
  const onClose = () => controller.abort('Cliente desconectado');
  req.on('close', onClose);
  const timeoutMs = TIMEOUTS[action] ?? 5 * 60_000;
  const timeout = setTimeout(() => controller.abort(`Tempo limite de ${Math.round(timeoutMs / 1000)} segundos excedido`), timeoutMs);
  emit({ type: 'start', action, eventId: event.id, mode: 'indeterminate', stage: 'Preparando operação' });
  progress.log(`Operação iniciada: ${action}`);
  try {
    const result = action === 'remember'
      ? await runRemember(root, input, progress)
      : await runAction(root, input, progress, controller.signal);
    event.status = 'success';
    event.finishedAt = now();
    event.durationMs = Date.now() - startedAt;
    event.stdout = String(result.stdout ?? '').slice(-12000);
    emit({ type: 'progress', mode: 'determinate', completed: 100, total: 100, percent: 100, stage: 'Concluído', current: `${event.durationMs} ms` });
    progress.log(`Operação concluída em ${event.durationMs} ms`, 'success');
    emit({ type: 'result', result: { ...result, durationMs: event.durationMs } });
  } catch (error) {
    event.status = 'error';
    event.finishedAt = now();
    event.durationMs = Date.now() - startedAt;
    event.stderr = String(controller.signal.aborted ? controller.signal.reason : error.message ?? error).slice(-12000);
    progress.log(event.stderr, 'error');
    emit({ type: 'error', error: event.stderr });
  } finally {
    clearTimeout(timeout);
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
  return true;
}
