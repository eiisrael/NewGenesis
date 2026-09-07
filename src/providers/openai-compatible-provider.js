import { BaseProvider } from './base-provider.js';
import { assertFreeOpenRouterModels, isFreeOpenRouterModel } from '../core/policy.js';
import { ProviderError } from '../core/errors.js';
import { estimateRequestTokens } from '../core/context-engine.js';
import { allowParallelProjectToolCalls, projectToolChoice } from '../core/project-tool-policy.js';
import { parseImageGenerationRequest } from '../core/image-request.js';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

function normalizeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(call => call?.id && call?.function?.name).map(call => ({
    id: String(call.id),
    type: 'function',
    function: {
      name: String(call.function.name),
      arguments: typeof call.function.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call.function.arguments || {})
    }
  }));
}

function containsRawToolMarkup(content) {
  return /<tool_call>|<command>|<\/result>/i.test(String(content || ''));
}

function isTextModel(model) {
  const id = String(model.id || '').toLowerCase();
  return !['whisper', 'tts', 'guard', 'safeguard', 'moderation', 'embed', 'content-safety'].some(term => id.includes(term));
}

function messagesContain(messages, type) {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part => part?.type === type));
}

const optionalNumber = value => value === null || value === undefined || value === '' ? null : Number(value);
const ERROR_FINISH_REASONS = new Set(['error', 'failed', 'failure', 'provider_error']);
const MIN_USEFUL_ROUTE_MS = 1000;

function isErrorFinishReason(value) {
  return ERROR_FINISH_REASONS.has(String(value || '').trim().toLowerCase());
}

function normalizeUsage(value = {}) {
  return {
    inputTokens: Number(value.inputTokens ?? value.prompt_tokens ?? 0),
    outputTokens: Number(value.outputTokens ?? value.completion_tokens ?? 0),
    totalTokens: Number(value.totalTokens ?? value.total_tokens ?? 0),
    reasoningTokens: Number(value.reasoningTokens ?? value.completion_tokens_details?.reasoning_tokens ?? 0),
    cachedTokens: Number(value.cachedTokens ?? value.prompt_tokens_details?.cached_tokens ?? 0),
    cost: Number(value.cost || 0)
  };
}

function hasUsage(value) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length);
}

function streamFailure(providerId, finishReason, usage, detail = '') {
  const error = new ProviderError('A rota gratuita encerrou o fluxo com erro antes de concluir a resposta.', {
    providerId, category: 'availability', code: 'stream_error'
  });
  error.finishReason = String(finishReason || 'error');
  if (detail) error.providerDetail = String(detail).slice(0, 300);
  if (hasUsage(usage)) error.usage = normalizeUsage(usage);
  return error;
}

function incompleteStreamFailure(providerId, usage) {
  const error = new ProviderError('A rota gratuita encerrou a conexão sem confirmar o término da resposta.', {
    providerId, category: 'availability', code: 'incomplete_stream'
  });
  error.finishReason = null;
  if (hasUsage(usage)) error.usage = normalizeUsage(usage);
  return error;
}

function withUsage(error, usage) {
  if (hasUsage(usage)) error.usage = normalizeUsage(usage);
  return error;
}

function deadlineTimeout(defaultTimeoutMs, deadlineAt, providerId) {
  const fallback = Math.max(MIN_USEFUL_ROUTE_MS, Number(defaultTimeoutMs) || MIN_USEFUL_ROUTE_MS);
  if (deadlineAt === null || deadlineAt === undefined || deadlineAt === '') return fallback;
  const deadline = Number(deadlineAt);
  if (!Number.isFinite(deadline)) return fallback;
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < MIN_USEFUL_ROUTE_MS) {
    throw new ProviderError('O prazo global da tarefa terminou antes de uma nova rota poder ser iniciada.', {
      providerId, category: 'timeout', code: 'provider_deadline_exceeded', retryable: false
    });
  }
  return Math.min(fallback, remaining);
}

function imageCapability(model, name) {
  const supported = model?.supportedParameters;
  if (Array.isArray(supported)) return supported.includes(name) ? { type: 'boolean' } : null;
  if (!supported || typeof supported !== 'object') return null;
  return Object.hasOwn(supported, name) ? supported[name] ?? { type: 'boolean' } : null;
}

function enumChoice(capability, preferred = []) {
  const values = Array.isArray(capability?.values) ? capability.values.map(String) : [];
  return preferred.find(value => values.includes(value)) || null;
}

