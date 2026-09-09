import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { ResilientOpenRouterProvider } from './resilient-openrouter-provider.js';
import { ProviderError } from '../core/errors.js';
import { recoverRequiredProjectToolCall } from '../core/project-tool-command-recovery.js';
import {
  allowParallelProjectToolCalls,
  isProjectMutationTool,
  isProjectReadTool,
  preferredProjectMutationTools,
  projectMutationNeedsExploration,
  projectToolCallRequired,
  projectToolChoice,
  projectToolPhase
} from '../core/project-tool-policy.js';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

function taskFingerprint(messages) {
  const dialogue = messages.filter(message => ['user', 'assistant'].includes(message.role));
  const latestUserIndex = dialogue.map(message => message.role).lastIndexOf('user');
  const latestUser = latestUserIndex >= 0 ? textContent(dialogue[latestUserIndex].content) : '';
  const previous = latestUserIndex > 0 ? textContent(dialogue[latestUserIndex - 1].content) : '';
  return `${latestUser.slice(0, 4000)}\nPREVIOUS:${previous.slice(-2000)}`;
}

function fingerprintId(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function successfulReadEvidence(messages = []) {
  let count = 0;
  for (const message of messages) {
    if (message?.role !== 'tool' || !isProjectReadTool(message?.name)) continue;
    let result = null;
    try { result = JSON.parse(String(message.content || '{}')); } catch { /* resultado compacto inválido não conta */ }
    if (result?.ok !== true) continue;
    if (message.name === 'search_project' && Array.isArray(result.matches) && result.matches.length === 0) continue;
    count += 1;
  }
  return count;
}

function emptyFileReadPath(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'tool' || message?.name !== 'read_project_file') continue;
    let result = null;
    try { result = JSON.parse(String(message.content || '{}')); } catch { continue; }
    if (result?.ok !== true || typeof result.content !== 'string') continue;
    const startsAtBeginning = result.startLine === 1 || result.startCharacter === 0;
    const noContinuation = result.nextStartLine == null && result.nextStartCharacter == null;
    if (startsAtBeginning && noContinuation && result.truncated !== true && result.content === '') {
      return String(result.path || '');
    }
  }
  return '';
}

function hasToolAttempt(messages = [], name = '') {
  return messages.some(message => message?.role === 'tool' && message?.name === name);
}

function latestUserRequest(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return textContent(messages[index].content);
  }
  return '';
}

export function agenticToolsForMessages(tools = [], messages = []) {
  const suppliedPhase = projectToolPhase(tools);

  // Uma verificação que já foi executada não deve ser chamada em loop só porque
  // test/lint/build retornou erro. A evidência da tentativa permanece no contexto;
  // a rodada seguinte sintetiza a limitação sem repetir o mesmo comando.
  if (suppliedPhase === 'verification' && hasToolAttempt(messages, 'run_project_check')) return [];
  if (suppliedPhase !== 'mixed') return tools;

  const evidence = successfulReadEvidence(messages);
  const objective = latestUserRequest(messages);

  // Criar um arquivo/pasta novo não depende de encontrar conteúdo preexistente.
  // Forçar search_project aqui criava um deadlock: busca vazia -> zero evidência ->
  // nova busca até esgotar o orçamento. Nesses pedidos a primeira ação já é escrita.
  if (evidence === 0 && objective && !projectMutationNeedsExploration(objective)) {
    const mutations = preferredProjectMutationTools(tools, { objective, hasReadEvidence: false });
    return mutations.length ? mutations : tools;
  }

  if (evidence === 0) {
    // Edições de conteúdo existente continuam search/read-first para preservar código
    // não relacionado e evitar reescritas destrutivas.
    const reads = tools.filter(tool => isProjectReadTool(tool));
    return reads.length ? reads : tools;
  }

  // Uma leitura integral que confirma arquivo vazio já fornece todo o contexto
  // necessário. Forçar replace_project_text nesse ponto é impossível porque a
  // substituição exige old_text não vazio; a ação correta e econômica é gravação.
  if (emptyFileReadPath(messages)) {
    const writes = tools.filter(tool => tool?.function?.name === 'write_project_file');
    if (writes.length) return writes;
  }

  if (evidence < 2) return tools;
  const mutations = preferredProjectMutationTools(tools, {
    objective,
    hasReadEvidence: true
  });
  return mutations.length ? mutations : tools;
}

