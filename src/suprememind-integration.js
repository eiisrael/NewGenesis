import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { sanitizeModelText } from './core/content-sanitizer.js';
import { redactText } from './telemetry.js';

const execFileAsync = promisify(execFile);

const SUPREME_MIND_DIR = path.resolve('C:\\Users\\Home\\Desktop\\Genesis Supreme Mind\\SupremeMind');
const SUPREME_MIND_BIN = path.join(SUPREME_MIND_DIR, 'bin', 'suprememind.js');
const STATE_DIR = '.suprememind';
const CONFIG_FILE = 'suprememind.config.json';
const SENSITIVE_FILES = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json',
  'secrets.json', 'service-account.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.crt', '.cer']);
const INDEXABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.json', '.jsonc', '.jsonl', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.py', '.pyi', '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less',
  '.sql', '.graphql', '.gql', '.proto', '.sh', '.ps1', '.bat', '.cmd', '.java', '.kt', '.cs', '.fs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
  '.go', '.rs', '.php', '.rb', '.swift', '.dart', '.lua', '.r', '.ex', '.exs', '.erl', '.clj', '.cljs', '.sol', '.tf', '.tfvars', '.hcl',
  '.csproj', '.fsproj', '.vbproj', '.vcxproj', '.sln', '.slnx', '.props', '.targets', '.cmake', '.mk', '.gradle', '.properties'
]);
const INDEXABLE_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'readme', 'license', 'licence', 'changelog',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pyproject.toml', 'requirements.txt',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'pom.xml', 'build.gradle', 'cmakelists.txt', 'tsconfig.json'
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function safeRelativeRule(value) {
  const rule = String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  return rule && rule.length <= 180 && !rule.startsWith('/') && !/^[a-z]:\//i.test(rule) && !rule.split('/').includes('..') ? rule : null;
}

function safeConfig(user = {}) {
  const ignore = Array.isArray(user.ignore)
    ? user.ignore.map(safeRelativeRule).filter(Boolean).slice(0, 200)
    : DEFAULT_CONFIG.ignore;
  return {
    ...DEFAULT_CONFIG,
    projectName: String(user.projectName || '').replace(/[\\/\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 90) || null,
    maxFileSize: boundedInteger(user.maxFileSize, DEFAULT_CONFIG.maxFileSize, 1_024, 5_000_000),
    vectorDimensions: boundedInteger(user.vectorDimensions, DEFAULT_CONFIG.vectorDimensions, 32, 512),
    tokenBudget: boundedInteger(user.tokenBudget, DEFAULT_CONFIG.tokenBudget, 512, 20_000),
    maxContextFiles: boundedInteger(user.maxContextFiles, DEFAULT_CONFIG.maxContextFiles, 1, 40),
    gitCommitLimit: boundedInteger(user.gitCommitLimit, DEFAULT_CONFIG.gitCommitLimit, 0, 1_000),
    ignore: [...new Set([...DEFAULT_CONFIG.ignore, ...ignore])]
  };
}

function sensitiveIndexPath(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').toLowerCase();
  const basename = path.posix.basename(normalized);
  return SENSITIVE_FILES.has(basename)
    || basename.startsWith('.env.')
    || SENSITIVE_EXTENSIONS.has(path.posix.extname(basename));
}

function indexablePath(relativePath) {
  const basename = path.posix.basename(String(relativePath || '')).toLowerCase();
  return INDEXABLE_NAMES.has(basename) || INDEXABLE_EXTENSIONS.has(path.posix.extname(basename));
}

function plainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function finiteNumber(value, minimum = -Infinity, maximum = Infinity) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function boundedString(value, maximum, { allowEmpty = true } = {}) {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validStringArray(value, maximumItems, maximumLength) {
  return Array.isArray(value) && value.length <= maximumItems
    && value.every(item => boundedString(item, maximumLength, { allowEmpty: false }));
}

function validIndexPath(value) {
  if (!boundedString(value, 500, { allowEmpty: false })) return false;
  const normalized = String(value).replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized === value && Boolean(safeRelativeRule(normalized))
    && !sensitiveIndexPath(normalized) && indexablePath(normalized);
}

function validIndexedFile(file, config) {
  if (!plainRecord(file) || !validIndexPath(file.path)
    || !boundedString(file.id, 180, { allowEmpty: false })
    || !boundedString(file.hash, 180, { allowEmpty: false })
    || !boundedString(file.language, 80, { allowEmpty: false })
    || !boundedString(file.summary, 1_200)
    || !finiteNumber(file.lines, 0, 10_000_000)
    || !finiteNumber(file.size, 0, config.maxFileSize)
    || !finiteNumber(file.mtimeMs, 0, Number.MAX_SAFE_INTEGER)
    || !finiteNumber(file.tokenEstimate, 0, 10_000_000)
    || !finiteNumber(file.termCount, 0, 10_000_000)
    || !Array.isArray(file.vector) || file.vector.length !== config.vectorDimensions
    || !file.vector.every(value => finiteNumber(value, -1.1, 1.1))
    || !plainRecord(file.terms) || Object.keys(file.terms).length > 100_000
    || !Object.entries(file.terms).every(([term, count]) => boundedString(term, 160, { allowEmpty: false }) && finiteNumber(count, 0, 10_000_000))
    || !validStringArray(file.imports, 2_000, 1_000)
    || !validStringArray(file.calls, 1_000, 300)
    || !Array.isArray(file.symbols) || file.symbols.length > 2_000
    || !Array.isArray(file.chunks) || file.chunks.length > 48) return false;

  if (!file.symbols.every(symbol => plainRecord(symbol)
    && boundedString(symbol.id, 180, { allowEmpty: false })
    && boundedString(symbol.kind, 80, { allowEmpty: false })
    && boundedString(symbol.name, 300, { allowEmpty: false })
    && (symbol.qualifiedName === undefined || boundedString(symbol.qualifiedName, 500))
    && boundedString(symbol.signature ?? '', 500)
    && finiteNumber(symbol.line, 0, Math.max(file.lines, 1)))) return false;

  return file.chunks.every(chunk => plainRecord(chunk)
    && finiteNumber(chunk.startLine, 1, Math.max(file.lines, 1))
    && finiteNumber(chunk.endLine, chunk.startLine, Math.max(file.lines, 1))
    && boundedString(chunk.text, 1_800));
}

function validPathMap(value, paths, { valuesArePaths = false } = {}) {
  if (!plainRecord(value) || Object.keys(value).length > paths.size) return false;
  return Object.entries(value).every(([key, item]) => paths.has(key)
    && (valuesArePaths ? typeof item === 'string' && paths.has(item) : finiteNumber(item, 0, 1)));
}

function validIndexGraph(graph, files) {
  if (!plainRecord(graph) || !Array.isArray(graph.edges) || graph.edges.length > 200_000
    || !plainRecord(graph.basins)) return false;
  const paths = new Set(files.map(file => file.path));
  if (!validPathMap(graph.pageRank, paths)
    || !validPathMap(graph.basins.next, paths, { valuesArePaths: true })
    || !validPathMap(graph.basins.nodeToAttractor, paths, { valuesArePaths: true })
    || !plainRecord(graph.basins.groups) || Object.keys(graph.basins.groups).length > paths.size) return false;

  if (!Object.entries(graph.basins.groups).every(([attractor, members]) => paths.has(attractor)
    && Array.isArray(members) && members.length <= paths.size
    && members.every(member => typeof member === 'string' && paths.has(member)))) return false;

  return graph.edges.every(edge => plainRecord(edge)
    && boundedString(edge.id, 180, { allowEmpty: false })
    && typeof edge.source === 'string' && paths.has(edge.source)
    && typeof edge.target === 'string' && paths.has(edge.target)
    && boundedString(edge.type, 80, { allowEmpty: false })
    && finiteNumber(edge.weight, 0, 1)
    && finiteNumber(edge.confidence ?? 1, 0, 1)
    && (edge.meta === undefined || plainRecord(edge.meta)));
}

const MEMORY_TYPES = new Set(['task', 'decision', 'note', 'bug', 'architecture', 'preference']);
const MEMORY_STATUSES = new Set(['recorded', 'active', 'resolved', 'archived']);

function safeMemoryList(value, { paths = false } = {}) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const raw of value) {
    let item = String(raw || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!item) continue;
    if (paths) {
      item = safeRelativeRule(item);
      if (!item || sensitiveIndexPath(item)) continue;
    } else {
      item = item.slice(0, 64);
    }
    if (!items.includes(item)) items.push(item);
    if (items.length >= (paths ? 60 : 30)) break;
  }
  return items;
}