function requestedAspectRatio(prompt, capability) {
  const text = String(prompt || '').toLowerCase();
  const preferred = /\b(story|stories|reels?|tiktok|vertical|retrato|9\s*:\s*16)\b/.test(text)
    ? ['9:16', '4:5', '3:4']
    : /\b(banner|capa|youtube|horizontal|paisagem|widescreen|16\s*:\s*9)\b/.test(text)
      ? ['16:9', '3:2', '4:3']
      : /\b(logo|icone|avatar|perfil|quadrad|1\s*:\s*1)\b/.test(text)
        ? ['1:1']
        : ['1:1', '4:3', '3:4'];
  return enumChoice(capability, preferred);
}

function imageRequestBody(model, request) {
  const body = { model: model.id, prompt: request.prompt, n: 1 };
  const output = imageCapability(model, 'output_format');
  const outputFormat = enumChoice(output, ['png', 'webp', 'jpeg']);
  if (outputFormat) body.output_format = outputFormat;
  else if (output) body.output_format = 'png';

  const resolution = enumChoice(imageCapability(model, 'resolution'), ['1K', '1024', '1024x1024', '512']);
  if (resolution) body.resolution = resolution;
  const aspectRatio = requestedAspectRatio(request.prompt, imageCapability(model, 'aspect_ratio'));
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  const quality = enumChoice(imageCapability(model, 'quality'), ['high', 'medium', 'auto']);
  if (quality) body.quality = quality;

  if (request.references.length) {
    const capability = imageCapability(model, 'input_references');
    const maxReferences = Math.max(1, Math.min(5, Number(capability?.max || 1)));
    body.input_references = request.references.slice(0, maxReferences).map(url => ({
      type: 'image_url', image_url: { url }
    }));
  }
  return body;
}

export function modelScore(model, mode, taskProfile = {}) {
  const id = `${model.id || ''} ${model.name || ''} ${model.description || ''}`.toLowerCase();
  let score = Math.min(24, Math.log2(Math.max(2048, model.contextWindow || 8192)) * 1.6);
  const quality = [
    ['qwen3-next', 32], ['llama-3.3-70b', 31], ['gemma-4-31b', 29],
    ['nemotron-3-super', 28], ['405b', 27], ['gemma-4-26b', 25],
    ['nemotron-3-ultra', 24], ['poolside', 22], ['nemotron-3-nano-omni', 21],
    ['nemotron-nano', 18], ['gpt-oss-20b', 17]
  ];
  for (const [term, value] of quality) if (id.includes(term)) score += value;
  const intentMode = taskProfile.intent && mode === 'balanced'
    ? ({ CODE: 'code', DEBUG: 'code', REFACTOR: 'code', ARCHITECTURE: 'reasoning', ANALYSIS: 'reasoning', RESEARCH: 'reasoning', PERFORMANCE: 'reasoning' }[taskProfile.intent] || mode)
    : mode;
  const boosts = {
    code: [['qwen3-coder', 58], ['north-mini-code', 62], ['coder', 38], ['laguna', 20], ['qwen', 24]],
    reasoning: [['nemotron-3-ultra', 44], ['nemotron-3-super', 40], ['405b', 36], ['qwen3-next', 35], ['reason', 32], ['nemotron-3-nano-omni', 28]],
    fast: [['laguna-xs', 46], ['nano-9b', 40], ['nano-30b', 36], ['20b', 32], ['mini', 30], ['3b', 28]],
    balanced: [['qwen3-next', 31], ['llama-3.3-70b', 30], ['gemma-4-31b', 27], ['poolside', 28], ['nemotron-3-super', 18], ['405b', 20]]
  }[intentMode] || [];
  for (const [term, value] of boosts) if (id.includes(term)) score += value;
  if (taskProfile.image && /vision|omni|vl\b|gemma-4|dots/.test(id)) score += 28;
  if (taskProfile.tools && model.supportedParameters?.includes('tools')) score += 18;
  if (taskProfile.longContext && (model.contextWindow || 0) >= 256000) score += 14;
  if (['change', 'fix'].includes(taskProfile.kind) && /coder|code|qwen|devstral|codestral/.test(id)) score += 24;
  if (taskProfile.kind === 'diagnose' && /reason|nemotron|qwen|llama/.test(id)) score += 14;
  if (taskProfile.complexity === 'high' && (model.contextWindow || 0) >= 128000) score += 10;
  if (taskProfile.outputFormat === 'json' && model.supportedParameters?.includes('structured_outputs')) score += 8;
  if (taskProfile.intent === 'DOCUMENTATION' && /dots|gemma|qwen/.test(id)) score += 12;
  const benchmarks = model.benchmarks?.artificial_analysis || {};
  if (intentMode === 'code' && Number.isFinite(benchmarks.coding_index)) score += Math.min(20, benchmarks.coding_index / 5);
  if (intentMode === 'reasoning' && Number.isFinite(benchmarks.intelligence_index)) score += Math.min(20, benchmarks.intelligence_index / 4);
  if (id.includes('preview')) score -= 5;
  return score;
}