export function projectToolActionRequired(suppliedTools = [], effectiveTools = suppliedTools) {
  return projectToolPhase(suppliedTools) === 'mixed' || projectToolCallRequired(effectiveTools);
}

function wait(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error('Solicitação interrompida pelo usuário.'), {
        code: 'request_cancelled', category: 'cancelled'
      }));
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export function prepareAgenticToolRequest(body = {}) {
  if (!Array.isArray(body.tools) || !body.tools.length) return body;
  const phase = projectToolPhase(body.tools);
  const names = body.tools.map(tool => tool?.function?.name).filter(Boolean);
  const hasToolResult = (body.messages || []).some(message => message?.role === 'tool');
  const forceInitialSearch = !hasToolResult
    && ['mixed', 'exploration'].includes(phase)
    && names.includes('search_project');
  const forceAgentAction = hasToolResult
    && phase === 'mixed'
    && names.some(name => isProjectMutationTool(name));
  const provider = body.provider && typeof body.provider === 'object'
    ? { ...body.provider, require_parameters: false }
    : body.provider;
  return {
    ...body,
    ...(provider ? { provider } : {}),
    tool_choice: forceInitialSearch
      ? { type: 'function', function: { name: 'search_project' } }
      : forceAgentAction
        ? 'required'
        : projectToolChoice(body.tools),
    parallel_tool_calls: allowParallelProjectToolCalls(body.tools, true)
  };
}

function textToolInstruction(tools = []) {
  const names = tools.map(tool => tool?.function?.name).filter(Boolean);
  if (names.length === 1 && names[0] === 'write_project_files') {
    return [
      'O projeto ativo já está disponível e esta fase exige uma gravação real multi-arquivo.',
      'Para evitar corrupção de quebras de linha, NÃO coloque HTML/CSS/JS dentro de strings JSON.',
      'Responda somente com um bloco Markdown completo para cada arquivo solicitado, usando as linguagens corretas (por exemplo ```html, ```css e ```javascript).',
      'Use quebras de linha reais dentro dos blocos; nunca substitua quebras por caracteres “n” nem por texto \\n.',
      'Para uma página HTML/CSS/JS padrão, use nomes coerentes: index.html, styles.css e script.js, e faça o HTML referenciar exatamente esses nomes.',
      'Não escreva explicações fora dos blocos. O Genesis converterá os blocos em uma chamada write_project_files real e só concluirá após a confirmação no disco.'
    ].join(' ');
  }
  return 'O projeto ativo já está disponível. Esta fase exige UMA ação real com uma das ferramentas habilitadas. Não peça upload manual de arquivos do projeto e não finalize em prosa. Responda somente com o JSON de chamada da ferramenta e aguarde o resultado real.';
}

function forceTextServiceProtocol(tools = []) {
  return tools.length === 1 && tools[0]?.function?.name === 'write_project_files';
}

export class PreciseOpenRouterProvider extends ResilientOpenRouterProvider {
  constructor(options) {
    super(options);
    this.activeTaskFingerprints = new Map();
  }

  setApiKey(value) {
    super.setApiKey(value);
    this.activeTaskFingerprints?.clear();
  }

  candidate(model, catalog, mode, taskProfile = {}) {
    const candidate = super.candidate(model, catalog, mode, taskProfile);
    // O roteador gratuito pode escolher modelos heterogêneos. Para ele, o protocolo
    // textual validado do Genesis é mais robusto do que exigir tool calling nativo
    // de todas as rotas possíveis. Modelos gratuitos específicos continuam nativos.
    if (model === 'openrouter/free') {
      return { ...candidate, supportsTools: false, toolMode: 'text' };
    }
    return candidate;
  }

  markSuccess(value = {}) {
    if (value.model) return super.markSuccess(value);
    return OpenAICompatibleProvider.prototype.markSuccess.call(this, value);
  }

  sessionState(sessionId, messages = []) {
    const state = ResilientOpenRouterProvider.prototype.sessionState.call(this, sessionId, messages);
    const key = String(sessionId || 'default');
    const fingerprint = this.activeTaskFingerprints.get(key);
    if (fingerprint && state.taskFingerprint !== fingerprint) {
      state.taskFingerprint = fingerprint;
      state.completed.clear();
      state.journal = [];
      state.mutations = 0;
      state.updatedAt = Date.now();
    }
    return state;
  }