function safeMemoryData(value = {}) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const type = String(data.type || 'task').toLowerCase();
  const status = String(data.status || 'recorded').toLowerCase();
  return {
    type: MEMORY_TYPES.has(type) ? type : 'task',
    title: redactText(String(data.title || 'Memória').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), 160) || 'Memória',
    content: redactText(String(data.content || '').trim(), 12_000),
    status: MEMORY_STATUSES.has(status) ? status : 'recorded',
    files: safeMemoryList(data.files, { paths: true }),
    tags: safeMemoryList(data.tags)
  };
}

export class SupremeMindIntegration {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this._index = null;
    this.initialized = false;
  }

  async init(config = {}) {
    const statePath = path.join(this.projectRoot, STATE_DIR);
    await fs.mkdir(statePath, { recursive: true });
    
    const defaultConfig = {
      ...safeConfig({ ...config, projectName: config.projectName || path.basename(this.projectRoot) }),
      version: 2
    };
    
    const configPath = path.join(this.projectRoot, CONFIG_FILE);
    try {
      await fs.access(configPath);
    } catch {
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');
    }
    
    const ignorePath = path.join(this.projectRoot, '.suprememindignore');
    try {
      await fs.access(ignorePath);
    } catch {
      await fs.writeFile(ignorePath, '# Regras adicionais, uma por linha\n');
    }
    
    this.initialized = true;
    return { success: true, projectRoot: this.projectRoot };
  }

  async index({ force = false, progress } = {}) {
    if (!this.initialized) await this.init();
    
    const config = await this.loadConfig();
    const entries = await this.walk(config);
    
    let previous;
    try {
      if (!force) previous = await this.loadIndex();
    } catch {}
    
    const old = new Map((previous?.files ?? []).map(f => [f.path, f]));
    const files = [];
    let reused = 0, parsed = 0;
    
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      progress?.(i + 1, entries.length, e.rel);
      
      const buf = await fs.readFile(e.abs);
      if (buf.includes(0)) continue;
      
      const text = buf.toString('utf8');
      const hash = this.sha(text);
      const prior = old.get(e.rel);
      
      if (prior?.hash === hash) {
        files.push({ ...prior, size: e.size, mtimeMs: e.mtimeMs });
        reused++;
        continue;
      }
      
      files.push({ ...this.parse(e.rel, text, config.vectorDimensions), hash, size: e.size, mtimeMs: e.mtimeMs });
      parsed++;
    }
    
    const git = await this.gitData(config);
    const graph = this.buildGraph(files, git);
    
    this._index = {
      schemaVersion: 3,
      version: '0.4.0',
      projectName: config.projectName,
      projectRoot: path.resolve(this.projectRoot),
      generatedAt: new Date().toISOString(),
      config,
      files,
      git,
      graph,
      stats: {
        indexed: files.length,
        parsed,
        reused,
        symbols: files.reduce((s, f) => s + f.symbols.length, 0),
        edges: graph.edges.length,
        basins: Object.keys(graph.basins.groups).length,
        tokens: files.reduce((s, f) => s + f.tokenEstimate, 0)
      }
    };
    
    await this.saveIndex();
    return this._index;
  }

  async loadIndex() {
    const indexPath = path.join(this.projectRoot, STATE_DIR, 'index.json');
    const stat = await fs.stat(indexPath);
    if (stat.size > 64 * 1024 * 1024) {
      const error = new Error('O índice SupremeMind excede o limite seguro e precisa ser recriado.');
      error.code = 'suprememind_index_too_large';
      error.status = 413;
      throw error;
    }
    const content = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed?.schemaVersion !== 3 || !Array.isArray(parsed.files) || parsed.files.length > 10_000
      || !parsed.graph || !parsed.graph.pageRank || !parsed.graph.basins?.groups || !parsed.graph.basins?.nodeToAttractor) {
      const error = new Error('O índice SupremeMind precisa ser recriado na versão segura atual.');
      error.code = 'suprememind_index_outdated';
      error.status = 409;
      throw error;
    }
    if (path.resolve(parsed.projectRoot || '') !== path.resolve(this.projectRoot)) {
      const error = new Error('O índice SupremeMind pertence a outro caminho de projeto.');
      error.code = 'suprememind_index_project_mismatch';
      error.status = 409;
      throw error;
    }
    const config = safeConfig(parsed.config || {});
    const unsafe = parsed.files.some(file => !validIndexedFile(file, config));
    if (unsafe || !validIndexGraph(parsed.graph, parsed.files)) {
      const error = new Error('O índice SupremeMind falhou na validação de segurança e precisa ser recriado.');
      error.code = 'suprememind_index_unsafe';
      error.status = 409;
      throw error;
    }
    const stats = {
      indexed: parsed.files.length,
      parsed: boundedInteger(parsed.stats?.parsed, parsed.files.length, 0, parsed.files.length),
      reused: boundedInteger(parsed.stats?.reused, 0, 0, parsed.files.length),
      symbols: parsed.files.reduce((sum, file) => sum + file.symbols.length, 0),
      edges: parsed.graph.edges.length,
      basins: Object.keys(parsed.graph.basins.groups).length,
      tokens: parsed.files.reduce((sum, file) => sum + file.tokenEstimate, 0)
    };
    this._index = {
      ...parsed,
      projectName: boundedString(parsed.projectName, 120) ? parsed.projectName : path.basename(this.projectRoot),
      generatedAt: boundedString(parsed.generatedAt, 80) ? parsed.generatedAt : null,
      config,
      stats
    };
    return this._index;
  }

  async search(query, limit = 20) {
    if (!this._index) await this.loadIndex();
    return this.doSearch(String(query || '').slice(0, 2_000), boundedInteger(limit, 20, 1, 100));
  }

  async getContext(query, budget = 6000) {
    if (!this._index) await this.loadIndex();
    return this.doContext(String(query || '').slice(0, 2_000), boundedInteger(budget, 6_000, 512, 20_000));
  }

  async getImpact(filePath, depth = 3) {
    if (!this._index) await this.loadIndex();
    return this.doImpact(String(filePath || '').slice(0, 500), boundedInteger(depth, 3, 1, 8));
  }

  async getOrbit(filePath, depth = 2) {
    if (!this._index) await this.loadIndex();
    return this.doOrbit(String(filePath || '').slice(0, 500), boundedInteger(depth, 2, 1, 8));
  }

  async saveMemory(input) {
    const data = safeMemoryData(input);
    await fs.mkdir(path.join(this.projectRoot, STATE_DIR), { recursive: true });
    const memory = {
      id: this.id('memory', `${Date.now()}:${data.title}:${data.content}`),
      type: data.type ?? 'task',
      title: data.title ?? 'Memória',
      content: data.content,
      status: data.status ?? 'recorded',
      files: data.files ?? [],
      tags: data.tags ?? [],
      createdAt: new Date().toISOString()
    };
    await fs.appendFile(
      path.join(this.projectRoot, STATE_DIR, 'memories.jsonl'),
      JSON.stringify(memory) + '\n'
    );
    return memory;
  }

  async listMemories(query = '', limit = 10) {
      const memories = await this.loadMemories();
      const q = this.tokenize(String(query || '').slice(0, 2_000));
      const results = memories
        .map(m => ({ ...m, score: q.filter(t => `${m.title} ${m.content}`.toLowerCase().includes(t)).length }))
        .filter(m => m.score || !q.length)
        .sort((a, b) => b.score - a.score)
        .slice(0, boundedInteger(limit, 10, 1, 100));
      return results;
    }

    isIndexed() {
      return this._index !== null;
    }

    async invalidateIndex() {
      this._index = null;
      await fs.rm(path.join(this.projectRoot, STATE_DIR, 'index.json'), { force: true });
      return { indexed: false, stale: false };
    }

    getProjectInfo() {
      if (!this._index) return null;
      return {
        projectName: this._index.projectName,
        projectRoot: this._index.projectRoot,
        fileCount: this._index.stats.indexed,
        symbolCount: this._index.stats.symbols,
        edgeCount: this._index.stats.edges,
        basinCount: this._index.stats.basins,
        totalTokens: this._index.stats.tokens,
        generatedAt: this._index.generatedAt,
        gitAvailable: this._index.git?.available ?? false,
        gitCommits: this._index.git?.commitCount ?? 0
      };
    }

    getGraph({ nodeLimit = 240, edgeLimit = 800 } = {}) {
      if (!this._index) return { nodes: [], edges: [], basins: [], truncated: false };
      const safeNodeLimit = Math.min(500, Math.max(1, Number(nodeLimit) || 240));
      const safeEdgeLimit = Math.min(2_000, Math.max(1, Number(edgeLimit) || 800));
      const ranked = [...this._index.files]
        .sort((left, right) => (this._index.graph.pageRank[right.path] || 0) - (this._index.graph.pageRank[left.path] || 0))
        .slice(0, safeNodeLimit);
      const paths = new Set(ranked.map(file => file.path));
      const nodes = ranked.map(file => ({
        id: file.path,
        path: file.path,
        language: file.language,
        size: file.size,
        lines: file.lines,
        symbols: file.symbols.length,
        centrality: this._index.graph.pageRank[file.path] || 0,
        basin: this._index.graph.basins.nodeToAttractor[file.path] || file.path
      }));
      const edges = this._index.graph.edges
        .filter(edge => paths.has(edge.source) && paths.has(edge.target))
        .sort((left, right) => right.weight - left.weight)
        .slice(0, safeEdgeLimit)
        .map(({ id, source, target, type, weight, confidence }) => ({ id, source, target, type, weight, confidence }));
      const basins = Object.entries(this._index.graph.basins.groups)
        .map(([attractor, members]) => ({ attractor, size: members.length, members: members.filter(item => paths.has(item)).slice(0, 80) }))
        .filter(basin => basin.members.length)
        .sort((left, right) => right.size - left.size);
      return {
        nodes,
        edges,
        basins,
        truncated: ranked.length < this._index.files.length || edges.length < this._index.graph.edges.length,
        totals: { nodes: this._index.files.length, edges: this._index.graph.edges.length }
      };
    }

    listIndexedFiles({ limit = 300, query = '' } = {}) {
      if (!this._index) return [];
      const safeLimit = Math.min(1_000, Math.max(1, Number(limit) || 300));
      const needle = String(query || '').trim().toLowerCase();
      return this._index.files
        .filter(file => !needle || `${file.path} ${file.language} ${file.summary}`.toLowerCase().includes(needle))
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, safeLimit)
        .map(file => ({
          path: file.path,
          language: file.language,
          size: file.size,
          lines: file.lines,
          tokenEstimate: file.tokenEstimate,
          symbolCount: file.symbols.length,
          importCount: file.imports.length,
          chunkCount: file.chunks?.length || 0,
          summary: file.summary,
          basin: this._index.graph.basins.nodeToAttractor[file.path] || file.path,
          centrality: this._index.graph.pageRank[file.path] || 0
        }));
    }

  // --- Internal methods ---

  async loadConfig() {
    const configPath = path.join(this.projectRoot, CONFIG_FILE);
    let user = {};
    try {
      user = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return {
      ...safeConfig({ ...user, projectName: user.projectName || path.basename(this.projectRoot) }),
      version: 2
    };
  }

  async walk(config) {
    const extra = await fs.readFile(path.join(this.projectRoot, '.suprememindignore'), 'utf8').catch(() => '');
    const ignored = [...config.ignore, ...extra.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'))];
    const out = [];
    const stack = [this.projectRoot];
    
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { continue; }
      
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = this.norm(path.relative(this.projectRoot, abs));
        if (!rel) continue;
        
        if (e.isDirectory()) {
          if (ignored.some(x => rel === x || rel.startsWith(`${x}/`)) || (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.codex')) continue;
          stack.push(abs);
        } else if (e.isFile()) {
          if (ignored.some(x => rel === x || rel.startsWith(`${x}/`))) continue;
          if (sensitiveIndexPath(rel) || !indexablePath(rel)) continue;
          const st = await fs.stat(abs);
          if (st.size <= config.maxFileSize) out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  async gitData(config) {
    try {
      const { stdout } = await execFileAsync('git', ['log', `-n${config.gitCommitLimit}`, '--format=__C__%H|%ct', '--name-only', '--no-renames', '--', '.'], { cwd: this.projectRoot, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      const commits = [];
      let cur;
      for (const raw of stdout.split(/\r?\n/)) {
        const l = raw.trim();
        if (!l) continue;
        if (l.startsWith('__C__')) {
          cur = { files: [] };
          commits.push(cur);
        } else {
          cur?.files.push(this.norm(l));
        }
      }
      const count = {};
      const pairs = new Map();
      for (const c of commits) {
        const files = this.unique(c.files).sort();
        for (const f of files) count[f] = (count[f] ?? 0) + 1;
        if (files.length > 80) continue;
        for (let i = 0; i < files.length; i++) {
          for (let j = i + 1; j < files.length; j++) {
            const k = `${files[i]}\0${files[j]}`;
            pairs.set(k, (pairs.get(k) ?? 0) + 1);
          }
        }
      }
      const co = [];
      for (const [k, n] of pairs) {
        if (n < 2) continue;
        const [a, b] = k.split('\0');
        co.push({ source: a, target: b, count: n, score: n / Math.sqrt(count[a] * count[b]) });
      }
      return { available: true, commitCount: commits.length, coChanges: co.sort((a, b) => b.score - a.score).slice(0, 50000) };
    } catch (e) {
      return { available: false, reason: e.message, coChanges: [] };
    }
  }

  parse(relative, text, dims) {
    text = redactText(text, Math.max(1, String(text || '').length));
    text = sanitizeModelText(text, {
      maxLineCharacters: Number.MAX_SAFE_INTEGER,
      maxCharacters: Number.MAX_SAFE_INTEGER
    }).text;
    const lang = this.language(relative);
    let imports = [], symbols = [], calls = [];
    
    if (lang === 'cpp') {
      imports = this.matches(text, /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm, m => m[1]);
      symbols.push(...this.matches(text, /\b(class|struct|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/g, (m, l) => ({ kind: m[1], name: m[2], line: l, signature: m[0] })));
      symbols.push(...this.matches(text, /(?:^|\n\s*)(?:(?:inline|static|virtual|constexpr|extern|friend|explicit)\s+)*(?:[\w:<>~*&]+\s+)+([A-Za-z_~]\w*(?:::\w+)*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:\{|$)/gm, (m, l) => ({ kind: 'function', name: m[1].split('::').at(-1), qualifiedName: m[1], line: l, signature: m[0].trim().slice(0, 240) })));
      calls = this.matches(text, /\b([A-Za-z_]\w*(?:::\w+)*)\s*\(/g, m => { const n = m[1].split('::').at(-1); return CALL_SKIP.has(n) ? null : n; });
    } else if (lang === 'csharp') {
      imports = this.matches(text, /^\s*using\s+([A-Za-z_]\w*(?:\.\w+)*)\s*;/gm, m => m[1]);
      symbols.push(...this.matches(text, /\b(class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/g, (m, l) => ({ kind: m[1], name: m[2], line: l, signature: m[0] })));
      symbols.push(...this.matches(text, /\b(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|partial|extern|unsafe|new|\s)+\s*[\w<>,.?[\]]+\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*(?:=>|\{)/g, (m, l) => ({ kind: 'method', name: m[1], line: l, signature: m[0].trim().slice(0, 240) })));
      calls = this.matches(text, /\b([A-Za-z_]\w*)\s*\(/g, m => CALL_SKIP.has(m[1]) ? null : m[1]);
    } else if (['javascript', 'typescript'].includes(lang)) {
      imports = [...this.matches(text, /\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g, m => m[1]), ...this.matches(text, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, m => m[1])];
      symbols.push(...this.matches(text, /\b(?:export\s+)?(?:default\s+)?(class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, (m, l) => ({ kind: m[1], name: m[2], line: l, signature: m[0] })));
      symbols.push(...this.matches(text, /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, (m, l) => ({ kind: 'function', name: m[1], line: l, signature: m[0].slice(0, 240) })));
      calls = this.matches(text, /\b([A-Za-z_$][\w$]*)\s*\(/g, m => CALL_SKIP.has(m[1]) ? null : m[1]);
    } else if (lang === 'python') {
      imports = [...this.matches(text, /^\s*import\s+([A-Za-z_]\w*(?:\.\w+)*)/gm, m => m[1]), ...this.matches(text, /^\s*from\s+([A-Za-z_.][\w.]*)\s+import\s+/gm, m => m[1])];
      symbols.push(...this.matches(text, /^\s*class\s+([A-Za-z_]\w*)/gm, (m, l) => ({ kind: 'class', name: m[1], line: l, signature: m[0].trim() })));
      symbols.push(...this.matches(text, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, (m, l) => ({ kind: 'function', name: m[1], line: l, signature: m[0].trim() })));
      calls = this.matches(text, /\b([A-Za-z_]\w*)\s*\(/g, m => CALL_SKIP.has(m[1]) ? null : m[1]);
    } else if (lang === 'html') {
      imports = [
        ...this.matches(text, /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, m => m[1]),
        ...this.matches(text, /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, m => m[1])
      ];
      symbols.push(...this.matches(text, /\bid\s*=\s*["']([^"']+)["']/gi, (m, l) => ({ kind: 'element', name: m[1], line: l, signature: `id="${m[1]}"` })));
      symbols.push(...this.matches(text, /\bclass\s+([A-Za-z_$][\w$]*)/g, (m, l) => ({ kind: 'class', name: m[1], line: l, signature: m[0] })));
      symbols.push(...this.matches(text, /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, (m, l) => ({ kind: 'function', name: m[1], line: l, signature: m[0] })));
      symbols.push(...this.matches(text, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, (m, l) => ({ kind: 'function', name: m[1], line: l, signature: m[0].slice(0, 240) })));
      symbols.push(...this.matches(text, /\.addEventListener\s*\(\s*["']([^"']+)["']/g, (m, l) => ({ kind: 'event', name: m[1], line: l, signature: m[0] })));
      calls = this.matches(text, /\b([A-Za-z_$][\w$]*)\s*\(/g, m => CALL_SKIP.has(m[1]) ? null : m[1]);
    } else if (lang === 'css') {
      imports = this.matches(text, /@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?/gi, m => m[1]);
      symbols.push(...this.matches(text, /(^|\})\s*([^@}{][^{]{0,180})\s*\{/gm, (m, l) => ({ kind: 'selector', name: m[2].trim(), line: l, signature: m[2].trim().slice(0, 240) })));
      symbols.push(...this.matches(text, /(--[A-Za-z0-9_-]+)\s*:/g, (m, l) => ({ kind: 'variable', name: m[1], line: l, signature: m[0] })));
    } else if (lang === 'yaml') {
      symbols = this.matches(text, /^(\s*)([A-Za-z0-9_.-]+)\s*:/gm, (m, l) => ({ kind: 'key', name: m[2], line: l, signature: m[0].trim() }));
      imports = this.matches(text, /^\s*(?:uses|extends|include|import)\s*:\s*["']?([^\s"']+)/gmi, m => m[1]);
    } else if (lang === 'json') {
      symbols = this.matches(text, /^\s*"([^"\n]+)"\s*:/gm, (m, l) => ({ kind: 'key', name: m[1], line: l, signature: m[0].trim() }));
    } else if (lang === 'text') {
      symbols = this.matches(text, /^#{1,6}\s+(.+)$/gm, (m, l) => ({ kind: 'heading', name: m[1].trim(), line: l, signature: m[0].trim() }));
    }
    
    imports = this.unique(imports.filter(Boolean));
    calls = this.unique(calls.filter(Boolean)).slice(0, 1000);
    symbols = symbols.slice(0, 2000).map(s => ({ ...s, id: this.id('symbol', `${relative}:${s.kind}:${s.name}:${s.line}`) }));
    
    const sourceLines = text.split(/\r?\n/);
    const chunks = [];
    const linesPerChunk = 60;
    for (let start = 0; start < sourceLines.length && chunks.length < 48; start += linesPerChunk) {
      const rawChunk = sourceLines.slice(start, start + linesPerChunk).join('\n').trim();
      if (!rawChunk) continue;
      const excerpt = sanitizeModelText(rawChunk, { maxCharacters: 1_800, maxLineCharacters: 1_200 }).text;
      chunks.push({ startLine: start + 1, endLine: Math.min(sourceLines.length, start + linesPerChunk), text: excerpt });
    }

    const summary = [`${relative} (${lang})`, symbols.length ? `Símbolos: ${symbols.slice(0, 12).map(s => s.name).join(', ')}` : '', imports.length ? `Dependências: ${imports.slice(0, 8).join(', ')}` : ''].filter(Boolean).join('. ').slice(0, 900);
    const searchText = [relative, lang, summary, ...symbols.map(s => `${s.kind} ${s.name} ${s.signature ?? ''}`), ...imports, ...chunks.map(chunk => chunk.text)].join('\n');
    const terms = this.tokenize(searchText);
    const tf = {};
    for (const t of terms) tf[t] = (tf[t] ?? 0) + 1;
    
    return {
      id: this.id('file', relative),
      path: relative,
      language: lang,
      lines: text.split(/\r?\n/).length,
      tokenEstimate: this.estimateTokens(text),
      summary,
      symbols,
      imports,
      calls,
      chunks,
      terms: tf,
      termCount: terms.length,
      vector: this.vector(searchText, dims)
    };
  }

  buildGraph(files, git) {
    const byPath = new Map(files.map(f => [f.path, f]));
    const byBase = new Map();
    const symbols = new Map();
    const edgeMap = new Map();
    
    for (const f of files) {
      const b = path.posix.basename(f.path);
      if (!byBase.has(b)) byBase.set(b, []);
      byBase.get(b).push(f.path);
      for (const s of f.symbols) {
        const k = s.name.toLowerCase();
        if (!symbols.has(k)) symbols.set(k, []);
        symbols.get(k).push(f.path);
      }
    }
    
    const add = (source, target, type, weight, confidence = 1, meta = {}) => {
      if (!source || !target || source === target) return;
      const k = `${source}\0${target}\0${type}`;
      if (edgeMap.size >= 200_000 && !edgeMap.has(k)) return;
      if (!edgeMap.has(k)) edgeMap.set(k, { id: this.id('edge', k), source, target, type, weight, confidence, meta });
    };
    
    for (const f of files) {
      for (const spec of f.imports) {
        const t = this.resolveImport(f.path, spec, byPath, byBase);
        if (t) add(f.path, t, 'dependency', .9, .95, { specifier: spec });
      }
      for (const call of f.calls) {
        const targets = symbols.get(call.toLowerCase()) ?? [];
        if (targets.length && targets.length <= 4) {
          for (const t of targets) add(f.path, t, 'call', targets.length === 1 ? .78 : .58, targets.length === 1 ? .8 : .45, { symbol: call });
        }
      }
    }
    
    for (const r of git.coChanges ?? []) {
      if (!byPath.has(r.source) || !byPath.has(r.target)) continue;
      const w = Math.min(.9, .25 + r.score * .65);
      add(r.source, r.target, 'co_change', w, r.score, { commits: r.count });
      add(r.target, r.source, 'co_change', w, r.score, { commits: r.count });
    }
    
    const edges = [...edgeMap.values()];
    const rank = this.pageRank(files.map(f => f.path), edges);
    const out = new Map(files.map(f => [f.path, []]));
    for (const e of edges) out.get(e.source)?.push(e);
    
    const next = {};
    for (const f of files) {
      const a = (out.get(f.path) ?? []).sort((x, y) => (y.weight * .7 + (rank[y.target] ?? 0) * .3) - (x.weight * .7 + (rank[x.target] ?? 0) * .3));
      next[f.path] = a[0]?.target ?? f.path;
    }
    
    const nodeToAttractor = {};
    for (const f of files) {
      let seen = [], cur = f.path;
      while (!seen.includes(cur) && seen.length <= files.length) {
        seen.push(cur);
        cur = next[cur] ?? cur;
      }
      const cycle = seen.slice(Math.max(0, seen.indexOf(cur)));
      cycle.sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0));
      nodeToAttractor[f.path] = cycle[0] ?? f.path;
    }
    
    const groups = {};
    for (const [n, a] of Object.entries(nodeToAttractor)) (groups[a] ??= []).push(n);
    
    return { edges, pageRank: rank, basins: { next, nodeToAttractor, groups } };
  }

  async doSearch(query, limit) {
    const q = this.tokenize(query);
    const lex = this.bm25(this._index.files, q);
    const qv = this.vector(query, this._index.config.vectorDimensions);
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const mem = await this.loadMemories();
    const affinity = new Map();
    for (const m of mem) {
      const hay = `${m.title} ${m.content}`.toLowerCase();
      const ov = q.filter(t => hay.includes(t)).length / Math.max(q.length, 1);
      if (ov) for (const f of m.files ?? []) affinity.set(f, Math.max(affinity.get(f) ?? 0, ov));
    }
    return this._index.files.map(f => {
      const semantic = Math.max(0, this.cosine(qv, f.vector));
      const exact = normalizedQuery && f.path.toLowerCase().includes(normalizedQuery) ? 1 : 0;
      const central = this._index.graph.pageRank[f.path] ?? 0;
      const memory = affinity.get(f.path) ?? 0;
      let bestChunk = null;
      let chunkMatch = 0;
      for (const chunk of f.chunks || []) {
        const haystack = chunk.text.toLowerCase();
        const overlap = q.filter(term => haystack.includes(term)).length / Math.max(1, q.length);
        const phrase = normalizedQuery && haystack.includes(normalizedQuery) ? 1 : 0;
        const candidate = Math.min(1, overlap * .82 + phrase * .18);
        if (candidate > chunkMatch) {
          chunkMatch = candidate;
          bestChunk = chunk;
        }
      }
      const score = Math.min(1, .32 * semantic + .25 * (lex[f.path] ?? 0) + .11 * exact + .08 * central + .08 * memory + .16 * chunkMatch);
      return {
        path: f.path,
        language: f.language,
        summary: f.summary,
        score,
        factors: { semantic, lexical: lex[f.path] ?? 0, exact, centrality: central, memory, chunk: chunkMatch },
        basin: this._index.graph.basins.nodeToAttractor[f.path],
        symbols: f.symbols.slice(0, 12),
        snippet: bestChunk && chunkMatch > 0 ? {
          startLine: bestChunk.startLine,
          endLine: bestChunk.endLine,
          text: sanitizeModelText(bestChunk.text, { maxCharacters: 1_200, maxLineCharacters: 600 }).text
        } : null
      };
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }

  async doContext(query, budget) {
    const results = await this.doSearch(query, Math.max(40, this._index.config.maxContextFiles * 4));
    const { out, inc } = this.adjacency();
    const map = new Map(this._index.files.map(f => [f.path, f]));
    const candidates = new Map(results.map(r => [r.path, { ...r, source: 'search' }]));
    
    for (const r of results.slice(0, 8)) {
      for (const e of [...(out.get(r.path) ?? []), ...(inc.get(r.path) ?? [])]) {
        const p = e.source === r.path ? e.target : e.source;
        const f = map.get(p);
        if (!f) continue;
        const score = r.score * .72 + e.weight * .28;
        const old = candidates.get(p);
        if (!old || score > old.score) candidates.set(p, { path: p, language: f.language, summary: f.summary, score, symbols: f.symbols.slice(0, 12), basin: this._index.graph.basins.nodeToAttractor[p], source: `graph:${e.type}` });
      }
    }
    
    const ordered = [...candidates.values()].sort((a, b) => b.score - a.score);
    const selected = [];
    let used = 100; // overhead estimate
    
    // L0: Always include top result (core attractor) if budget allows
    if (ordered.length > 0) {
      const l0 = ordered[0];
      const l0Tokens = this.estimateTokens(`${l0.path}\n${l0.summary}\n${l0.symbols.map(s => s.signature).join('\n')}\n${l0.snippet?.text || ''}`) + 45;
      if (used + l0Tokens <= budget) {
        selected.push({ ...l0, level: 'L0', estimatedTokens: l0Tokens });
        used += l0Tokens;
      }
    }
    
    // L1/L2: Include based on remaining budget and relevance
    for (const c of ordered.slice(1)) {
      if (selected.length >= this._index.config.maxContextFiles) break;
      const tokens = this.estimateTokens(`${c.path}\n${c.summary}\n${c.symbols.map(s => s.signature).join('\n')}\n${c.snippet?.text || ''}`) + 45;
      if (used + tokens > budget) continue;
      selected.push({ ...c, level: selected.length <= 3 ? 'L1' : 'L2', estimatedTokens: tokens });
      used += tokens;
    }
    
    if (!selected.length) {
      return { markdown: '', selected: [], usedTokens: used, budget };
    }
    
    const lines = ['# SupremeMind — Contexto Estrutural', '', `**Consulta:** ${query}`, `**Projeto:** ${this._index.projectName}`, `**Orçamento:** ${used}/${budget} tokens`, ''];
    
    const l0Items = selected.filter(s => s.level === 'L0');
    const l1Items = selected.filter(s => s.level === 'L1');
    const l2Items = selected.filter(s => s.level === 'L2');
    
    if (l0Items.length > 0) {
      lines.push('## L0 — Core Attractor', '', `### \`${l0Items[0].path}\``, '', l0Items[0].summary, '');
    }
    
    if (l0Items[0]?.snippet?.text) {
      lines.push(`**Trecho L${l0Items[0].snippet.startLine}-L${l0Items[0].snippet.endLine}:**`, '', '```text', l0Items[0].snippet.text, '```', '');
    }

    if (l1Items.length > 0 || l2Items.length > 0) {
      lines.push('## L1/L2 — Arquivos prioritários', '');
      for (const [i, c] of selected.entries()) {
        if (i === 0 && l0Items.length > 0) continue; // skip L0 in this list
        lines.push(`### ${i + (l0Items.length > 0 ? 1 : 0)}. \`${c.path}\``, '', `- Relevância: **${(c.score * 100).toFixed(1)}%**`, `- Nível: \`${c.level}\``, `- Origem: \`${c.source}\``, `- Bacia: \`${c.basin}\``, `- Tokens: ${c.estimatedTokens}`, '', c.summary, '');
        if (c.snippet?.text) lines.push(`- **Trecho L${c.snippet.startLine}-L${c.snippet.endLine}:**`, '', '```text', c.snippet.text, '```', '');
        const o = (out.get(c.path) ?? []).slice(0, 5);
        const n = (inc.get(c.path) ?? []).slice(0, 5);
        if (o.length) lines.push(`- **Saídas:** ${o.map(e => `\`${e.target}\` (${e.type})`).join(', ')}`);
        if (n.length) lines.push(`- **Entradas:** ${n.map(e => `\`${e.source}\` (${e.type})`).join(', ')}`);
        lines.push('');
      }
    }
    
    lines.push('## Orientação', '', '1. Comece pelo L0 e pelos primeiros arquivos L1/L2 — eles concentram a lógica central.', '2. Use as saídas/entradas para navegar fluxos de chamada e dependências.', '3. Bacias de atração agrupam arquivos que tendem a mudar juntos.', '4. Se o orçamento apertar, priorize L0 + primeiros L1.', '');
    
    return { markdown: lines.join('\n'), selected, usedTokens: used, budget };
  }

  doImpact(target, depth) {
    const { inc } = this.adjacency();
    if (!inc.has(target)) {
      return { target, risk: 'LOW', score: 0, direct: 0, indirect: 0, impacted: [], error: 'Arquivo não encontrado no índice.' };
    }
    const seen = new Set([target]);
    const queue = [{ path: target, depth: 0, weight: 1 }];
    const items = [];
    
    while (queue.length) {
      const c = queue.shift();
      if (c.depth >= depth) continue;
      for (const e of inc.get(c.path) ?? []) {
        if (seen.has(e.source)) continue;
        seen.add(e.source);
        const weight = c.weight * e.weight;
        const x = { path: e.source, depth: c.depth + 1, via: c.path, type: e.type, weight };
        items.push(x);
        queue.push(x);
      }
    }
    
    items.sort((a, b) => b.weight - a.weight);
    const direct = items.filter(x => x.depth === 1).length;
    const score = Math.min(100, direct * 9 + (items.length - direct) * 3 + (this._index.graph.pageRank[target] ?? 0) * 45);
    const risk = score >= 70 ? 'CRITICAL' : score >= 45 ? 'HIGH' : score >= 20 ? 'MODERATE' : 'LOW';
    return { target, risk, score: Number(score.toFixed(2)), direct, indirect: items.length - direct, impacted: items };
  }

  doOrbit(target, depth) {
    const { out, inc } = this.adjacency();
    if (!inc.has(target) && !out.has(target)) {
      return { target, attractor: target, outgoing: [], incoming: [], levels: [{ depth: 0, nodes: [target] }], error: 'Arquivo não encontrado no índice.' };
    }
    const visited = new Set([target]);
    const levels = [{ depth: 0, nodes: [target] }];
    let frontier = [target];
    
    for (let d = 1; d <= depth; d++) {
      if (!frontier.length) break;
      const next = [];
      for (const n of frontier) {
        for (const e of [...(out.get(n) ?? []), ...(inc.get(n) ?? [])]) {
          const p = e.source === n ? e.target : e.source;
          if (!visited.has(p)) {
            visited.add(p);
            next.push(p);
          }
        }
      }
      levels.push({ depth: d, nodes: next.sort() });
      frontier = next;
    }
    
    return {
      target,
      attractor: this._index.graph.basins.nodeToAttractor[target] ?? target,
      outgoing: (out.get(target) ?? []).sort((a, b) => b.weight - a.weight),
      incoming: (inc.get(target) ?? []).sort((a, b) => b.weight - a.weight),
      levels
    };
  }

  adjacency() {
    const out = new Map(this._index.files.map(f => [f.path, []]));
    const inc = new Map(this._index.files.map(f => [f.path, []]));
    for (const e of this._index.graph.edges) {
      out.get(e.source)?.push(e);
      inc.get(e.target)?.push(e);
    }
    return { out, inc };
  }

  async loadMemories() {
    try {
      const lines = (await fs.readFile(path.join(this.projectRoot, STATE_DIR, 'memories.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean);
      const memories = [];
      for (const line of lines.slice(-5_000)) {
        try {
          const parsed = JSON.parse(line);
          const safe = safeMemoryData(parsed);
          memories.push({
            id: /^memory:[a-f0-9]{24}$/i.test(String(parsed?.id || '')) ? parsed.id : this.id('memory', line),
            ...safe,
            createdAt: Number.isFinite(Date.parse(parsed?.createdAt)) ? new Date(parsed.createdAt).toISOString() : null
          });
        } catch { /* ignora apenas a linha parcial ou inválida */ }
      }
      return memories;
    } catch { return []; }
  }

  async saveIndex() {
    await fs.mkdir(path.join(this.projectRoot, STATE_DIR), { recursive: true });
    const file = path.join(this.projectRoot, STATE_DIR, 'index.json');
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this._index));
    await fs.rename(tmp, file);
  }

  // --- Utility functions ---
  
  norm(p) { return p.split(path.sep).join('/').replace(/^\.\//, ''); }
  sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
  id(kind, value) { return `${kind}:${this.sha(value).slice(0, 24)}`; }
  estimateTokens(text) { return Math.max(1, Math.ceil(Math.max(String(text).length / 4, String(text).trim().split(/\s+/).filter(Boolean).length * 1.25))); }
  tokenize(text) { return String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z_][a-z0-9_]{1,}|[0-9]{2,}/g)?.filter(x => !STOP.has(x)) ?? []; }
  fnv(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
  vector(text, dims) {
    const out = Array(dims).fill(0);
    const features = [];
    for (const term of this.tokenize(text)) {
      features.push(term);
      if (term.length >= 4) for (let i = 0; i <= term.length - 3; i++) features.push(`#${term.slice(i, i + 3)}`);
    }
    for (const feature of features) {
      const h = this.fnv(feature);
      out[h % dims] += (h & 0x80000000) ? -1 : 1;
    }
    const n = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
    return n ? out.map(v => v / n) : out;
  }
  cosine(a, b) { if (!a || !b || a.length !== b.length) return 0; let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / Math.sqrt(na * nb) : 0; }
  lineAt(text, index) { return text.slice(0, index).split('\n').length; }
  matches(text, regex, mapper) { const out = []; for (const m of text.matchAll(regex)) { const v = mapper(m, this.lineAt(text, m.index ?? 0)); if (v) out.push(v); } return out; }
  unique(values) { return [...new Set(values)]; }
  language(file) {
    const ext = path.extname(file).toLowerCase();
    if (['.c', '.h', '.hh', '.hpp', '.cpp', '.cc', '.cxx'].includes(ext)) return 'cpp';
    if (ext === '.cs') return 'csharp';
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
    if (['.ts', '.tsx'].includes(ext)) return 'typescript';
    if (ext === '.py') return 'python';
    if (['.json', '.jsonc'].includes(ext)) return 'json';
    if (['.html', '.htm', '.xhtml'].includes(ext)) return 'html';
    if (['.css', '.scss', '.sass', '.less'].includes(ext)) return 'css';
    if (['.yaml', '.yml'].includes(ext)) return 'yaml';
    if (['.toml', '.ini', '.cfg'].includes(ext)) return 'config';
    if (['.md', '.txt'].includes(ext)) return 'text';
    if (['.xml', '.csproj', '.vcxproj'].includes(ext)) return 'xml';
    return 'text';
  }
  resolveImport(source, spec, byPath, byBase) {
    const clean = spec.replaceAll('\\', '/');
    const dir = path.posix.dirname(source);
    const exts = ['', '.js', '.jsx', '.ts', '.tsx', '.py', '.h', '.hpp', '.c', '.cpp', '.cs', '.json', '.html', '.htm', '.css', '.scss', '.yaml', '.yml'];
    const c = [];
    if (clean.startsWith('.')) {
      const b = this.norm(path.posix.normalize(path.posix.join(dir, clean)));
      for (const x of exts) c.push(b + x);
      for (const x of exts.slice(1)) c.push(`${b}/index${x}`);
    } else {
      c.push(clean, clean.replaceAll('.', '/'));
      const list = byBase.get(path.posix.basename(clean));
      if (list?.length === 1) return list[0];
    }
    return c.find(x => byPath.has(x)) ?? null;
  }
  pageRank(nodes, edges) {
    const n = Math.max(nodes.length, 1);
    const rank = Object.fromEntries(nodes.map(x => [x, 1 / n]));
    const out = new Map(nodes.map(x => [x, []]));
    for (const e of edges) out.get(e.source)?.push(e);
    for (let k = 0; k < 24; k++) {
      const next = Object.fromEntries(nodes.map(x => [x, .15 / n]));
      let sink = 0;
      for (const x of nodes) {
        const links = out.get(x) ?? [];
        if (!links.length) { sink += rank[x]; continue; }
        const sum = links.reduce((s, e) => s + e.weight, 0) || 1;
        for (const e of links) if (next[e.target] !== undefined) next[e.target] += .85 * rank[x] * e.weight / sum;
      }
      for (const x of nodes) rank[x] = next[x] + .85 * sink / n;
    }
    const max = Math.max(...Object.values(rank), 1e-12);
    for (const x of nodes) rank[x] /= max;
    return rank;
  }
  bm25(files, q) {
    const avg = files.reduce((s, f) => s + f.termCount, 0) / Math.max(files.length, 1) || 1;
    const df = {};
    for (const t of new Set(q)) df[t] = files.reduce((s, f) => s + (f.terms[t] ? 1 : 0), 0);
    const out = {};
    for (const f of files) {
      let score = 0;
      for (const t of q) {
        const tf = f.terms[t] ?? 0;
        if (!tf) continue;
        const idf = Math.log(1 + (files.length - df[t] + .5) / (df[t] + .5));
        score += idf * (tf * 2.5) / (tf + 1.5 * (1 - .75 + .75 * f.termCount / avg));
      }
      out[f.path] = score;
    }
    const max = Math.max(...Object.values(out), 0);
    if (max) for (const k in out) out[k] /= max;
    return out;
  }
}

const DEFAULT_CONFIG = {
  version: 1,
  projectName: null,
  maxFileSize: 2500000,
  vectorDimensions: 128,
  tokenBudget: 6000,
  maxContextFiles: 15,
  gitCommitLimit: 500,
  ignore: ['.git', '.genesis', '.suprememind', '.idea', '.vscode', '.venv', 'venv', '__pycache__', 'node_modules', 'vendor', 'third_party', 'dist', 'build', 'bin', 'obj', 'Library', 'Temp', 'coverage']
};

const STOP = new Set('a ao aos as com como da das de do dos e em entre essa esse esta este eu isso isto já mais mas me meu minha na nas no nos o os ou para pela pelo por porque que se sem ser seu sua um uma você the and or of to in for on is are with from this that return const let var public private protected static void'.split(' '));
const CALL_SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'return', 'new', 'delete', 'typeof', 'function', 'require', 'import', 'export', 'super', 'this', 'class', 'def', 'print']);