export class OpenAICompatibleProvider extends BaseProvider {
  constructor(options) {
    super(options);
    this.apiKey = options.apiKey;
    this.handlesRequestBudget = true;
    this.baseUrl = options.baseUrl;
    this.configuredModels = options.models || ['openrouter/free'];
    this.isOpenRouter = options.id === 'openrouter';
    this.fallbackModel = options.fallbackModel;
    this.selectionMode = options.selectionMode === 'manual' ? 'manual' : 'automatic';
    this.selectedModel = this.selectionMode === 'manual' ? options.selectedModel : 'openrouter/free';
    this.account = null;
    this.imageCatalog = null;
    this.imageCatalogAt = 0;
    if (this.isOpenRouter) assertFreeOpenRouterModels(this.configuredModels);
    if (this.isOpenRouter) assertFreeOpenRouterModels([this.selectedModel || 'openrouter/free']);
  }

  setApiKey(value) {
    this.apiKey = String(value || '').trim();
    this.configured = Boolean(this.apiKey);
    this.catalog = null;
    this.catalogAt = 0;
    this.account = null;
    this.imageCatalog = null;
    this.imageCatalogAt = 0;
    this.health.state = this.configured ? 'ready' : 'setup';
    this.health.failureCount = 0;
    this.health.cooldownUntil = 0;
    this.health.lastError = null;
    if (typeof this.resetAllRoutes === 'function') this.resetAllRoutes();
  }

  setSelection(selectionMode, selectedModel) {
    this.selectionMode = selectionMode === 'manual' ? 'manual' : 'automatic';
    this.selectedModel = this.selectionMode === 'manual' ? String(selectedModel || '').trim() : 'openrouter/free';
    assertFreeOpenRouterModels([this.selectedModel]);
  }

  async validateKey() {
    if (!this.configured) throw new ProviderError('A chave OpenRouter não foi configurada.', {
      providerId: this.id, category: 'authentication', code: 'openrouter_not_configured'
    });
    const started = Date.now();
    const { payload } = await this.requestJson(`${this.baseUrl}/key`, { headers: this.headers() }, this.discoveryTimeoutMs);
    const data = payload?.data || {};
    this.account = {
      label: data.label || null,
      isFreeTier: data.is_free_tier === true,
      limit: Number.isFinite(optionalNumber(data.limit)) ? optionalNumber(data.limit) : null,
      limitRemaining: Number.isFinite(optionalNumber(data.limit_remaining)) ? optionalNumber(data.limit_remaining) : null,
      expiresAt: data.expires_at || null
    };
    this.markSuccess({ latencyMs: Date.now() - started });
    return this.account;
  }

  async probe() {
    if (!this.configured) return this.publicStatus();
    try {
      await this.validateKey();
      await this.models({ force: true });
    } catch (error) {
      this.markFailure(error);
    }
    return this.publicStatus();
  }