  continuityMessage() {
    return '';
  }

  async requestJson(url, options = {}, timeoutMs) {
    if (String(url).endsWith('/chat/completions') && options.body) {
      try {
        const body = prepareAgenticToolRequest(JSON.parse(options.body));
        options = { ...options, body: JSON.stringify(body) };
      } catch {
        // O parser/validador normal do provider continua sendo a fonte de erro.
      }
    }
    return OpenAICompatibleProvider.prototype.requestJson.call(this, url, options, timeoutMs);
  }

  async requestWithRetry(input, attempts) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await OpenAICompatibleProvider.prototype.generate.call(this, input);
      } catch (error) {
        if (input.signal?.aborted || error?.code === 'request_cancelled') throw error;
        lastError = error;
        const category = error?.category || 'unknown';
        const retryableCategory = ['timeout', 'availability', 'unknown'].includes(category);
        if (error?.retryable === false || error?.retryAfterMs > 0 || !retryableCategory || attempt === attempts - 1) break;
        await wait(attempt === 0 ? 300 : 800, input.signal);
      }
    }
    throw lastError;
  }

  async generate(input) {
    const fingerprint = taskFingerprint(input.messages || []);
    const baseSessionId = String(input.sessionId || 'default');
    const key = `${baseSessionId}:task:${fingerprintId(fingerprint)}`;
    const suppliedTools = input.tools || [];
    const suppliedPhase = projectToolPhase(suppliedTools);
    const tools = agenticToolsForMessages(suppliedTools, input.messages || []);
    const phase = projectToolPhase(tools);
    const required = projectToolActionRequired(suppliedTools, tools);
    const serviceTextProtocol = forceTextServiceProtocol(tools);
    this.activeTaskFingerprints.set(key, fingerprint);
    const state = this.sessionState(key);
    const previousMutationCount = state.mutations;

    // O guard legado do Resilient não deve encerrar a resposta antes da camada
    // Precise recuperar formatos seguros (HTML bruto, JSON de argumentos etc.).
    // A validação obrigatória permanece nesta camada e só aceita tool call real.
    const suppressLegacyMutationGuard = required;

    try {
      if (suppressLegacyMutationGuard && state.mutations === 0) state.mutations = 1;

      // Serviços multi-arquivo transportam blocos grandes de HTML/CSS/JS. Mesmo
      // modelos que anunciam tool calling nativo podem serializar mal arrays ou
      // strings extensas e produzir files=[]/files ausente. Para esse único caso,
      // enviamos a geração como texto estruturado e recuperamos os blocos localmente
      // em write_project_files validado antes de qualquer acesso ao disco.
      let request = { ...input, sessionId: key, tools: serviceTextProtocol ? [] : tools };
      if (required && (serviceTextProtocol || input.candidate?.supportsTools === false)) {
        request = {
          ...request,
          messages: [
            ...(request.messages || []),
            {
              role: 'system',
              content: textToolInstruction(tools)
            }
          ]
        };
      }

      let result = await super.generate(request);
      if (required && !result.toolCalls?.length) {
        result = recoverRequiredProjectToolCall({ result, tools, messages: request.messages || [] });
      }

      if (required && !result.toolCalls?.length) {
        const detail = result?.toolRecoveryRejected ? ` ${result.toolRecoveryRejected}` : '';
        const error = new ProviderError(
          (phase === 'verification'
            ? 'A rota não executou a verificação obrigatória do projeto.'
            : phase === 'mutation'
              ? 'A rota não executou a alteração obrigatória do projeto.'
              : 'A rota não executou a ferramenta obrigatória para continuar a tarefa no projeto ativo.') + detail,
          {
            providerId: this.id,
            category: 'model',
            code: phase === 'verification'
              ? 'required_verification_missing'
              : phase === 'mutation' ? 'project_action_missing' : 'required_project_tool_missing',
            retryable: false
          }
        );
        error.usage = result.usage;
        throw error;
      }
      return result;
    } finally {
      if (suppressLegacyMutationGuard) state.mutations = previousMutationCount;
      this.activeTaskFingerprints.delete(key);
    }
  }
}
