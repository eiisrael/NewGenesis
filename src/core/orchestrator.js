import { GenesisUnavailableError, safeError } from './errors.js';
import { MODES, normalizeMode } from './policy.js';
import { buildContinuityLedger, estimateTokens, estimateRequestTokens, classifyIntent, getIntentBudget, getIntentLabel } from './context-engine.js';
import { InferenceBudget, createUsageLedger, recordUsage, finalUsage } from './request-budget.js';
import { sanitizeModelText } from './content-sanitizer.js';
import { verifyTaskOutcome } from './task-verifier.js';

const MUTATION_TOOL_NAMES = new Set([
  'write_project_file', 'replace_project_text', 'create_project_directory',
  'move_project_path', 'delete_project_path'
]);

function hasSuccessfulEvidence(evidence, predicate) {
  return evidence.some(item => item?.ok === true && predicate(item));
}

function localMutationCompletionReport(evidence) {
  const mutations = evidence.filter(item => item?.ok === true && MUTATION_TOOL_NAMES.has(item.tool));
  const checks = evidence.filter(item => item?.ok === true && item.tool === 'run_project_check');
  const lines = ['## Relatório final do Genesis', '', '### Alterações realizadas', ''];
  for (const item of mutations) {
    let target = '';
    try {
      const args = JSON.parse(item.arguments || '{}');
      target = args.path || args.to || args.from || '';
    } catch { /* argumentos já foram sanitizados; o resumo continua suficiente */ }
    lines.push(`- ${target ? `\`${target}\`` : ''}${item.summary || `${item.tool} concluída.`}`);
  }
  lines.push('', '### Verificação', '');
  if (checks.length) {
    for (const item of checks) lines.push(`- ${item.summary || 'Verificação concluída.'}`);
    lines.push('', '**Pronto: as alterações foram aplicadas e verificadas.**');
  } else {
    lines.push('- A alteração foi confirmada no projeto; não havia uma verificação automatizada concluída dentro desta execução.');
    lines.push('', '**Alterações aplicadas. O resultado está pronto para validação visual no projeto.**');
  }
  return lines.join('\n');
}

const BASE_PRIORITY = {
  balanced: { openrouter: 40 },
  reasoning: { openrouter: 42 },
  code: { openrouter: 42 },
  fast: { openrouter: 40 }
};

function providerScore(provider, candidate, mode, lastProviderId) {
  const health = provider.publicStatus();
  let score = (BASE_PRIORITY[mode]?.[provider.id] || 0) + candidate.score;
  if (provider.id === lastProviderId) score += 9;
  if (health.latencyMs) score -= Math.min(14, health.latencyMs / 1000);
  score -= health.failureCount * 8;
  if (health.remainingRequests !== null && health.remainingRequests < 3) score -= 24;
  if (health.remainingTokens !== null && health.remainingTokens < 2500) score -= 18;
  return score;
}

function contextMetrics(context) {
  const { messages, ...metrics } = context;
  return metrics;
}

function compactToolResult(value, maxCharacters) {
  const hardLimit = Math.max(0, Number(maxCharacters) || 0);
  if (hardLimit === 0) return { content: '', characters: 0, sanitized: { text: '', truncated: true } };
  const raw = JSON.stringify(value ?? null);
  const sanitized = sanitizeModelText(raw, {
    maxCharacters: hardLimit,
    maxLineCharacters: Math.max(128, Math.min(3_000, hardLimit))
  });
  return { content: sanitized.text, characters: sanitized.text.length, sanitized };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toolCallSignature(toolCall) {
  let args = {};
  try { args = JSON.parse(String(toolCall?.function?.arguments || '{}')); } catch {
    args = String(toolCall?.function?.arguments || '');
  }
  return `${String(toolCall?.function?.name || '')}:${stableJson(args)}`;
}

function summarizedToolContent(content) {
  let value;
  try { value = JSON.parse(String(content || '{}')); } catch { value = null; }
  if (!value || typeof value !== 'object') {
    return sanitizeModelText(content, { maxCharacters: 1_200, maxLineCharacters: 1_000 }).text;
  }
  const summary = {
    ok: value.ok,
    denied: value.denied,
    path: value.path,
    check: value.check,
    summary: value.summary,
    error: value.error,
    code: value.code,
    startLine: value.startLine,
    endLine: value.endLine,
    nextStartLine: value.nextStartLine,
    totalLines: value.totalLines,
    truncated: value.truncated
  };
  if (Array.isArray(value.matches)) summary.matches = value.matches.slice(0, 6);
  if (value.output) summary.outputTail = String(value.output).slice(-1_500);
  return JSON.stringify(summary);
}

function compactMessagesForRequest(messages, tokenLimit) {
  let cloned = structuredClone(messages);
  if (!Number.isFinite(tokenLimit) || tokenLimit <= 0) return cloned;
  let estimate = estimateRequestTokens(cloned, []);
  if (estimate <= tokenLimit) return cloned;
  for (let index = 0; index < cloned.length && estimate > tokenLimit; index += 1) {
    if (cloned[index].role !== 'tool') continue;
    cloned[index].content = summarizedToolContent(cloned[index].content);
    estimate = estimateRequestTokens(cloned, []);
  }
  if (estimate <= tokenLimit) return cloned;
  for (let index = 0; index < cloned.length - 2 && estimate > tokenLimit; index += 1) {
    if (cloned[index].role !== 'assistant' || !cloned[index].tool_calls?.length) continue;
    cloned[index].content = null;
    cloned[index].tool_calls = cloned[index].tool_calls.map(call => ({
      ...call,
      function: { ...call.function, arguments: sanitizeModelText(call.function.arguments, { maxCharacters: 800 }).text }
    }));
    estimate = estimateRequestTokens(cloned, []);
  }
  if (estimate <= tokenLimit) return cloned;

  const latestUserIndex = cloned.findLastIndex(message => message.role === 'user');
  let activeToolStart = -1;
  for (let index = cloned.length - 1; index >= 0; index -= 1) {
    if (cloned[index].role === 'assistant' && cloned[index].tool_calls?.length) {
      activeToolStart = index;
      break;
    }
  }
  cloned = cloned.filter((message, index) => (
    message.role === 'system'
    || index === latestUserIndex
    || (activeToolStart >= 0 && index >= activeToolStart)
    || index >= cloned.length - 4
  ));
  estimate = estimateRequestTokens(cloned, []);

  for (let pass = 0; pass < 12 && estimate > tokenLimit; pass += 1) {
    let targetIndex = -1;
    let targetLength = 0;
    for (let index = 0; index < cloned.length; index += 1) {
      const content = cloned[index].content;
      if (typeof content !== 'string') continue;
      const minimum = index === cloned.findLastIndex(message => message.role === 'user') ? 1_200 : 500;
      if (content.length > minimum && content.length > targetLength) {
        targetIndex = index;
        targetLength = content.length;
      }
    }
    if (targetIndex < 0) break;
    const isLatestUser = targetIndex === cloned.findLastIndex(message => message.role === 'user');
    const nextLength = Math.max(isLatestUser ? 1_200 : 500, Math.floor(targetLength * .58));
    cloned[targetIndex].content = sanitizeModelText(cloned[targetIndex].content, {
      maxCharacters: nextLength,
      maxLineCharacters: Math.min(2_000, nextLength)
    }).text;
    estimate = estimateRequestTokens(cloned, []);
  }
  return cloned;
}

function localGenesisResult({ localResponse, conversation, projectContext, taskContract, onEvent }) {
  const descriptor = typeof localResponse === 'string'
    ? { content: localResponse, model: 'project-profiler', message: 'O inventário foi analisado localmente, sem enviar conteúdo do projeto para uma API.' }
    : localResponse;
  const content = String(descriptor?.content || '');
  const model = String(descriptor?.model || 'local-context').slice(0, 80);
  const usage = {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, requestCount: 0,
    reportedRequests: 0, estimatedRequests: 0, unknownRequests: 0,
    accuracy: 'local', sentInputTokenEstimate: 0, inputTokenLimit: 0, models: []
  };
  const context = {
    estimatedTokens: 0,
    canonicalTokens: estimateTokens(projectContext?.text || ''),
    contextWindow: 0,
    inputBudget: 0,
    outputReserve: 0,
    retainedMessages: 1,
    totalMessages: conversation.messages.length,
    compactedMessages: 0,
    projectFiles: projectContext?.selectedFiles?.length || 0,
    projectTotalFiles: projectContext?.totalFiles || 0,
    savedTokens: estimateTokens(projectContext?.text || ''),
    memoryRetainedPercent: 100,
    usedTokens: 0,
    remainingTokens: 0,
    totalRequestTokens: 0,
    requestCount: 0,
    usageAccuracy: 'local',
    task: taskContract,
    ...(descriptor?.snapshot ? { localContext: descriptor.snapshot } : {})
  };
  const verification = verifyTaskOutcome({
    contract: taskContract,
    response: { content, finishReason: 'stop' },
    evidence: [],
    usage
  });
  context.verification = verification;
  onEvent('local_analysis', {
    message: descriptor?.message || (model === 'project-profiler'
      ? 'O inventário foi analisado localmente, sem enviar conteúdo do projeto para uma API.'
      : 'O contexto local foi resolvido deterministicamente, sem consultar um modelo de linguagem.'),
    taskId: taskContract?.id,
    projectFiles: projectContext?.totalFiles || 0
  });
  onEvent('complete', {
    providerId: 'genesis-local', provider: 'Genesis Local', model,
    latencyMs: 0, usage, context, freeVerified: true
  });
  onEvent('verification', { taskId: taskContract?.id, verification });
  return {
    content,
    model,
    resolvedModel: model,
    resolvedProvider: 'Genesis Local',
    providerId: 'genesis-local',
    provider: 'Genesis Local',
    requestedModel: model,
    latencyMs: 0,
    finishReason: 'stop',
    usage,
    context,
    attempts: [],
    freeVerified: true,
    task: taskContract,
    verification
  };
}

function wantsImageGeneration(value) {
  const text = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const create = /\b(crie|criar|gere|gerar|faca|produza|desenhe|monte)\b/.test(text);
  const image = /\b(imagem|foto|ilustracao|arte|logo|banner|icone|capa|wallpaper)\b/.test(text);
  return create && image;
}

function addUsage(target, usage = {}) {
  target.inputTokens += Number(usage.inputTokens || 0);
  target.outputTokens += Number(usage.outputTokens || 0);
  target.totalTokens += Number(usage.totalTokens || 0);
}

function recordFailedRequestUsage(error, ledger, budget, provider, candidate) {
  if (!error?.usage || !budget?.used) return null;
  const requestNumber = budget.used;
  if (ledger.records.some(record => record.requestNumber === requestNumber)) return null;
  const entry = budget.entries.find(item => item.number === requestNumber);
  return recordUsage(ledger, error.usage, {
    inputTokens: Number(entry?.estimatedInputTokens || 0),
    outputTokens: estimateTokens(error.partialContent || '')
  }, {
    requestNumber,
    providerId: provider?.id || entry?.providerId,
    model: error.resolvedModel || candidate?.model || entry?.model
  });
}

function automaticMode(mode, intent, query) {
  if (mode !== 'balanced') return mode;
  if (['CODE', 'DEBUG', 'REFACTOR', 'DEPENDENCY'].includes(intent)) return 'code';
  if (['ARCHITECTURE', 'ANALYSIS', 'RESEARCH', 'PERFORMANCE', 'SUPREMEMIND'].includes(intent)) return 'reasoning';
  if (intent === 'CHAT' && String(query || '').length < 180) return 'fast';
  return 'balanced';
}

function joinContinuation(left, right) {
  const first = String(left || '').trimEnd();
  const second = String(right || '').trimStart();
  if (!first) return second;
  if (!second) return first;
  const probe = Math.min(240, first.length, second.length);
  for (let size = probe; size >= 24; size -= 1) {
    if (first.slice(-size) === second.slice(0, size)) return `${first}${second.slice(size)}`;
  }
  return `${first}\n${second}`;
}

function waitForRecovery(milliseconds, signal) {
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

export class GenesisOrchestrator {
  constructor({ providers, imageProviders = null, contextEngine, outputTokenBudget, recoveryDelaysMs = [], maxRoutes = 3, maxInferenceRequests = 4, maxToolRequests = 12, maxToolRounds = 12 }) {
    this.providers = providers;
    this.imageProviders = imageProviders || providers.filter(provider => typeof provider.generateImage === 'function');
    this.contextEngine = contextEngine;
    this.outputTokenBudget = outputTokenBudget;
    this.recoveryDelaysMs = recoveryDelaysMs;
    this.maxRoutes = Math.max(1, Number(maxRoutes || 3));
    this.maxInferenceRequests = Math.max(1, Number(maxInferenceRequests || 4));
    this.maxToolRequests = Math.max(this.maxInferenceRequests, Number(maxToolRequests || 12));
    this.maxToolRounds = Math.max(1, Number(maxToolRounds || 12));
    this._contextCache = new Map();
    this.maxContextCacheEntries = 40;
  }

  statuses() { return this.providers.map(provider => provider.publicStatus()); }

  provider(id) { return this.providers.find(provider => provider.id === id) || null; }

  invalidateContext(conversationId = null) {
    if (conversationId) return this._contextCache.delete(String(conversationId));
    this._contextCache.clear();
    return true;
  }

  rememberContext(conversationId, context) {
    const key = String(conversationId);
    this._contextCache.delete(key);
    this._contextCache.set(key, context);
    while (this._contextCache.size > this.maxContextCacheEntries) {
      this._contextCache.delete(this._contextCache.keys().next().value);
    }
  }

  async refreshProviders() {
    await Promise.all(this.providers.map(provider => provider.probe()));
    return this.statuses();
  }

  async prepareHandoff({ conversation, currentContextWindow = 0, requirements = {}, onEvent = () => {}, signal }) {
    const provider = this.provider('openrouter');
    if (!provider?.configured || typeof provider.models !== 'function' || typeof provider.candidate !== 'function') {
      const error = new Error('Conecte sua chave antes de carregar outro modelo.');
      error.status = 400;
      error.code = 'handoff_not_configured';
      throw error;
    }
    const catalog = await provider.models({ signal });
    const currentModel = [...conversation.messages].reverse().find(message => message.role === 'assistant')?.meta?.model || '';
    const candidates = catalog
      .filter(model => model.id !== currentModel && model.contextWindow > currentContextWindow)
      .filter(model => !requirements.tools || model.supportedParameters?.includes('tools'))
      .sort((a, b) => b.contextWindow - a.contextWindow)
      .slice(0, 4);
    if (!candidates.length) {
      const error = new Error('Nenhum modelo gratuito com contexto maior está disponível agora.');
      error.status = 409;
      error.code = 'larger_free_model_unavailable';
      throw error;
    }
    const ledger = buildContinuityLedger(conversation.messages, Math.min(2400, Math.max(900, Math.floor(currentContextWindow * 0.08) || 1600)));
    const handoffMessages = [
      {
        role: 'system',
        content: 'Você é o novo motor do Gênesis. Estude a memória canônica abaixo apenas para validar a continuidade. Não execute tarefas, não altere decisões e responda somente CONTINUIDADE_VALIDADA.'
      },
      { role: 'user', content: ledger || 'Conversa nova, sem decisões anteriores.' }
    ];
    const attempts = [];
    for (const model of candidates) {
      if (signal?.aborted) throw Object.assign(new Error('Troca de modelo interrompida.'), { code: 'request_cancelled', category: 'cancelled' });
      onEvent('handoff_start', { providerId: provider.id, provider: provider.name, model: model.name, contextWindow: model.contextWindow });
      try {
        const candidate = provider.candidate(model.id, catalog, 'balanced');
        const result = await provider.generate({
          candidate,
          messages: handoffMessages,
          maxOutputTokens: 64,
          temperature: 0,
          sessionId: conversation.id,
          signal
        });
        if (!/CONTINUIDADE_VALIDADA/i.test(result.content)) {
          const error = new Error('O modelo não confirmou a memória canônica.');
          error.category = 'model';
          error.code = 'handoff_not_confirmed';
          throw error;
        }
        provider.markSuccess({ latencyMs: result.latencyMs, model: model.id, resolvedModel: result.resolvedModel });
        const handoff = {
          model: model.id,
          modelName: model.name,
          contextWindow: model.contextWindow,
          validatedAt: new Date().toISOString(),
          validationTokens: Number(result.usage?.totalTokens || estimateTokens(ledger))
        };
        onEvent('handoff_complete', { providerId: provider.id, provider: provider.name, ...handoff });
        return handoff;
      } catch (error) {
        if (signal?.aborted || error?.code === 'request_cancelled') throw error;
        attempts.push({ model: model.id, error: safeError(error) });
      }
    }
    const error = new GenesisUnavailableError('Os modelos com contexto maior não conseguiram validar a continuidade agora.', attempts);
    error.status = 503;
    throw error;
  }

  async candidates(mode, lastProviderId, requirements = {}, signal, taskProfile = {}) {
    const normalizedMode = normalizeMode(mode);
    const discovered = await Promise.all(this.providers.map(async provider => {
      try {
        const candidates = provider.resolveCandidates
          ? await provider.resolveCandidates(normalizedMode, requirements, { signal, taskProfile })
          : [await provider.resolveCandidate(normalizedMode, requirements, { signal })].filter(Boolean);
        return (candidates || []).map(candidate => ({ provider, candidate }));
      } catch (error) {
        if (signal?.aborted || error?.code === 'request_cancelled') throw error;
        return [];
      }
    }));
    const ranked = discovered.flat()
      .map(item => ({ ...item, routeScore: providerScore(item.provider, item.candidate, normalizedMode, lastProviderId) }))
      .sort((a, b) => b.routeScore - a.routeScore);
    const router = ranked.find(item => item.candidate.model === 'openrouter/free');
    const specific = ranked.filter(item => item !== router).slice(0, Math.max(1, this.maxRoutes - (router ? 1 : 0)));
    return [...specific, ...(router ? [router] : [])].slice(0, this.maxRoutes);
  }

  async respond({ conversation, mode, onEvent = () => {}, signal, projectContext = null, supremeMind = null, tools = [], toolExecutor = null, userMemoryContext = '', interfaceLanguage = 'pt-BR', turnContext = '', taskContract = null, localResponse = '', _recoveryRound = 0, _attempts = [], _requestBudget = null, _usageLedger = null, _taskEvidence = [], _toolContinuityMessages = [], _deadlineAt = null }) {
    if (signal?.aborted) throw Object.assign(new Error('Solicitação interrompida pelo usuário.'), { code: 'request_cancelled', category: 'cancelled' });
    let normalizedMode = normalizeMode(mode);
    const latestUserMessage = [...conversation.messages].reverse().find(message => message.role === 'user');
    const query = latestUserMessage?.content || '';
    const attachments = latestUserMessage?.attachments || [];
    const imageGeneration = wantsImageGeneration(query) && !attachments.length;
    const intent = classifyIntent(query);
    normalizedMode = automaticMode(normalizedMode, intent, query);
    const intentBudget = getIntentBudget(intent);
    const intentLabel = getIntentLabel(intent);
    if (_recoveryRound === 0 && taskContract) onEvent('task_contract', { task: taskContract });
    if (localResponse) {
      return localGenesisResult({ localResponse, conversation, projectContext, taskContract, onEvent });
    }
    const requirements = {
      image: attachments.some(attachment => attachment.kind === 'image'),
      tools: tools.length > 0 && Boolean(toolExecutor)
    };
    const configuredRequestLimit = requirements.tools ? this.maxToolRequests : this.maxInferenceRequests;
    const contractRequestLimit = Number(taskContract?.requestBudget?.limit || 0);
    const requestLimit = contractRequestLimit > 0
      ? Math.min(configuredRequestLimit, contractRequestLimit)
      : configuredRequestLimit;
    const requestBudget = _requestBudget || new InferenceBudget({
      limit: requestLimit,
      inputTokenLimit: taskContract?.requestBudget?.inputTokenLimit || null
    });
    const usageLedger = _usageLedger || createUsageLedger();
    const configuredDeadlineMs = Math.max(10_000, Number(taskContract?.requestBudget?.deadlineMs || 90_000));
    const deadlineAt = _deadlineAt || (Date.now() + configuredDeadlineMs);
    const deadlineError = () => {
      const error = new GenesisUnavailableError('O tempo total seguro desta tarefa foi atingido; nenhuma nova rota gratuita será iniciada.', _attempts);
      error.code = 'task_deadline_exceeded';
      error.category = 'timeout';
      error.retryable = false;
      error.usage = finalUsage(usageLedger, requestBudget);
      error.task = taskContract;
      return error;
    };
    const assertWithinDeadline = () => {
      if (Date.now() < deadlineAt) return;
      throw deadlineError();
    };
    const taskProfile = {
      intent,
      image: requirements.image,
      tools: requirements.tools,
      longContext: conversation.messages.length > 12 || estimateTokens(projectContext?.text || '') > 8_000,
      kind: taskContract?.kind || 'answer',
      complexity: taskContract?.complexity || 'low',
      outputFormat: taskContract?.outputFormat || 'markdown',
      readOnly: taskContract?.readOnly !== false
    };
    if (_recoveryRound === 0) onEvent('intent', { intent, label: intentLabel, budget: intentBudget, routingMode: normalizedMode });
    if (_recoveryRound === 0) onEvent('route', {
      message: projectContext?.totalFiles
        ? `Analisando ${projectContext.totalFiles} arquivos do projeto, recuperando os trechos relevantes e preparando a memória canônica.`
        : attachments.length
        ? `Validando ${attachments.length} anexo${attachments.length === 1 ? '' : 's'} e preparando a memória canônica.`
        : 'Analisando a tarefa e preparando a memória canônica.',
      attachmentCount: attachments.length
    });

    // Context caching: track previous context per conversation
    const allMessages = conversation.messages.filter(message => ['user', 'assistant'].includes(message.role));
    const currentMessageIds = allMessages.map(m => m.id);

    if (imageGeneration) {
      const imageAttempts = [];
      for (let index = 0; index < this.imageProviders.length; index += 1) {
        const provider = this.imageProviders[index];
        if (typeof provider?.generateImage !== 'function') continue;
        if (provider.configured === false) continue;
        try {
        const result = await provider.generateImage({
          prompt: query,
          signal,
          onAttempt: (model, attempt) => onEvent('image_attempt', {
            providerId: provider.id,
            provider: provider.name,
            model: model.name,
            attempt
          })
        });
        provider.markSuccess?.({ latencyMs: result.latencyMs, model: result.model, resolvedModel: result.resolvedModel });
        const context = {
          estimatedTokens: result.usage?.inputTokens || 0,
          canonicalTokens: result.usage?.inputTokens || 0,
          retainedMessages: conversation.messages.length,
          totalMessages: conversation.messages.length,
          compactedMessages: 0,
          savedTokens: 0,
          memoryRetainedPercent: 100,
          projectFiles: 0,
          projectTotalFiles: projectContext?.totalFiles || 0
        };
        const final = {
          ...result,
          providerId: provider.id,
          provider: provider.name,
          requestedModel: result.model,
          context,
          attempts: result.attempts || [],
          freeVerified: true
        };
        onEvent('image_complete', {
          providerId: provider.id,
          provider: provider.name,
          model: result.resolvedModel,
          latencyMs: result.latencyMs,
          imageCount: result.generatedImages?.length || 0
        });
        onEvent('complete', {
          providerId: provider.id, provider: provider.name, model: result.resolvedModel,
          latencyMs: result.latencyMs, usage: result.usage, context, freeVerified: true
        });
        return final;
        } catch (error) {
          if (signal?.aborted || error?.code === 'request_cancelled') {
            error.usage ||= finalUsage(usageLedger, requestBudget);
            error.task ||= taskContract;
            throw error;
          }
          const attempts = error.attempts?.length
            ? error.attempts.map(attempt => ({ providerId: provider.id, provider: provider.name, ...attempt }))
            : [{ providerId: provider.id, provider: provider.name, error: safeError(error) }];
          imageAttempts.push(...attempts);
          const next = this.imageProviders[index + 1];
          if (next) onEvent('image_fallback', {
            providerId: provider.id,
            provider: provider.name,
            reason: safeError(error),
            nextProvider: next.name
          });
        }
      }
      throw new GenesisUnavailableError('Nenhuma rota remota gratuita conseguiu gerar a imagem neste momento.', imageAttempts);
    }

    assertWithinDeadline();
    let routes = await this.candidates(normalizedMode, conversation.lastProviderId, requirements, signal, taskProfile);
    const configured = this.providers.some(provider => provider.publicStatus().configured === true);
    if (!routes.length && configured && !signal?.aborted) {
      await this.refreshProviders();
      routes = await this.candidates(normalizedMode, conversation.lastProviderId, requirements, signal, taskProfile);
    }
    let crossRouteToolMessages = structuredClone(_toolContinuityMessages || []);
    const recover = async message => {
      assertWithinDeadline();
      if (!configured || _recoveryRound >= this.recoveryDelaysMs.length) {
        const unavailable = new GenesisUnavailableError(message, _attempts);
        unavailable.usage = finalUsage(usageLedger, requestBudget);
        unavailable.task = taskContract;
        unavailable.evidence = structuredClone(_taskEvidence);
        throw unavailable;
      }
      const delayMs = this.recoveryDelaysMs[_recoveryRound];
      if (Date.now() + delayMs >= deadlineAt) throw deadlineError();
      onEvent('recovery', {
        round: _recoveryRound + 1,
        delayMs,
        message: 'Atualizando as rotas e aguardando uma nova janela gratuita sem perder o contexto.'
      });
      await waitForRecovery(delayMs, signal);
      await this.refreshProviders();
      return this.respond({
        conversation, mode: normalizedMode, onEvent, signal, projectContext, supremeMind, tools, toolExecutor, userMemoryContext, interfaceLanguage, turnContext,
        taskContract, localResponse,
        _recoveryRound: _recoveryRound + 1, _attempts, _requestBudget: requestBudget, _usageLedger: usageLedger,
        _taskEvidence, _toolContinuityMessages: crossRouteToolMessages, _deadlineAt: deadlineAt
      });
    };
    if (!routes.length) {
      if (configured) return recover('As rotas gratuitas continuam ocupadas após a recuperação automática.');
      throw new GenesisUnavailableError(configured
        ? 'As rotas gratuitas estão temporariamente ocupadas. Aguarde um instante e tente novamente.'
        : 'Conecte sua chave e carregue ao menos um modelo gratuito.');
    }

    if (_recoveryRound > 0) {
      routes.sort((left, right) => {
        const leftRouter = left.candidate.model === 'openrouter/free' ? 1 : 0;
        const rightRouter = right.candidate.model === 'openrouter/free' ? 1 : 0;
        return rightRouter - leftRouter || right.routeScore - left.routeScore;
      });
      const router = routes.find(route => route.candidate.model === 'openrouter/free');
      routes = [router, ...routes.filter(route => route !== router).slice(0, 4)].filter(Boolean);
    }

    const attempts = _attempts;
    const attemptedRoutes = new Set();
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      assertWithinDeadline();
      if (signal?.aborted) throw Object.assign(new Error('Solicitação interrompida pelo usuário.'), { code: 'request_cancelled', category: 'cancelled' });
      const { provider, candidate } = routes[routeIndex];
      const routeKey = `${provider.id}:${candidate.model}`;
      if (attemptedRoutes.has(routeKey)) continue;
      for (const [retry, scale] of [1, 0.48].entries()) {
        // Use intent-aware incremental context building
        const previousContext = retry === 0 ? this._contextCache.get(conversation.id) : null;
        if (previousContext) this.rememberContext(conversation.id, previousContext);
        const context = await this.contextEngine.buildIncremental({
          conversation, query, contextWindow: candidate.contextWindow,
          mode: normalizedMode, budgetScale: scale, projectContext, userMemoryContext, interfaceLanguage, turnContext,
          supremeMind,
          previousContext: previousContext ? { ...previousContext, messageIds: previousContext.messageIds } : null
        });
        // Cache the context for next turn
        if (retry === 0 && !context.reused) {
          this.rememberContext(conversation.id, { ...context, messageIds: currentMessageIds });
        }

        onEvent('stream_reset', { providerId: provider.id, model: candidate.displayName });
        onEvent('attempt', {
          providerId: provider.id, provider: provider.name, model: candidate.displayName,
          inputTokens: context.estimatedTokens, savedTokens: context.savedTokens,
          contextWindow: candidate.contextWindow,
          attempt: attempts.length + 1, compactRetry: retry > 0, projectFiles: context.projectFiles,
          intent, intentLabel, budgetAllocation: context.budgetAllocation, cacheHit: context.reused === true
        });
        try {
          const workingMessages = structuredClone(context.messages);
          if (crossRouteToolMessages.length) {
            workingMessages.push({
              role: 'system',
              content: 'Continuidade entre rotas gratuitas: as leituras e operações abaixo já ocorreram nesta mesma tarefa. Preserve essas evidências, não reinicie a exploração e prossiga da fase pendente.'
            });
            workingMessages.push(...structuredClone(crossRouteToolMessages));
          }
          let totalLatencyMs = 0;
          let result = null;
          let lastRoundUsage = {};
          const deniedToolCalls = new Set();
          const executedToolCalls = new Set();
          const maxToolBatches = Math.max(0, Math.min(
            Number(taskContract?.toolPolicy?.maxBatches ?? Math.max(0, this.maxToolRounds - 1)),
            Math.max(0, this.maxToolRounds - 1)
          ));
          const maxCallsPerBatch = Math.max(1, Number(taskContract?.toolPolicy?.maxCallsPerBatch || 4));
          const maxResultCharacters = Math.max(800, Number(taskContract?.toolPolicy?.maxResultCharacters || 12_000));
          const maxTaskResultCharacters = Math.max(maxResultCharacters, Number(taskContract?.toolPolicy?.maxTaskResultCharacters || 24_000));
          const maxRequestInputTokens = Math.max(1_200, Number(taskContract?.requestBudget?.maxRequestInputTokens || context.inputBudget || 12_000));
          const reserveFinal = Math.max(0, Number(taskContract?.requestBudget?.reserveFinal ?? 1));
          let toolBatches = 0;
          let toolResultCharacters = 0;
          let synthesisPrompted = false;
          let mutationPrompted = false;
          let verificationPrompted = false;
          const routeRoundLimit = Math.min(this.maxToolRounds, Math.max(1, requestBudget.limit));
          for (let toolRound = 0; toolRound < routeRoundLimit; toolRound += 1) {
            assertWithinDeadline();
            const lowInputBudget = requestBudget.remainingInputTokens !== null
              && requestBudget.remainingInputTokens < Math.max(2_000, Math.floor(maxRequestInputTokens * 0.8));
            const mutationRequired = ['change', 'fix'].includes(taskContract?.kind);
            const mutationDone = hasSuccessfulEvidence(
              _taskEvidence,
              item => MUTATION_TOOL_NAMES.has(item.tool)
            );
            const checkToolAvailable = tools.some(tool => tool?.function?.name === 'run_project_check');
            const verificationDone = hasSuccessfulEvidence(
              _taskEvidence,
              item => item.tool === 'run_project_check'
            );
            // Enquanto a alteração obrigatória não aconteceu, a última chamada deve
            // continuar disponível para escrever. Uma síntese em texto nunca vale mais
            // que a mutação real solicitada pelo usuário.
            const phaseReserveFinal = mutationRequired && !mutationDone ? 0 : reserveFinal;
            const availableToolBatches = toolBatches + Math.max(0, Math.min(
              routeRoundLimit - toolRound - 1,
              requestBudget.remaining - phaseReserveFinal
            ));
            const reservedMutationBatches = mutationRequired && !mutationDone ? 1 : 0;
            const reservedVerificationBatches = mutationRequired && checkToolAvailable && !verificationDone ? 1 : 0;
            const explorationLimit = Math.max(0, Math.min(
              maxToolBatches,
              availableToolBatches - reservedMutationBatches - reservedVerificationBatches
            ));
            const mutationPhase = mutationRequired
              && !mutationDone
              && (toolBatches >= explorationLimit || lowInputBudget);
            const verificationPhase = mutationRequired
              && mutationDone
              && checkToolAvailable
              && !verificationDone
              && toolBatches < availableToolBatches;
            const explorationPhase = !mutationPhase
              && !verificationPhase
              && toolBatches < explorationLimit
              && !lowInputBudget;
            const canUseTools = requirements.tools
              && requestBudget.remaining > phaseReserveFinal
              && (explorationPhase || mutationPhase || verificationPhase);
            let roundTools = [];
            if (canUseTools && mutationPhase) {
              roundTools = tools.filter(tool => MUTATION_TOOL_NAMES.has(tool?.function?.name));
              if (!mutationPrompted) {
                workingMessages.push({
                  role: 'system',
                  content: 'Fase obrigatória de execução: a exploração terminou e nenhuma alteração foi aplicada ainda. Use agora uma das ferramentas de escrita disponíveis para executar o pedido no projeto. Não responda apenas com instruções ou código em texto.'
                });
                mutationPrompted = true;
              }
            } else if (canUseTools && verificationPhase) {
              roundTools = tools.filter(tool => tool?.function?.name === 'run_project_check');
              if (!verificationPrompted) {
                workingMessages.push({
                  role: 'system',
                  content: 'A alteração foi aplicada. Execute agora a verificação disponível do projeto antes de concluir.'
                });
                verificationPrompted = true;
              }
            } else if (canUseTools) {
              roundTools = tools;
            }
            if (requirements.tools && !roundTools.length && toolBatches > 0 && !synthesisPrompted) {
              workingMessages.push({
                role: 'system',
                content: mutationRequired && !mutationDone
                  ? 'Não foi possível reservar uma chamada segura para escrita. Não afirme que alterou arquivos; informe objetivamente a limitação.'
                  : 'O orçamento de ferramentas foi concluído. Não solicite mais ferramentas. Sintetize agora a resposta final usando somente as evidências verificadas e indique qualquer limitação.'
              });
              synthesisPrompted = true;
            }
            const remainingReservedCalls = mutationPhase
              ? 1 + (checkToolAvailable ? 1 : 0)
              : verificationPhase ? 1 : 0;
            const reservedInputTokens = remainingReservedCalls * 1_200;
            const requestTokenLimit = requestBudget.remainingInputTokens === null
              ? maxRequestInputTokens
              : Math.max(1_200, Math.min(
                maxRequestInputTokens,
                Math.max(1_200, requestBudget.remainingInputTokens - reservedInputTokens)
              ));
            const toolSchemaTokens = estimateTokens(JSON.stringify(roundTools));
            const requestMessages = compactMessagesForRequest(workingMessages, Math.max(600, requestTokenLimit - toolSchemaTokens - 32));
            const estimatedRequestTokens = estimateRequestTokens(requestMessages, roundTools);
            if (estimatedRequestTokens > requestTokenLimit) {
              const error = new Error(`A requisição exigiria ${estimatedRequestTokens} tokens, acima do teto individual de ${requestTokenLimit}.`);
              error.category = 'context';
              error.code = 'request_input_limit_exceeded';
              error.retryable = false;
              throw error;
            }
            const providerHandlesBudget = provider.handlesRequestBudget === true;
            if (!providerHandlesBudget) requestBudget.consume({
              providerId: provider.id,
              model: candidate.model,
              kind: toolRound ? 'tool-follow-up' : 'completion',
              estimatedInputTokens: estimatedRequestTokens
            });
            const usedBefore = requestBudget.used;
            onEvent('inference_start', {
              taskId: taskContract?.id || null,
              requestNumber: usedBefore + (providerHandlesBudget ? 1 : 0),
              providerId: provider.id,
              provider: provider.name,
              model: candidate.displayName,
              kind: toolRound ? (roundTools.length ? 'tool-follow-up' : 'final-synthesis') : 'completion',
              estimatedInputTokens: estimatedRequestTokens,
              toolsEnabled: roundTools.map(tool => tool.function.name),
              budget: requestBudget.snapshot()
            });
            try {
              result = await provider.generate({
                candidate, messages: requestMessages,
                maxOutputTokens: Math.min(this.outputTokenBudget, candidate.outputLimit || this.outputTokenBudget),
                temperature: MODES[normalizedMode].temperature, sessionId: conversation.id, signal,
                tools: roundTools, requestBudget, deadlineAt,
                requestKind: toolRound ? 'tool-follow-up' : 'completion',
                onDelta: roundTools.length ? null : delta => onEvent('delta', { content: delta })
              });
            } finally {
              if (providerHandlesBudget && requestBudget.used === usedBefore) requestBudget.consume({
                providerId: provider.id,
                model: candidate.model,
                kind: toolRound ? 'tool-follow-up' : 'completion',
                estimatedInputTokens: estimatedRequestTokens
              });
            }
            lastRoundUsage = recordUsage(usageLedger, result.usage, {
              inputTokens: estimatedRequestTokens,
              outputTokens: estimateTokens(result.content)
            }, {
              requestNumber: requestBudget.used,
              providerId: provider.id,
              model: result.resolvedModel || candidate.model
            });
            onEvent('inference_complete', {
              taskId: taskContract?.id || null,
              requestNumber: requestBudget.used,
              providerId: provider.id,
              model: result.resolvedModel || candidate.model,
              finishReason: result.finishReason,
              latencyMs: result.latencyMs,
              usage: lastRoundUsage,
              toolCallCount: result.toolCalls?.length || 0,
              budget: requestBudget.snapshot()
            });
            totalLatencyMs += Number(result.latencyMs || 0);
            if (!result.toolCalls?.length) {
              if (mutationPhase && !mutationDone && requestBudget.remaining > 0) {
                if (result.content) workingMessages.push({ role: 'assistant', content: result.content });
                workingMessages.push({
                  role: 'system',
                  content: 'A resposta anterior não executou a alteração obrigatória. Não finalize em texto. Chame agora uma das ferramentas de escrita habilitadas e aplique a mudança real no projeto.'
                });
                result = null;
                continue;
              }
              break;
            }

            if (!roundTools.length) {
              const error = new Error('O modelo tentou solicitar uma ferramenta depois do encerramento do orçamento de exploração.');
              error.category = 'model';
              error.code = 'tool_after_budget';
              throw error;
            }

            workingMessages.push({
              role: 'assistant',
              content: result.content || null,
              tool_calls: result.toolCalls
            });
            const allowedCalls = result.toolCalls.slice(0, maxCallsPerBatch);
            const enabledToolNames = new Set(roundTools.map(tool => tool?.function?.name).filter(Boolean));
            let rejectedPhaseTool = false;
            for (let callIndex = 0; callIndex < result.toolCalls.length; callIndex += 1) {
              const toolCall = result.toolCalls[callIndex];
              if (signal?.aborted) throw Object.assign(new Error('Solicitação interrompida pelo usuário.'), { code: 'request_cancelled', category: 'cancelled' });
              const signature = toolCallSignature(toolCall);
              let toolResult;
              if (!allowedCalls.includes(toolCall)) {
                toolResult = { ok: false, skipped: true, message: `O lote foi limitado a ${maxCallsPerBatch} ferramentas para proteger o orçamento.` };
              } else if (!enabledToolNames.has(toolCall.function.name)) {
                rejectedPhaseTool = true;
                toolResult = {
                  ok: false,
                  skipped: true,
                  code: 'tool_not_enabled_for_phase',
                  message: `A ferramenta “${toolCall.function.name}” não está habilitada nesta fase. Use somente: ${[...enabledToolNames].join(', ') || 'nenhuma ferramenta'}.`
                };
              } else if (deniedToolCalls.has(signature)) {
                toolResult = { ok: false, denied: true, message: 'Esta mesma operação já foi negada pelo usuário nesta tarefa.' };
              } else if (executedToolCalls.has(signature)) {
                toolResult = { ok: false, duplicate: true, message: 'Esta operação já foi executada nesta tarefa; use o resultado anterior.' };
              } else {
                executedToolCalls.add(signature);
                toolResult = await toolExecutor(toolCall, { signal });
              }
              if (toolResult?.denied) deniedToolCalls.add(signature);
              _taskEvidence.push({
                timestamp: new Date().toISOString(),
                tool: toolCall.function.name,
                arguments: sanitizeModelText(toolCall.function.arguments, { maxCharacters: 1_200 }).text,
                ok: toolResult?.ok === true,
                denied: toolResult?.denied === true,
                skipped: toolResult?.skipped === true,
                duplicate: toolResult?.duplicate === true,
                summary: String(toolResult?.summary || toolResult?.message || toolResult?.error || '').slice(0, 500),
                code: toolResult?.code || null
              });
              const remainingResultCharacters = Math.max(0, maxTaskResultCharacters - toolResultCharacters);
              const compacted = compactToolResult(toolResult, Math.min(maxResultCharacters, remainingResultCharacters));
              toolResultCharacters += compacted.characters;
              workingMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
                content: compacted.content
              });
            }
            if (rejectedPhaseTool && mutationPhase) {
              workingMessages.push({
                role: 'system',
                content: 'A leitura solicitada foi recusada porque a fase de exploração terminou. Não leia mais arquivos agora. Use uma ferramenta de escrita habilitada e execute a alteração solicitada.'
              });
            }
            toolBatches += 1;
            crossRouteToolMessages = workingMessages
              .filter(message => message.role === 'tool' || (message.role === 'assistant' && message.tool_calls?.length))
              .slice(-Math.max(2, maxToolBatches * 2));
            result = null;
          }
          if (!result?.content) {
            const mutationDoneAfterRounds = hasSuccessfulEvidence(
              _taskEvidence,
              item => MUTATION_TOOL_NAMES.has(item.tool)
            );
            if (['change', 'fix'].includes(taskContract?.kind) && mutationDoneAfterRounds) {
              result = {
                content: localMutationCompletionReport(_taskEvidence),
                model: candidate.model,
                resolvedModel: candidate.model,
                resolvedProvider: provider.name,
                latencyMs: totalLatencyMs,
                finishReason: 'stop',
                usage: {}
              };
            } else {
              const error = new Error('O modelo excedeu o limite seguro de etapas de ferramenta.');
              error.category = 'model';
              error.code = 'tool_round_limit';
              throw error;
            }
          }

          for (let continuation = 0; continuation < 2 && result.finishReason === 'length' && requestBudget.remaining > 0; continuation += 1) {
            assertWithinDeadline();
            const partial = result.content;
            onEvent('continuation', { round: continuation + 1, message: 'A resposta atingiu o limite do modelo; continuando do ponto exato sem repetir o texto.' });
            const partialTail = sanitizeModelText(partial.slice(-8_000), {
              maxCharacters: 8_000,
              maxLineCharacters: 2_000
            }).text;
            const continuationWorkingMessages = [
              ...workingMessages,
              {
                role: 'assistant',
                content: partial.length > partialTail.length
                  ? `[Trecho anterior já preservado localmente; continue a partir desta cauda:]\n${partialTail}`
                  : partialTail
              },
              { role: 'user', content: 'Continue exatamente de onde parou, sem repetir. Priorize concluir integralmente dentro desta resposta.' }
            ];
            const continuationTokenLimit = requestBudget.remainingInputTokens === null
              ? maxRequestInputTokens
              : Math.max(1_200, Math.min(maxRequestInputTokens, requestBudget.remainingInputTokens));
            const continuationMessages = compactMessagesForRequest(continuationWorkingMessages, continuationTokenLimit);
            const estimatedContinuationTokens = estimateRequestTokens(continuationMessages, []);
            if (estimatedContinuationTokens > continuationTokenLimit) {
              result = {
                ...result,
                content: `${partial}\n\n[O Genesis encerrou a continuação antes de exceder o teto individual de contexto.]`,
                finishReason: 'length'
              };
              break;
            }
            const providerHandlesBudget = provider.handlesRequestBudget === true;
            if (!providerHandlesBudget) requestBudget.consume({
              providerId: provider.id, model: candidate.model, kind: 'continuation', estimatedInputTokens: estimatedContinuationTokens
            });
            const usedBefore = requestBudget.used;
            let next;
            try {
              next = await provider.generate({
                candidate, messages: continuationMessages,
                maxOutputTokens: Math.min(this.outputTokenBudget, candidate.outputLimit || this.outputTokenBudget),
                temperature: MODES[normalizedMode].temperature, sessionId: conversation.id, signal,
                tools: [], requestBudget, requestKind: 'continuation', deadlineAt,
                onDelta: delta => onEvent('delta', { content: delta })
              });
            } finally {
              if (providerHandlesBudget && requestBudget.used === usedBefore) requestBudget.consume({
                providerId: provider.id, model: candidate.model, kind: 'continuation', estimatedInputTokens: estimatedContinuationTokens
              });
            }
            lastRoundUsage = recordUsage(usageLedger, next.usage, {
              inputTokens: estimatedContinuationTokens,
              outputTokens: estimateTokens(next.content)
            }, {
              requestNumber: requestBudget.used,
              providerId: provider.id,
              model: next.resolvedModel || candidate.model
            });
            totalLatencyMs += Number(next.latencyMs || 0);
            result = { ...next, content: joinContinuation(partial, next.content) };
          }

          if (result.finishReason === 'length') {
            result = {
              ...result,
              finishReason: 'partial',
              content: `${result.content}\n\n> O modelo gratuito atingiu o limite de saída mesmo após as continuações protegidas. A entrega foi marcada como parcial, nunca como concluída.`
            };
          }

          result.usage = finalUsage(usageLedger, requestBudget);
          result.latencyMs = totalLatencyMs;
          const verification = verifyTaskOutcome({
            contract: taskContract,
            response: result,
            evidence: _taskEvidence,
            usage: result.usage
          });
          onEvent('verification', { taskId: taskContract?.id || null, verification });
          if (verification.status === 'failed') {
            const verificationError = new Error(verification.summary || 'A entrega não atendeu aos critérios obrigatórios da tarefa.');
            verificationError.code = 'task_verification_failed';
            verificationError.category = 'verification';
            verificationError.retryable = false;
            verificationError.usage = result.usage;
            verificationError.task = taskContract;
            verificationError.verification = verification;
            verificationError.providerId = provider.id;
            verificationError.provider = provider.name;
            verificationError.model = result.resolvedModel || candidate.model;
            verificationError.partialContent = result.content;
            verificationError.evidence = structuredClone(_taskEvidence);
            verificationError.attempts = [
              ...attempts,
              {
                providerId: provider.id,
                provider: provider.name,
                model: result.resolvedModel || candidate.model,
                error: safeError(verificationError)
              }
            ];
            throw verificationError;
          }
          provider.markSuccess({ latencyMs: result.latencyMs, model: candidate.model, resolvedModel: result.resolvedModel });
          const resolvedCatalogModel = provider.catalog?.find(model => model.id === result.resolvedModel);
          const contextWindow = Number(resolvedCatalogModel?.contextWindow || candidate.contextWindow || context.contextWindow || 32768);
          const usedTokens = Number(lastRoundUsage.totalTokens || ((lastRoundUsage.inputTokens || context.estimatedTokens) + (lastRoundUsage.outputTokens || 0)));
          const measuredContext = {
            ...contextMetrics(context),
            contextWindow,
            usedTokens,
            remainingTokens: Math.max(0, contextWindow - usedTokens),
            totalRequestTokens: Number(result.usage?.totalTokens || 0),
            requestCount: result.usage.requestCount,
            usageAccuracy: result.usage.accuracy,
            toolBatches,
            toolResultCharacters,
            requestBudget: requestBudget.snapshot(),
            task: taskContract,
            verification,
            evidence: _taskEvidence.slice(-30)
          };
          const final = {
            ...result, providerId: provider.id, provider: provider.name,
            requestedModel: candidate.model, context: measuredContext, attempts,
            freeVerified: candidate.freeVerified === true,
            task: taskContract,
            verification
          };
          onEvent('complete', {
            providerId: provider.id, provider: provider.name, model: result.resolvedModel,
            latencyMs: result.latencyMs, usage: result.usage, context: measuredContext, freeVerified: true
          });
          return final;
        } catch (error) {
          recordFailedRequestUsage(error, usageLedger, requestBudget, provider, candidate);
          if (signal?.aborted || error?.code === 'request_cancelled') {
            error.usage ||= finalUsage(usageLedger, requestBudget);
            error.task ||= taskContract;
            throw error;
          }
          if (error?.code === 'task_verification_failed') {
            error.usage ||= finalUsage(usageLedger, requestBudget);
            error.task ||= taskContract;
            throw error;
          }
          const budgetFailure = ['request_budget_exhausted', 'input_token_budget_exhausted'].includes(error?.code);
          if (!budgetFailure && error.category !== 'context') provider.markFailure(error);
          attempts.push({ providerId: provider.id, provider: provider.name, model: candidate.model, error: safeError(error) });
          if (budgetFailure) {
            const exhausted = new GenesisUnavailableError(error?.code === 'input_token_budget_exhausted'
              ? 'O teto cumulativo de tokens da tarefa foi atingido. O Genesis encerrou novas chamadas para proteger sua chave.'
              : 'O orçamento seguro de requisições desta mensagem foi atingido antes de surgir uma resposta completa. Tente novamente para abrir um novo orçamento sem consumir a chave em flood.', attempts);
            exhausted.code = error.code;
            exhausted.category = 'budget';
            exhausted.usage = finalUsage(usageLedger, requestBudget);
            exhausted.task = taskContract;
            exhausted.evidence = structuredClone(_taskEvidence);
            throw exhausted;
          }
          if (error.category === 'context' && retry === 0) {
            onEvent('compact', { providerId: provider.id, message: 'O contexto excedeu o limite; recompondo uma cápsula menor sem apagar a memória.' });
            continue;
          }
          attemptedRoutes.add(routeKey);
          onEvent('fallback', {
            providerId: provider.id, provider: provider.name, reason: safeError(error),
            nextProvider: routes[routeIndex + 1]?.candidate?.displayName || null
          });
          break;
        }
      }
    }
    if (requestBudget.remaining <= 0) {
      const exhausted = new GenesisUnavailableError('As rotas gratuitas foram encerradas no limite seguro de requisições, sem floodar a sua chave.', attempts);
      exhausted.code = 'request_budget_exhausted';
      exhausted.category = 'budget';
      exhausted.usage = finalUsage(usageLedger, requestBudget);
      exhausted.task = taskContract;
      exhausted.evidence = structuredClone(_taskEvidence);
      throw exhausted;
    }
    return recover('A recuperação automática não encontrou uma rota gratuita capaz de concluir esta solicitação agora.');
  }
}