  headers() {
    const headers = { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
    if (this.isOpenRouter) {
      headers['http-referer'] = 'http://localhost:7331';
      headers['x-title'] = 'Genesis New';
      headers['x-openrouter-metadata'] = 'true';
    }
    return headers;
  }

  async discoverModels({ signal } = {}) {
    const { payload } = await this.requestJson(`${this.baseUrl}/models`, { headers: this.headers(), signal }, this.discoveryTimeoutMs);
    const source = Array.isArray(payload?.data) ? payload.data : [];
    return source.filter(isTextModel).filter(model => !this.isOpenRouter || isFreeOpenRouterModel(model.id)).map(model => ({
      id: model.id,
      name: model.name || model.id,
      contextWindow: Number(model.context_length || model.context_window || 32768),
      supportedParameters: model.supported_parameters || [],
      inputModalities: Array.isArray(model.architecture?.input_modalities) ? model.architecture.input_modalities : ['text'],
      outputModalities: Array.isArray(model.architecture?.output_modalities) ? model.architecture.output_modalities : ['text'],
      outputLimit: Number(model.top_provider?.max_completion_tokens || 0) || null,
      description: String(model.description || ''),
      tokenizer: model.architecture?.tokenizer || null,
      benchmarks: model.benchmarks || null,
      freeVerified: true
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  candidate(model, catalog, mode, taskProfile = {}) {
    const known = catalog.find(item => item.id === model);
    return {
      providerId: this.id,
      model,
      displayName: known?.name || (model === 'openrouter/free' ? 'Free Models Router' : model),
      contextWindow: known?.contextWindow || 32768,
      inputModalities: known?.inputModalities || (model === 'openrouter/free' ? ['text', 'image', 'file'] : ['text']),
      supportsTools: model === 'openrouter/free' || known?.supportedParameters?.includes('tools'),
      supportedParameters: known?.supportedParameters || [],
      outputLimit: known?.outputLimit || null,
      score: modelScore(known || { id: model, contextWindow: 32768 }, mode, taskProfile),
      freeVerified: true
    };
  }

  async resolveCandidates(mode, requirements = {}, options = {}) {
    if (!this.canAttempt()) return null;
    let catalog = [];
    try { catalog = await this.models({ signal: options.signal }); } catch (error) {
      if (error?.code === 'request_cancelled') throw error;
    }
    if (this.isOpenRouter) {
      if (this.selectionMode === 'manual') {
        const model = this.selectedModel;
        assertFreeOpenRouterModels([model]);
        const known = catalog.find(item => item.id === model);
        const candidates = [];
        const supportsImage = !requirements.image || known?.inputModalities?.includes('image');
        const supportsTools = !requirements.tools || known?.supportedParameters?.includes('tools');
        if ((known && supportsImage && supportsTools) || (!catalog.length && !requirements.image && !requirements.tools)) {
          candidates.push(this.candidate(model, catalog, mode, options.taskProfile));
        }
        if (model !== 'openrouter/free') candidates.push({ ...this.candidate('openrouter/free', catalog, mode, options.taskProfile), score: -100 });
        return candidates;
      }

      const compatible = catalog
        .filter(model => model.id !== 'openrouter/free')
        .filter(model => !requirements.image || model.inputModalities?.includes('image'))
        .filter(model => !requirements.tools || model.supportedParameters?.includes('tools'))
        .sort((a, b) => modelScore(b, mode, options.taskProfile) - modelScore(a, mode, options.taskProfile))
        .slice(0, 8)
        .map(model => this.candidate(model.id, catalog, mode, options.taskProfile));
      compatible.push({ ...this.candidate('openrouter/free', catalog, mode, options.taskProfile), score: -100 });
      return compatible;
    }
    const configured = this.configuredModels.filter(model => model !== 'auto');
    const pool = configured.length ? catalog.filter(model => configured.includes(model.id)) : catalog;
    const selected = [...pool].sort((a, b) => modelScore(b, mode) - modelScore(a, mode))[0];
    const fallback = configured[0] || this.fallbackModel;
    if (!selected && !fallback) return null;
    return [{
      providerId: this.id,
      model: selected?.id || fallback,
      displayName: selected?.name || fallback,
      contextWindow: selected?.contextWindow || 32768,
      score: modelScore(selected || { id: fallback, contextWindow: 32768 }, mode),
      freeVerified: true
    }];
  }

  async resolveCandidate(mode) {
    return (await this.resolveCandidates(mode))?.[0] || null;
  }

  async generate({ candidate, messages, maxOutputTokens, temperature, sessionId, signal, tools = [], requestBudget = null, requestKind = 'completion', onDelta = null, deadlineAt = null }) {
    if (this.isOpenRouter) assertFreeOpenRouterModels([candidate.model]);
    const estimatedInputTokens = estimateRequestTokens(messages, tools);
    const streaming = typeof onDelta === 'function' && tools.length === 0;
    const body = { model: candidate.model, messages, temperature, max_tokens: maxOutputTokens, stream: streaming };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = projectToolChoice(tools);
      body.parallel_tool_calls = allowParallelProjectToolCalls(
        tools,
        candidate.supportedParameters?.includes('parallel_tool_calls') === true
      );
    }
    if (this.isOpenRouter) {
      body.session_id = sessionId;
      body.provider = {
        allow_fallbacks: candidate.model === 'openrouter/free',
        require_parameters: tools.length > 0
      };
      if (messagesContain(messages, 'file')) {
        body.plugins = [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }];
      }
    }
    const started = Date.now();
    const hasRichContent = messagesContain(messages, 'image_url') || messagesContain(messages, 'file');
    const routeTimeoutMs = deadlineTimeout(
      Math.min(this.requestTimeoutMs, tools.length ? 45000 : hasRichContent ? 90000 : 60000),
      deadlineAt,
      this.id
    );
    requestBudget?.consume({ providerId: this.id, model: candidate.model, kind: requestKind, estimatedInputTokens });
    let payload;
    if (streaming) {
      const streamed = { content: '', model: candidate.model, provider: this.name, finishReason: null, usage: {} };
      try {
        await this.requestEventStream(`${this.baseUrl}/chat/completions`, {
          method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal
        }, chunk => {
          if (chunk.model) streamed.model = chunk.model;
          if (chunk.provider) streamed.provider = chunk.provider;
          if (chunk.usage) streamed.usage = { ...streamed.usage, ...chunk.usage };
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) streamed.finishReason = choice.finish_reason;
          if (isErrorFinishReason(choice?.finish_reason)) {
            throw streamFailure(this.id, choice.finish_reason, streamed.usage, choice?.error?.message || chunk?.message);
          }
          const delta = textContent(choice?.delta?.content);
          if (delta) { streamed.content += delta; onDelta(delta); }
        }, routeTimeoutMs);
      } catch (error) {
        const partialUsage = { ...streamed.usage, ...(hasUsage(error?.usage) ? error.usage : {}) };
        if (hasUsage(partialUsage) && error && typeof error === 'object') error.usage = normalizeUsage(partialUsage);
        throw error;
      }
      if (!streamed.finishReason) throw incompleteStreamFailure(this.id, streamed.usage);
      payload = {
        model: streamed.model,
        provider: streamed.provider,
        choices: [{ message: { content: streamed.content }, finish_reason: streamed.finishReason }],
        usage: streamed.usage
      };
    } else {
      try {
        ({ payload } = await this.requestJson(`${this.baseUrl}/chat/completions`, {
          method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal
        }, routeTimeoutMs));
      } catch (error) {
        if (hasUsage(error?.usage) && error && typeof error === 'object') error.usage = normalizeUsage(error.usage);
        throw error;
      }
    }
    const choices = payload?.choices || [];
    const message = choices[0]?.message || {};
    const finishReason = choices[0]?.finish_reason || 'stop';
    if (isErrorFinishReason(finishReason)) {
      throw streamFailure(this.id, finishReason, payload?.usage, choices[0]?.error?.message || payload?.message);
    }
    const content = textContent(message.content).trim();
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    const resolvedModel = String(payload.model || candidate.model);
    if (!isTextModel({ id: resolvedModel }) || (candidate.model === 'openrouter/free' && /^(?:user|assistant) safety:\s*(?:safe|unsafe)|^(?:safe|unsafe)$/i.test(content))) {
      throw withUsage(new ProviderError('A rota gratuita retornou um classificador em vez de uma resposta útil.', {
        providerId: this.id, category: 'model', code: 'non_generative_model'
      }), payload?.usage);
    }
    if (!toolCalls.length && containsRawToolMarkup(content)) {
      throw withUsage(new ProviderError('O modelo tentou exibir uma ferramenta como texto em vez de usar a execução segura.', {
        providerId: this.id, category: 'model', code: 'invalid_tool_markup'
      }), payload?.usage);
    }
    if (!content && !toolCalls.length) throw withUsage(new ProviderError('O modelo não retornou conteúdo.', {
      providerId: this.id, category: 'availability', code: 'empty_response'
    }), payload?.usage);
    return {
      content,
      toolCalls,
      model: candidate.model,
      resolvedModel,
      resolvedProvider: payload.provider || this.name,
      latencyMs: Date.now() - started,
      finishReason,
      usage: normalizeUsage(payload?.usage)
    };
  }

  async imageModels({ force = false, signal } = {}) {
    if (!this.configured) throw new ProviderError('A rota principal de imagem não foi configurada.', {
      providerId: this.id, category: 'authentication', code: 'openrouter_not_configured'
    });
    if (!force && this.imageCatalog && Date.now() - this.imageCatalogAt < 10 * 60 * 1000) return this.imageCatalog;
    const { payload } = await this.requestJson(`${this.baseUrl}/images/models`, { headers: this.headers(), signal }, this.discoveryTimeoutMs);
    this.imageCatalog = (Array.isArray(payload?.data) ? payload.data : [])
      .filter(model => isFreeOpenRouterModel(model.id))
      .filter(model => model.architecture?.output_modalities?.includes('image'))
      .filter(model => !String(model.id).toLowerCase().includes('vector'))
      .map(model => ({
        id: model.id,
        name: model.name || model.id,
        supportedParameters: model.supported_parameters || {},
        supportsStreaming: model.supports_streaming === true
      }));
    this.imageCatalogAt = Date.now();
    return this.imageCatalog;
  }

  async generateImage({ prompt, signal, onAttempt = () => {} }) {
    const request = parseImageGenerationRequest(prompt);
    let models = await this.imageModels({ signal });
    if (request.references.length) {
      models = models.filter(model => imageCapability(model, 'input_references'));
      if (!models.length) throw new ProviderError('Nenhum modelo gratuito de imagem com suporte a edição por referência está disponível na rota principal.', {
        providerId: this.id, category: 'availability', code: 'free_image_edit_model_unavailable'
      });
    }
    if (!models.length) throw new ProviderError('Nenhum modelo gratuito de geração de imagens está disponível na rota principal.', {
      providerId: this.id, category: 'availability', code: 'free_image_model_unavailable'
    });
    const attempts = [];
    let partialUsage = null;
    for (const model of models.slice(0, 1)) {
      if (signal?.aborted) throw Object.assign(new Error('Solicitação interrompida pelo usuário.'), { code: 'request_cancelled', category: 'cancelled' });
      onAttempt(model, attempts.length + 1);
      const started = Date.now();
      try {
        const body = imageRequestBody(model, request);
        const { payload } = await this.requestJson(`${this.baseUrl}/images`, {
          method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal
        }, Math.min(this.requestTimeoutMs, 120000));
        const images = (Array.isArray(payload?.data) ? payload.data : []).map((image, index) => {
          const base64 = String(image?.b64_json || '');
          const mimeType = String(image?.media_type || 'image/png').toLowerCase();
          if (!base64 || mimeType === 'image/svg+xml') return null;
          const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mimeType] || 'png';
          return {
            name: `genesis-${request.operation === 'edit' ? 'edit' : 'image'}-${Date.now()}-${index + 1}.${extension}`,
            mimeType: mimeType.startsWith('image/') ? mimeType : 'image/png',
            dataUrl: `data:${mimeType.startsWith('image/') ? mimeType : 'image/png'};base64,${base64}`
          };
        }).filter(Boolean);
        if (!images.length) throw withUsage(new ProviderError('O modelo gratuito não retornou uma imagem raster válida.', {
          providerId: this.id, category: 'availability', code: 'empty_image_response'
        }), payload?.usage);
        return {
          content: request.operation === 'edit'
            ? 'Imagem editada pelo Gênesis usando a referência enviada, por uma rota gratuita compatível.'
            : 'Imagem criada pelo Gênesis com um modelo gratuito compatível.',
          generatedImages: images,
          imageOperation: request.operation,
          model: model.id,
          resolvedModel: String(payload?.model || model.id),
          resolvedProvider: payload?.provider || this.name,
          latencyMs: Date.now() - started,
          finishReason: 'stop',
          attempts,
          usage: {
            inputTokens: Number(payload?.usage?.prompt_tokens || 0),
            outputTokens: Number(payload?.usage?.completion_tokens || 0),
            totalTokens: Number(payload?.usage?.total_tokens || 0)
          }
        };
      } catch (error) {
        if (signal?.aborted || error?.code === 'request_cancelled') throw error;
        if (hasUsage(error?.usage)) partialUsage = normalizeUsage(error.usage);
        attempts.push({ model: model.id, message: error?.message || 'Falha na geração.' });
      }
    }
    const error = new ProviderError(request.operation === 'edit'
      ? 'Os modelos gratuitos de edição de imagem estão temporariamente indisponíveis.'
      : 'Os modelos gratuitos de imagem estão temporariamente indisponíveis.', {
      providerId: this.id, category: 'availability', code: 'free_image_routes_exhausted'
    });
    error.attempts = attempts;
    if (partialUsage) error.usage = partialUsage;
    throw error;
  }

  publicStatus() {
    return {
      ...super.publicStatus(),
      selectionMode: this.selectionMode,
      selectedModel: this.selectedModel,
      keyLabel: this.account?.label || null,
      isFreeTier: this.account?.isFreeTier === true,
      limit: this.account?.limit ?? null,
      limitRemaining: this.account?.limitRemaining ?? null,
      expiresAt: this.account?.expiresAt || null
    };
  }
}
