import { recoverRequiredProjectToolCall as recoverSingleToolCall } from './direct-tool-recovery.js';

const TOOL_ALIASES = Object.freeze({
  read_file: 'read_project_file',
  read_project_file: 'read_project_file',
  search_file: 'search_project',
  search_project: 'search_project',
  write_file: 'write_project_file',
  write_project_file: 'write_project_file',
  write_files: 'write_project_files',
  write_project_files: 'write_project_files',
  replace_text: 'replace_project_text',
  replace_project_text: 'replace_project_text',
  create_directory: 'create_project_directory',
  create_project_directory: 'create_project_directory',
  move_path: 'move_project_path',
  move_project_path: 'move_project_path',
  delete_path: 'delete_project_path',
  delete_project_path: 'delete_project_path',
  run_check: 'run_project_check',
  run_project_check: 'run_project_check'
});

function stripFence(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
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

function normalizedName(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return TOOL_ALIASES[raw] || raw;
}

function invocationFromContent(content) {
  const parsed = parseObject(stripFence(content));
  if (!parsed) return null;
  const name = normalizedName(parsed.tool || parsed.command || parsed.name || parsed.function?.name);
  if (!name) return null;

  let args = parsed.arguments ?? parsed.args ?? parsed.function?.arguments;
  if (typeof args === 'string') args = parseObject(args);
  if (args === undefined) {
    const { tool, command, name: _name, function: _function, ...flatArgs } = parsed;
    args = flatArgs;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, args };
}

function validBatchFiles(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 16
    && value.every(file => file && typeof file === 'object' && !Array.isArray(file)
      && typeof file.path === 'string' && file.path.trim()
      && typeof file.content === 'string');
}

function likelyCollapsedNewlines(path, content) {
  const source = String(content || '');
  if (source.length < 160 || /\r|\n/.test(source)) return false;
  const leaf = String(path || '').toLowerCase().split('/').pop() || '';
  const extension = leaf.includes('.') ? leaf.split('.').pop() : '';

  if (['html', 'htm'].includes(extension)) {
    const structural = source.match(/n(?=\s*<(?:!doctype|html|head|body|main|section|div|p|button|script|link|meta|title|footer|header|\/))/gi) || [];
    return structural.length >= 3;
  }
  if (extension === 'css') {
    const structural = source.match(/(?:\}|;|\*\/|\{)n(?=\s*(?:[.#@*a-z-]|$))/gi) || [];
    return structural.length >= 3;
  }
  if (['js', 'mjs', 'cjs', 'ts'].includes(extension)) {
    if (/^\s*\/\//.test(source) && source.length >= 240) return true;
    const structural = source.match(/(?:;|\}|\])n(?=\s*(?:const|let|var|function|class|document|window|async|\/\/|\/\*))/g) || [];
    return structural.length >= 2;
  }
  return false;
}

function malformedBatchFiles(files) {
  if (!validBatchFiles(files)) return [];
  return files.filter(file => likelyCollapsedNewlines(file.path, file.content)).map(file => file.path);
}

function validArguments(name, args) {
  if (name === 'write_project_file') return typeof args.path === 'string' && typeof args.content === 'string';
  if (name === 'write_project_files') return validBatchFiles(args.files);
  if (name === 'replace_project_text') {
    return typeof args.path === 'string'
      && typeof args.old_text === 'string'
      && args.old_text.length > 0
      && typeof args.new_text === 'string';
  }
  if (name === 'create_project_directory' || name === 'delete_project_path' || name === 'read_project_file') {
    return typeof args.path === 'string';
  }
  if (name === 'move_project_path') return typeof args.from === 'string' && typeof args.to === 'string';
  if (name === 'search_project') return typeof args.query === 'string';
  if (name === 'run_project_check') return typeof args.check === 'string';
  return false;
}

function recoveredToolCall(name, args, recovery) {
  return {
    id: `genesis-command-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
    genesisRecovery: recovery
  };
}

function withRecoveredCall(result, call, recovery) {
  return {
    ...result,
    content: '',
    toolCalls: [call],
    finishReason: 'tool_calls',
    toolRecovery: recovery
  };
}

export function recoverRequiredProjectToolCall({ result, tools = [], messages = [] } = {}) {
  if (result?.toolCalls?.length) return result;

  const allowed = new Set(tools.map(toolName).filter(Boolean));
  const invocation = invocationFromContent(result?.content);
  if (invocation) {
    const { name, args } = invocation;

    if (name === 'write_project_files' && allowed.has(name) && validBatchFiles(args.files)) {
      const malformed = malformedBatchFiles(args.files);
      if (malformed.length) {
        return {
          ...result,
          toolCalls: [],
          finishReason: 'stop',
          toolRecovery: 'rejected-collapsed-newlines',
          toolRecoveryRejected: `Conteúdo inválido em ${malformed.join(', ')}: as quebras de linha parecem ter sido convertidas em caracteres “n”. Gere novamente com quebras de linha reais.`
        };
      }
    }

    // Alguns modelos gratuitos representam "escrever em arquivo vazio" como
    // replace_project_text com old_text vazio. Essa chamada é inválida pela API de
    // substituição, mas é semanticamente uma gravação completa segura quando a fase
    // já expôs write_project_file. Convertemos sem executar texto arbitrário.
    if (
      name === 'replace_project_text'
      && args.old_text === ''
      && allowed.has('write_project_file')
      && typeof args.path === 'string'
      && typeof args.new_text === 'string'
    ) {
      const call = recoveredToolCall(
        'write_project_file',
        { path: args.path, content: args.new_text },
        'empty-replace-as-write'
      );
      return withRecoveredCall(result, call, 'empty-replace-as-write');
    }

    if (allowed.has(name) && validArguments(name, args)) {
      const call = recoveredToolCall(name, args, 'declared-command-json');
      return withRecoveredCall(result, call, 'declared-command-json');
    }
  }

  return recoverSingleToolCall({ result, tools, messages });
}
