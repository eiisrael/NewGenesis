import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { assertFreeOpenRouterModels } from '../core/policy.js';
import { ProviderError } from '../core/errors.js';
import { sanitizeModelText } from '../core/content-sanitizer.js';

const MUTATION_TOOLS = new Set([
  'write_project_file', 'replace_project_text', 'create_project_directory', 'move_project_path', 'delete_project_path'
]);

const now = () => Date.now();

function normalizeText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

function wantsProjectMutation(messages, tools) {
  if (!tools.some(tool => MUTATION_TOOLS.has(tool?.function?.name))) return false;
  const latest = [...messages].reverse().find(message => message.role === 'user');
  const text = normalizeText(textContent(latest?.content));
  return /\b(crie|criar|adicione|adicionar|altere|alterar|atualize|atualizar|corrija|corrigir|conserte|implemente|implementar|remova|remover|deletar|mova|mover|renomeie|renomear|ajuste|ajustar|edite|editar|fix|create|update|change|implement|remove|delete|move|rename|edit)\b/.test(text);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function callSignature(name, args) {
  return `${String(name || '')}:${stableJson(parseArguments(args))}`;
}

function routeCooldown(error, headers = null) {
  if (headers) {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) {
        return Math.min(5 * 60 * 1000, Math.max(1000, seconds * 1000));
      }
    }
    const resetRequests = headers.get('x-ratelimit-reset-requests');
    const resetTokens = headers.get('x-ratelimit-reset-tokens');
    if (resetRequests) {
      const ms = parseInt(resetRequests, 10) * 1000 - Date.now();
      if (ms > 0 && ms < 5 * 60 * 1000) return ms;
    }
    if (resetTokens) {
      const ms = parseInt(resetTokens, 10) * 1000 - Date.now();
      if (ms > 0 && ms < 5 * 60 * 1000) return ms;
    }
  }
  if (error?.retryAfterMs) return Math.min(10 * 60 * 1000, Math.max(1000, error.retryAfterMs));
  return {
    quota: 30000,
    timeout: 30000,
    availability: 45000,
    model: 5 * 60 * 1000,
    request: error?.retryable === false ? 10 * 60 * 1000 : 60000,
    context: 0
  }[error?.category] ?? 30000;
}

function modelScore(model, mode) {
  const id = String(model.id || '').toLowerCase();
  let score = Math.min(24, Math.log2(Math.max(2048, model.contextWindow || 8192)) * 1.6);
  const quality = [
    ['qwen3-next', 32], ['llama-3.3-70b', 31], ['gemma-4-31b', 29],
    ['nemotron-3-super', 28], ['405b', 27], ['gemma-4-26b', 25],
    ['nemotron-3-ultra', 24], ['poolside', 22], ['nemotron-3-nano-omni', 21],
    ['nemotron-nano', 18], ['gpt-oss-20b', 17]
  ];
  for (const [term, value] of quality) if (id.includes(term)) score += value;
  const boosts = {
    code: [['qwen3-coder', 52], ['coder', 38], ['north-mini-code', 42], ['laguna', 30], ['qwen', 24]],
    reasoning: [['nemotron-3-ultra', 44], ['nemotron-3-super', 40], ['405b', 36], ['qwen3-next', 35], ['reason', 32], ['nemotron-3-nano-omni', 28]],
    fast: [['laguna-xs', 46], ['nano-9b', 40], ['nano-30b', 36], ['20b', 32], ['mini', 30], ['3b', 28]],
    balanced: [['qwen3-next', 31], ['llama-3.3-70b', 30], ['gemma-4-31b', 27], ['poolside', 28], ['nemotron-3-super', 18], ['405b', 20]]
  }[mode] || [];
  for (const [term, value] of boosts) if (id.includes(term)) score += value;
  if (id.includes('preview')) score -= 5;
  return score;
}

