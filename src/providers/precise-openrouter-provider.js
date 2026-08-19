import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { ResilientOpenRouterProvider } from './resilient-openrouter-provider.js';
import { ProviderError } from '../core/errors.js';
import {
  allowParallelProjectToolCalls,
  isProjectMutationTool,
  isProjectReadTool,
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

export function agenticToolsForMessages(tools = [], messages = []) {
  if (projectToolPhase(tools) !== 'mixed' || successfulReadEvidence(messages) < 2) return tools;
  const mutations = tools.filter(tool => isProjectMutationTool(tool));
  return mutations.length ? mutations : tools;
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
  return {
    ...body,
    tool_choice: forceInitialSearch
      ? { type: 'function', function: { name: 'search_project' } }
      : forceAgentAction
        ? 'required'
        : projectToolChoice(body.tools),
    parallel_tool_calls: allowParallelProjectToolCalls(body.tools, true)
  };
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

  // O orquestrador já carrega a continuidade canônica entre rotas. Duplicá-la
  // novamente no provider fazia o mesmo resultado de ferramenta ocupar contexto
  // duas vezes e aumentava o custo de cada rodada subsequente.
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
        const retryableCategory = ['timeout', 'availability', 'unknown'].includes(category)
          || (category === 'quota' && input.candidate.model === 'openrouter/free');
        if (error?.retryable === false || !retryableCategory || attempt === attempts - 1) break;
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
    const enoughExploration = tools !== suppliedTools;
    const phase = projectToolPhase(tools);
    const required = projectToolCallRequired(tools);
    this.activeTaskFingerprints.set(key, fingerprint);
    const state = this.sessionState(key);
    const previousMutationCount = state.mutations;
    const suppressLegacyMutationGuard = suppliedPhase === 'mixed' && !enoughExploration;

    try {
      // Durante exploração de uma tarefa de edição existem ferramentas de leitura
      // e escrita no mesmo lote. O antigo guard textual do provider não pode tratar
      // uma resposta exploratória como falha de mutação; a máquina de fases do
      // orquestrador é a autoridade para decidir quando escrever é obrigatório.
      if (suppressLegacyMutationGuard && state.mutations === 0) state.mutations = 1;

      let request = { ...input, sessionId: key, tools };
      if (required && input.candidate?.supportsTools === false) {
        request = {
          ...request,
          messages: [
            ...(request.messages || []),
            {
              role: 'system',
              content: 'Esta fase exige uma ação real. Responda somente com o JSON de chamada de UMA das ferramentas habilitadas; não produza prosa e não finalize sem ferramenta.'
            }
          ]
        };
      }

      const result = await super.generate(request);
      if (required && !result.toolCalls?.length) {
        const error = new ProviderError(
          phase === 'verification'
            ? 'A rota não executou a verificação obrigatória do projeto.'
            : 'A rota não executou a alteração obrigatória do projeto.',
          {
            providerId: this.id,
            category: 'model',
            code: phase === 'verification' ? 'required_verification_missing' : 'project_action_missing',
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
