function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

function normalizePath(value) {
  return String(value || '').trim().replace(/^['"`]+|['"`.,;:!?]+$/g, '').replace(/\\/g, '/');
}

function pathCandidates(value) {
  const text = String(value || '');
  const matches = [];
  const patterns = [
    /[`"']([^`"'\r\n]+\.[a-z0-9]{1,12})[`"']/gi,
    /(?:^|\s)([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*\.[a-z0-9]{1,12})(?=$|[\s,.;:!?])/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizePath(match[1]);
      if (!candidate || /^https?:\/\//i.test(candidate) || candidate.includes('..')) continue;
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

export function inferProjectTargetPath(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const candidates = pathCandidates(textContent(messages[index].content));
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

function argumentsFromJson(content, name) {
  const source = stripSingleFence(content);
  const parsed = jsonObject(source);
  if (!parsed) return null;

  const declaredName = String(parsed.tool || parsed.name || parsed.function?.name || '').trim();
  if (declaredName && declaredName !== name) return null;
  const args = parsed.arguments ?? parsed.args ?? parsed.function?.arguments ?? parsed;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

  if (name === 'write_project_file' && typeof args.path === 'string' && typeof args.content === 'string') return args;
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

function looksLikeFileContent(content, path) {
  const text = String(content || '').trim();
  if (!text) return false;
  const extension = String(path || '').toLowerCase().split('.').pop();
  if (['html', 'htm'].includes(extension)) return looksLikeHtml(text);
  if (extension === 'css') return looksLikeCss(text);
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(extension)) return looksLikeScript(text);
  if (extension === 'py') return looksLikePython(text);
  if (extension === 'json') return jsonObject(text) !== null;
  if (['md', 'markdown'].includes(extension)) return /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|```|>\s)/m.test(text);
  if (['xml', 'svg'].includes(extension)) return /^\s*<\??[a-z]/i.test(text);
  if (['txt', 'csv', 'yml', 'yaml', 'toml', 'ini', 'env'].includes(extension)) return false;
  return false;
}

function recoveredWriteCall(content, messages) {
  const path = inferProjectTargetPath(messages);
  if (!path) return null;

  const exact = stripSingleFence(content);
  if (looksLikeFileContent(exact, path)) {
    return toolCall('write_project_file', { path, content: exact }, 'raw-file-content');
  }

  const fenced = extractOnlyFence(content);
  if (fenced && looksLikeFileContent(fenced, path)) {
    return toolCall('write_project_file', { path, content: fenced }, 'fenced-file-content');
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
    const path = inferProjectTargetPath(messages);
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