function stripJsonFence(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

function parseTextToolCall(content, tools) {
  const source = stripJsonFence(content);
  if (!source.startsWith('{') || !source.endsWith('}')) return [];
  let parsed;
  try { parsed = JSON.parse(source); } catch { return []; }
  const name = String(parsed.tool || parsed.name || parsed.function?.name || '').trim();
  const allowed = new Set((tools || []).map(tool => tool?.function?.name).filter(Boolean));
  if (!allowed.has(name)) return [];
  const args = parsed.arguments ?? parsed.args ?? parsed.function?.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return [{
    id: `genesis-text-tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }];
}

function toolProtocol(tools) {
  const safeTools = tools || [];
  const definitions = safeTools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));
  return `MODO DE FERRAMENTAS COMPATÍVEL DO GÊNESIS\nQuando precisar usar uma ferramenta, responda SOMENTE com um JSON válido, sem markdown e sem explicação, exatamente assim:\n{"tool":"nome_da_ferramenta","arguments":{}}\nExecute apenas UMA ferramenta por resposta e aguarde o resultado real.\nFerramentas permitidas:\n${JSON.stringify(definitions)}\nNunca afirme que alterou ou verificou algo sem receber o resultado real da ferramenta.`;
}

function insertSystemMessage(messages, content) {
  const output = structuredClone(messages);
  const index = output.findIndex(message => message.role !== 'system');
  output.splice(index < 0 ? output.length : index, 0, { role: 'system', content });
  return output;
}

function prepareTextToolMessages(messages, tools) {
  const safeTools = tools || [];
  const protocol = toolProtocol(safeTools);
  const prepared = [];
  let inserted = false;
  for (const message of messages) {
    if (message.role === 'system') {
      prepared.push({ ...message, content: `${textContent(message.content)}${inserted ? '' : `\n\n${protocol}`}` });
      inserted = true;
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      prepared.push({
        role: 'assistant',
        content: `Solicitei a ferramenta: ${message.tool_calls.map(call => `${call.function.name}(${call.function.arguments})`).join(', ')}`
      });
      continue;
    }
    if (message.role === 'tool') {
      prepared.push({ role: 'user', content: `RESULTADO REAL DA FERRAMENTA ${message.name || ''}:\n${String(message.content || '')}` });
      continue;
    }
    prepared.push(message);
  }
  if (!inserted) prepared.unshift({ role: 'system', content: protocol });
  return prepared;
}

function isGlobalFailure(error) {
  return error?.category === 'authentication'
    || error?.category === 'paid_blocked'
    || error?.code === 'provider_unreachable';
}

function wait(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Solicitação interrompida pelo usuário.'), {
        code: 'request_cancelled', category: 'cancelled'
      }));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export class ResilientOpenRouterProvider extends OpenAICompatibleProvider {
  constructor(options) {
    super(options);
    this.routeHealth = new Map();
    this.sessionTools = new Map();
    this.activeModel = null;
  }

  setApiKey(value) {
    super.setApiKey(value);
    this.routeHealth.clear();
    this.sessionTools.clear();
    this.activeModel = null;
  }

  routeState(model) {
    const key = String(model || 'openrouter/free');
    if (!this.routeHealth.has(key)) {
      this.routeHealth.set(key, {
        failures: 0,
        successes: 0,
        cooldownUntil: 0,
        lastError: null,
        lastSuccessAt: 0,
        lastFailureAt: 0,
        latencyMs: null
      });
    }
    return this.routeHealth.get(key);
  }

  resetAllRoutes() {
    // Chamado pelo setApiKey() (classe-pai) quando a chave é trocada:
    // limpa falhas/cooldown de todas as rotas que falharam, pois uma chave
    // nova significa que a quota anterior não se aplica mais.
    const timestamp = now();
    for (const state of this.routeHealth.values()) {
      state.failures = 0;
      state.cooldownUntil = 0;
      state.lastError = null;
      state.lastRecoveryAt = timestamp;
    }
  }

  routeCanAttempt(model) {
    return this.routeState(model).cooldownUntil <= now();
  }

  routeReliability(model) {
    const state = this.routeState(model);
    let score = Math.min(20, state.successes * 4) - Math.min(48, state.failures * 8);
    if (state.lastSuccessAt > state.lastFailureAt) score += 12;
    if (state.latencyMs) score -= Math.min(12, state.latencyMs / 2500);
    if (!this.routeCanAttempt(model)) score -= 1000;
    return score;
  }

  canAttempt() {
    if (!this.configured) return false;
    if (!this.isCoolingDown()) return true;
    return !['authentication', 'paid_blocked'].includes(this.health.lastError?.category)
      && this.health.lastError?.code !== 'provider_unreachable';
  }

  markFailure(error) {
    if (isGlobalFailure(error)) {
      super.markFailure(error);
      return;
    }
    const state = this.routeState(this.activeModel || 'openrouter/free');
    state.failures += 1;
    state.lastFailureAt = now();
    state.lastError = { code: error?.code || 'provider_error', category: error?.category || 'unknown' };
    state.cooldownUntil = now() + routeCooldown(error, error.headers);
    this.health.failureCount += 1;
    this.health.lastCheckedAt = new Date().toISOString();
    this.health.lastError = {
      code: error?.code || 'provider_error',
      category: error?.category || 'unknown',
      message: String(error?.message || 'Falha na rota').slice(0, 180)
    };
    this.health.state = 'degraded';
    this.health.cooldownUntil = 0;
  }

  markSuccess(value = {}) {
    const model = value.model || this.activeModel;
    if (model) {
      const state = this.routeState(model);
      state.successes += 1;
      state.failures = Math.max(0, state.failures - 1);
      state.cooldownUntil = 0;
      state.lastError = null;
      state.lastSuccessAt = now();
      if (Number.isFinite(value.latencyMs)) state.latencyMs = Math.round(value.latencyMs);
    }
    super.markSuccess(value);
  }

  candidate(model, catalog, mode, taskProfile = {}) {
    const candidate = super.candidate(model, catalog, mode, taskProfile);
    return {
      ...candidate,
      toolMode: candidate.supportsTools ? 'native' : 'text',
      score: candidate.score + this.routeReliability(model)
    };
  }

  async resolveCandidates(mode, requirements = {}, options = {}) {
    if (!this.canAttempt()) return null;
    // Limpa automaticamente cooldowns que já expiraram para garantir
    // que o usuário não fique preso em uma sessão com rotas bloqueadas.
    const timestamp = now();
    for (const state of this.routeHealth.values()) {
      if (state.cooldownUntil > 0 && state.cooldownUntil <= timestamp) {
        state.cooldownUntil = 0;
      }
    }
    let catalog = [];
    try {
      catalog = await this.models({ signal: options.signal, force: options.force === true });
    } catch (error) {
      if (error?.code === 'request_cancelled') throw error;
    }

    if (this.selectionMode === 'manual') {
      const model = this.selectedModel;
      assertFreeOpenRouterModels([model]);
      const known = catalog.find(item => item.id === model);
      const candidates = [];
      const supportsImage = !requirements.image || known?.inputModalities?.includes('image') || model === 'openrouter/free';
      if ((known && supportsImage) || (!catalog.length && !requirements.image)) {
        candidates.push(this.candidate(model, catalog, mode, options.taskProfile));
      }
      if (model !== 'openrouter/free') {
        candidates.push({
          ...this.candidate('openrouter/free', catalog, mode, options.taskProfile),
          score: requirements.tools ? 84 + this.routeReliability('openrouter/free') : -25
        });
      }
      return candidates.filter(candidate => this.routeCanAttempt(candidate.model));
    }

    const compatible = catalog
      .filter(model => model.id !== 'openrouter/free')
      .filter(model => !requirements.image || model.inputModalities?.includes('image'))
      .map(model => this.candidate(model.id, catalog, mode, options.taskProfile))
      .filter(candidate => this.routeCanAttempt(candidate.model))
      .map(candidate => ({
        ...candidate,
        score: candidate.score + (requirements.tools ? (candidate.supportsTools ? 30 : -16) : 0)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 8);

    if (this.routeCanAttempt('openrouter/free')) {
      compatible.push({
        ...this.candidate('openrouter/free', catalog, mode, options.taskProfile),
        score: requirements.tools ? 12 + this.routeReliability('openrouter/free') : -20
      });
    }
    return compatible.sort((left, right) => right.score - left.score);
  }

  cleanupSessions() {
    const expiry = now() - 30 * 60 * 1000;
    for (const [sessionId, state] of this.sessionTools) {
      if (state.updatedAt < expiry) this.sessionTools.delete(sessionId);
    }
    if (this.sessionTools.size <= 100) return;
    const oldest = [...this.sessionTools.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(0, this.sessionTools.size - 100);
    for (const [sessionId] of oldest) this.sessionTools.delete(sessionId);
  }

  sessionState(sessionId) {
    this.cleanupSessions();
    const key = String(sessionId || 'default');
    if (!this.sessionTools.has(key)) {
      this.sessionTools.set(key, { completed: new Map(), journal: [], mutations: 0, updatedAt: now() });
    }
    const state = this.sessionTools.get(key);
    state.updatedAt = now();
    return state;
  }

  captureToolResults(messages, state) {
    const pending = new Map();
    for (const message of messages) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) pending.set(call.id, call);
        continue;
      }
      if (message.role !== 'tool') continue;
      const call = pending.get(message.tool_call_id);
      if (!call?.function?.name) continue;
      const signature = callSignature(call.function.name, call.function.arguments);
      if (state.completed.has(signature)) continue;
      let result;
      try { result = JSON.parse(String(message.content || '{}')); }
      catch { result = { ok: false, error: String(message.content || '') }; }
      const raw = JSON.stringify(result);
      const data = raw.length <= 8000 ? raw : `${raw.slice(0, 5600)}…${raw.slice(-2200)}`;
      const entry = {
        tool: call.function.name,
        arguments: parseArguments(call.function.arguments),
        ok: result?.ok === true,
        denied: result?.denied === true,
        summary: String(result?.summary || result?.message || result?.error || '').slice(0, 500),
        data
      };
      state.completed.set(signature, { call, result, entry });
      state.journal.push(entry);
      if (entry.ok && MUTATION_TOOLS.has(entry.tool)) state.mutations += 1;
    }
    state.updatedAt = now();
  }

  continuityMessage(state) {
    if (!state.journal.length) return '';
    const compact = state.journal.slice(-12).map(entry => ({
      tool: entry.tool,
      arguments: entry.arguments,
      ok: entry.ok,
      denied: entry.denied,
      summary: entry.summary
    }));
    return sanitizeModelText(
      `CONTINUIDADE DE FERRAMENTAS — operações reais já concluídas nesta mesma tarefa. Não repita operações prontas; continue a partir dos resultados abaixo:\n${JSON.stringify(compact)}`,
      { maxCharacters: 12_000, maxLineCharacters: 4_000 }
    ).text;
  }

  async requestWithRetry(input, attempts) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await super.generate(input);
      } catch (error) {
        if (input.signal?.aborted || error?.code === 'request_cancelled') throw error;
        lastError = error;
        const retryable = error?.retryable !== false
          && ['availability', 'unknown'].includes(error?.category || 'unknown');
        if (!retryable || attempt === attempts - 1) break;
        await wait(attempt === 0 ? 300 : 800, input.signal);
      }
    }
    throw lastError;
  }

  async generate({ candidate, messages, maxOutputTokens, temperature, sessionId, signal, tools = [], requestBudget = null, requestKind = 'completion', onDelta = null, deadlineAt = null }) {
    this.activeModel = candidate.model;
    const state = this.sessionState(sessionId);
    this.captureToolResults(messages, state);
    let preparedMessages = structuredClone(messages);
    const continuity = this.continuityMessage(state);
    if (continuity) preparedMessages = insertSystemMessage(preparedMessages, continuity);

    const useTextTools = tools.length > 0 && candidate.supportsTools === false;
    if (useTextTools) preparedMessages = prepareTextToolMessages(preparedMessages, tools);
    const requestTools = useTextTools ? [] : tools;
    // Cada chamada HTTP precisa permanecer visível e contabilizada pelo
    // orquestrador. Fallback entre modelos substitui retries ocultos.
    const maxAttempts = 1;
    let result = await this.requestWithRetry({
      candidate,
      messages: preparedMessages,
      maxOutputTokens,
      temperature,
      sessionId,
      signal,
      tools: requestTools,
      requestBudget,
      requestKind,
      deadlineAt,
      onDelta: tools.length ? null : onDelta
    }, maxAttempts);

    if (useTextTools) {
      const toolCalls = parseTextToolCall(result.content, tools);
      if (toolCalls.length) result = { ...result, content: '', toolCalls, finishReason: 'tool_calls' };
    }

    // Chamadas repetidas voltam ao orquestrador. Ele reconhece a assinatura,
    // devolve um resultado compacto ao modelo e faz a proxima inferencia como
    // uma requisicao visivel. O provider nunca cria uma chamada HTTP oculta.

    if (wantsProjectMutation(messages, tools) && !result.toolCalls?.length && state.mutations === 0) {
      const error = new ProviderError('A rota respondeu sem executar a alteração solicitada no projeto.', {
        providerId: this.id,
        category: 'model',
        code: 'project_action_missing',
        retryable: false
      });
      error.usage = result.usage;
      throw error;
    }
    return result;
  }

  publicStatus() {
    const routes = [...this.routeHealth.values()];
    return {
      ...super.publicStatus(),
      healthyRouteCount: routes.filter(route => route.cooldownUntil <= now()).length,
      coolingRouteCount: routes.filter(route => route.cooldownUntil > now()).length
    };
  }
}
