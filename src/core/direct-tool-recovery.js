function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

function normalizePath(value) {
  return String(value || '').trim().replace(/^['"`]+|['"`.,;:!?]+$/g, '').replace(/\\/g, '/');
}

const SPECIAL_FILE_NAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'license', 'readme', 'changelog',
  '.gitignore', '.dockerignore', '.env', '.npmrc', '.editorconfig'
]);
const STATIC_WEB_SERVICE = /\b(?:pagina|site|landing page|dashboard)\b/;
const SINGLE_FILE_WEB_REQUEST = /\b(?:arquivo unico|single file|somente um arquivo|apenas um arquivo|html unico|tudo (?:em|no) index\.html|somente index\.html|apenas index\.html)\b/;

function validRelativePath(candidate) {
  const value = normalizePath(candidate);
  if (!value || /^https?:\/\//i.test(value) || value.includes('..') || pathIsAbsolute(value)) return '';
  return value;
}

function pathIsAbsolute(value) {
  return /^\/?[a-z]:\//i.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function filePathCandidates(value) {
  const text = String(value || '');
  const matches = [];
  const patterns = [
    /[`"']([^`"'\r\n]+\.[a-z0-9]{1,12})[`"']/gi,
    /(?:^|\s)([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*\.[a-z0-9]{1,12})(?=$|[\s,.;:!?])/gi,
    /(?:^|[\s`"'])(Dockerfile|Makefile|Procfile|LICENSE|README|CHANGELOG|\.gitignore|\.dockerignore|\.env|\.npmrc|\.editorconfig)(?=$|[\s`"',.;:!?])/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = validRelativePath(match[1]);
      if (!candidate) continue;
      const leaf = candidate.toLowerCase().split('/').pop();
      if (!leaf.includes('.') && !SPECIAL_FILE_NAMES.has(leaf)) continue;
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

function directoryPathCandidates(value) {
  const text = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const matches = [];
  const patterns = [
    /\b(?:pasta|diretorio|folder|directory)\s+(?:chamad[ao]\s+|named\s+)?[`"']?([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*)[`"']?/gi,
    /\b(?:crie|criar|create)\s+[`"']([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*)\/[`"']/gi
  ];
  const ignored = new Set(['do', 'da', 'de', 'no', 'na', 'projeto', 'project', 'nova', 'novo', 'new']);
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = validRelativePath(match[1]);
      if (!candidate || ignored.has(candidate.toLowerCase())) continue;
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

export function inferProjectTargetPath(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const candidates = filePathCandidates(textContent(messages[index].content));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return '';
  }
  return '';
}

export function inferProjectDirectoryPath(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const candidates = directoryPathCandidates(textContent(messages[index].content));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return '';
  }
  return '';
}

function stripSingleFence(value) {
  const text = String(value || '').trim();
  const match = text.match(/^```[a-z0-9_+.#-]*\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : text;
}

function extractOnlyFence(value) {
  const text = String(value || '').trim();
  const matches = [...text.matchAll(/```[a-z0-9_+.#-]*\s*\n?([\s\S]*?)\n?```/gi)];
  if (matches.length !== 1) return '';
  const outside = `${text.slice(0, matches[0].index)}${text.slice((matches[0].index || 0) + matches[0][0].length)}`.trim();
  if (outside.length > 240) return '';
  return String(matches[0][1] || '').trim();
}

function codeFences(value) {
  const text = String(value || '');
  return [...text.matchAll(/```([a-z0-9_+.#-]*)\s*\n?([\s\S]*?)\n?```/gi)]
    .map(match => ({ language: String(match[1] || '').toLowerCase(), content: String(match[2] || '').trim() }))
    .filter(item => item.content);
}

function jsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolName(tool) {
  return String(tool?.function?.name || '');
}

function toolCall(name, args, recovery) {
  return {
    id: `genesis-recovered-tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args || {}) },
    genesisRecovery: recovery
  };
}

function validBatchFiles(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 16
    && value.every(file => file && typeof file === 'object' && !Array.isArray(file)
      && typeof file.path === 'string' && file.path.trim()
      && typeof file.content === 'string');
}

function argumentsFromJson(content, name) {
  const source = stripSingleFence(content);
  const parsed = jsonObject(source);
  if (!parsed) return null;

  const declaredName = String(parsed.tool || parsed.command || parsed.name || parsed.function?.name || '').trim();
  if (declaredName && declaredName !== name) return null;
  const args = parsed.arguments ?? parsed.args ?? parsed.function?.arguments ?? parsed;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

  if (name === 'write_project_file' && typeof args.path === 'string' && typeof args.content === 'string') return args;
  if (name === 'write_project_files' && validBatchFiles(args.files)) return { files: args.files };
  if (name === 'create_project_directory' && typeof args.path === 'string') return { path: args.path };
  if (name === 'read_project_file' && typeof args.path === 'string') return args;
  if (name === 'search_project' && typeof args.query === 'string') return args;
  if (name === 'run_project_check' && typeof args.check === 'string') return args;
  return null;
}

function looksLikeHtml(value) {
  return /<!doctype\s+html|<html\b|<head\b|<body\b/i.test(value);
}

function looksLikeCss(value) {
  return /(?:^|\n)\s*(?::root\b|@(?:charset|import|media|supports)\b|[.#a-z][^\n{]{0,120}\{)/i.test(value);
}

function looksLikeScript(value) {
  return /(?:^|\n)\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|async\s+function|\/\/|\/\*)/m.test(value);
}

function looksLikePython(value) {
  return /(?:^|\n)\s*(?:from\s+\S+\s+import\s|import\s+\S+|def\s+\w+\s*\(|class\s+\w+|if\s+__name__\s*==|#\s)/m.test(value);
}

function looksLikePhp(value) {
  return /<\?php\b|(?:^|\n)\s*(?:namespace\s+|use\s+\S+;|class\s+\w+)/m.test(value);
}

function looksLikeGo(value) {
  return /(?:^|\n)\s*package\s+\w+|(?:^|\n)\s*func\s+\w+\s*\(/m.test(value);
}

function looksLikeRust(value) {
  return /(?:^|\n)\s*(?:use\s+\S+;|fn\s+\w+\s*\(|pub\s+(?:fn|struct|enum|mod)\b)/m.test(value);
}

function looksLikeFileContent(content, path) {
  const text = String(content || '').trim();
  if (!text) return false;
  const leaf = String(path || '').toLowerCase().split('/').pop();
  const extension = leaf.includes('.') ? leaf.split('.').pop() : '';
  if (['html', 'htm'].includes(extension)) return looksLikeHtml(text);
  if (extension === 'css') return looksLikeCss(text);
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(extension)) return looksLikeScript(text);
  if (extension === 'py') return looksLikePython(text);
  if (extension === 'php') return looksLikePhp(text);
  if (extension === 'go') return looksLikeGo(text);
  if (extension === 'rs') return looksLikeRust(text);
  if (['c', 'h', 'cc', 'cpp', 'hpp', 'java', 'kt', 'kts', 'cs'].includes(extension)) {
    return /(?:^|\n)\s*(?:#include\b|package\s+|import\s+|public\s+class\b|class\s+\w+|using\s+\S+;)/m.test(text);
  }
  if (['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'].includes(extension)) {
    return /^(?:#!|@echo\s+off|param\s*\(|Set-StrictMode\b|\$ErrorActionPreference\b)/i.test(text);
  }
  if (['sql'].includes(extension)) return /\b(?:select|create|alter|insert|update|delete|with)\b/i.test(text);
  if (extension === 'json') return jsonObject(text) !== null;
  if (['md', 'markdown'].includes(extension)) return /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|```|>\s)/m.test(text);
  if (['xml', 'svg'].includes(extension)) return /^\s*<\??[a-z]/i.test(text);
  if (SPECIAL_FILE_NAMES.has(leaf)) return text.length > 0 && !/^claro[,.!\s]|^vou\s|^aqui\s+est[aá]/i.test(text);
  return false;
}

function requestedArtifactExtensions(messages = []) {
  const patterns = [
    ['html', /(?:^|[^a-z0-9])(?:html|\.html)(?=$|[^a-z0-9])/i],
    ['css', /(?:^|[^a-z0-9])(?:css|\.css)(?=$|[^a-z0-9])/i],
    ['js', /(?:^|[^a-z0-9])(?:javascript|java script|js|\.js)(?=$|[^a-z0-9])/i],
    ['ts', /(?:^|[^a-z0-9])(?:typescript|ts|\.ts)(?=$|[^a-z0-9])/i],
    ['py', /(?:^|[^a-z0-9])(?:python|py|\.py)(?=$|[^a-z0-9])/i],
    ['php', /(?:^|[^a-z0-9])(?:php|\.php)(?=$|[^a-z0-9])/i]
  ];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const raw = textContent(messages[index].content);
    const text = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const extensions = patterns.filter(([, pattern]) => pattern.test(text)).map(([extension]) => extension);
    if (STATIC_WEB_SERVICE.test(text)) {
      if (SINGLE_FILE_WEB_REQUEST.test(text)) {
        const explicit = filePathCandidates(raw)
          .map(candidate => candidate.toLowerCase().split('/').pop() || '')
          .map(leaf => leaf.includes('.') ? leaf.split('.').pop() : '')
          .filter(extension => patterns.some(([known]) => known === extension));
        return [...new Set(explicit.length ? explicit : ['html'])];
      }
      return [...new Set(['html', 'css', 'js', ...extensions])];
    }
    if (extensions.length) return extensions;
  }
  return [];
}

function defaultPathForExtension(extension) {
  return {
    html: 'index.html',
    css: 'styles.css',
    js: 'script.js',
    ts: 'app.ts',
    py: 'app.py',
    php: 'index.php'
  }[extension] || '';
}

function fenceExtension(fence) {
  const language = String(fence?.language || '').toLowerCase();

  // Rótulos explícitos de fenced code são mais confiáveis que heurísticas de
  // conteúdo. JavaScript com callbacks contém `{` e pode parecer CSS para um
  // detector estrutural; respeitar primeiro `javascript`/`js` evita perder o
  // script em entregas HTML + CSS + JS.
  if (['html', 'htm'].includes(language)) return 'html';
  if (language === 'css') return 'css';
  if (['javascript', 'js', 'mjs', 'cjs'].includes(language)) return 'js';
  if (['typescript', 'ts'].includes(language)) return 'ts';
  if (['python', 'py'].includes(language)) return 'py';
  if (language === 'php') return 'php';

  if (looksLikeHtml(fence?.content)) return 'html';
  if (looksLikeScript(fence?.content)) return 'js';
  if (looksLikeCss(fence?.content)) return 'css';
  if (looksLikePython(fence?.content)) return 'py';
  if (looksLikePhp(fence?.content)) return 'php';
  return '';
}

function recoveredBatchWriteCall(content, messages) {
  const fences = codeFences(content);
  if (!fences.length) return null;
  const requested = requestedArtifactExtensions(messages);
  const byExtension = new Map();
  for (const fence of fences) {
    const extension = fenceExtension(fence);
    if (!extension || byExtension.has(extension)) continue;
    const path = defaultPathForExtension(extension);
    if (!path || !looksLikeFileContent(fence.content, path)) continue;
    byExtension.set(extension, fence.content);
  }

  const extensions = requested.length ? requested : [...byExtension.keys()];
  if (!extensions.length || extensions.some(extension => !byExtension.has(extension))) return null;
  const files = extensions.map(extension => ({
    path: defaultPathForExtension(extension),
    content: byExtension.get(extension)
  })).filter(file => file.path && file.content);
  if (!files.length) return null;
  return toolCall('write_project_files', { files }, 'multi-fence-service-files');
}

function recoveredWriteCall(content, messages) {
  const path = inferProjectTargetPath(messages);
  if (!path) return null;

  // Se houver exatamente um bloco de código, ele tem precedência. Isso impede que
  // frases como "Arquivo completo:" ou as próprias crases sejam gravadas no disco.
  const fenced = extractOnlyFence(content);
  if (fenced && looksLikeFileContent(fenced, path)) {
    return toolCall('write_project_file', { path, content: fenced }, 'fenced-file-content');
  }

  const exact = stripSingleFence(content);
  if (!exact.includes('```') && looksLikeFileContent(exact, path)) {
    return toolCall('write_project_file', { path, content: exact }, 'raw-file-content');
  }
  return null;
}

export function recoverRequiredProjectToolCall({ result, tools = [], messages = [] } = {}) {
  if (result?.toolCalls?.length || tools.length !== 1) return result;
  const name = toolName(tools[0]);
  if (!name) return result;

  const fromJson = argumentsFromJson(result?.content, name);
  if (fromJson) {
    return {
      ...result,
      content: '',
      toolCalls: [toolCall(name, fromJson, 'single-tool-json')],
      finishReason: 'tool_calls',
      toolRecovery: 'single-tool-json'
    };
  }

  if (name === 'create_project_directory') {
    const path = inferProjectDirectoryPath(messages);
    if (path) {
      return {
        ...result,
        content: '',
        toolCalls: [toolCall(name, { path }, 'deterministic-directory-path')],
        finishReason: 'tool_calls',
        toolRecovery: 'deterministic-directory-path'
      };
    }
  }

  if (name === 'write_project_files') {
    const recovered = recoveredBatchWriteCall(result?.content, messages);
    if (recovered) {
      return {
        ...result,
        content: '',
        toolCalls: [recovered],
        finishReason: 'tool_calls',
        toolRecovery: recovered.genesisRecovery
      };
    }
  }

  if (name === 'write_project_file') {
    const recovered = recoveredWriteCall(result?.content, messages);
    if (recovered) {
      return {
        ...result,
        content: '',
        toolCalls: [recovered],
        finishReason: 'tool_calls',
        toolRecovery: recovered.genesisRecovery
      };
    }
  }

  return result;
}
