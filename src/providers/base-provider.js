import { classifyProviderError, ProviderError } from '../core/errors.js';

const now = () => Date.now();
const timeoutSignal = milliseconds => AbortSignal.timeout(Math.max(1000, milliseconds));

function requestSignal(externalSignal, timeoutMs) {
  const timeout = timeoutSignal(timeoutMs);
  if (!externalSignal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([externalSignal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function headerNumber(headers, name) {
  const raw = headers?.get?.(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function transportError(providerId, error, externalSignal, { stream = false } = {}) {
  if (externalSignal?.aborted) {
    return new ProviderError('Solicitação interrompida pelo usuário.', {
      providerId, category: 'cancelled', code: 'request_cancelled', retryable: false
    });
  }
  const source = error instanceof Error ? error : new Error(String(error || 'Erro desconhecido'));
  const detail = [source.name, source.message, source.cause?.code, source.cause?.message]
    .filter(Boolean).join(' ').toLowerCase();
  if (source.name === 'TimeoutError' || source.name === 'AbortError' || /timeout|timed out|abort/.test(detail)) {
    return new ProviderError('A rota gratuita excedeu o tempo de resposta.', {
      providerId, category: 'timeout', code: 'provider_timeout'
    });
  }
  return new ProviderError(stream
    ? 'A conexão com a rota gratuita foi interrompida durante a resposta.'
    : 'Não foi possível conectar ao provedor.', {
    providerId, category: 'availability', code: stream ? 'provider_stream_interrupted' : 'provider_unreachable'
  });
}

function sseProviderError(providerId, response, payload) {
  if (!payload?.error) return null;
  const normalized = typeof payload.error === 'object'
    ? payload
    : { ...payload, error: { message: String(payload.error) } };
  const error = classifyProviderError(providerId, response, normalized);
  if (error.category === 'unknown') {
    error.category = 'availability';
    error.code = 'stream_error';
  }
  error.headers = response.headers;
  error.finishReason = 'error';
  const usage = payload.usage || normalized.error?.usage || normalized.error?.metadata?.usage;
  if (usage && typeof usage === 'object') error.usage = usage;
  return error;
}

function attachPayloadUsage(error, payload) {
  const usage = payload?.usage || payload?.error?.usage || payload?.error?.metadata?.usage;
  if (usage && typeof usage === 'object') error.usage = usage;
  return error;
}

export class BaseProvider {
  constructor(options) {
    this.id = options.id;
    this.name = options.name;
    this.kind = options.kind;
    this.freeLabel = options.freeLabel;
    this.configured = options.configured;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.catalogTtlMs = options.catalogTtlMs || 300000;
    this.catalog = null;
    this.catalogAt = 0;
    this.health = {
      state: this.configured ? 'ready' : 'setup',
      latencyMs: null,
      failureCount: 0,
      cooldownUntil: 0,
      lastError: null,
      lastModel: null,
      resolvedModel: null,
      remainingRequests: null,
      remainingTokens: null,
      resetRequests: null,
      resetTokens: null,
      lastCheckedAt: null
    };
  }

  isCoolingDown() {
    return this.health.cooldownUntil > now();
  }

  canAttempt() {
    return this.configured && !this.isCoolingDown();
  }

  async requestJson(url, options = {}, timeoutMs = this.requestTimeoutMs) {
    let response;
    const externalSignal = options.signal;
    try {
      response = await fetch(url, { ...options, signal: requestSignal(externalSignal, timeoutMs) });
    } catch (error) {
      throw transportError(this.id, error, externalSignal);
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || payload?.error) {
      const err = classifyProviderError(this.id, response, payload || {});
      err.headers = response.headers;
      throw attachPayloadUsage(err, payload);
    }
    this.captureRateHeaders(response.headers);
    return { payload, response };
  }

  async requestEventStream(url, options = {}, onEvent = () => {}, timeoutMs = this.requestTimeoutMs) {
    let response;
    const externalSignal = options.signal;
    try {
      response = await fetch(url, { ...options, signal: requestSignal(externalSignal, timeoutMs) });
    } catch (error) {
      throw transportError(this.id, error, externalSignal);
    }
    if (!response.ok) {
      let payload = null;
      try { payload = JSON.parse(await response.text()); } catch { payload = {}; }
      const error = classifyProviderError(this.id, response, payload || {});
      error.headers = response.headers;
      throw attachPayloadUsage(error, payload);
    }
    this.captureRateHeaders(response.headers);
    if (!response.body) throw new ProviderError('A rota não abriu um fluxo de resposta.', {
      providerId: this.id, category: 'availability', code: 'empty_stream'
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const emitData = data => {
      if (!data || data === '[DONE]') return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      const providerError = sseProviderError(this.id, response, event);
      if (providerError) throw providerError;
      onEvent(event);
    };
    try {
      while (true) {
        let frame;
        try {
          frame = await reader.read();
        } catch (error) {
          throw transportError(this.id, error, externalSignal, { stream: true });
        }
        const { value, done } = frame;
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          emitData(line.slice(5).trim());
        }
        if (done) break;
      }
      if (buffer.startsWith('data:')) emitData(buffer.slice(5).trim());
    } catch (error) {
      try { await reader.cancel(error); } catch { /* o fluxo já pode estar encerrado */ }
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* leitor já liberado */ }
    }
    return response;
  }

  captureRateHeaders(headers) {
    const remainingRequests = headerNumber(headers, 'x-ratelimit-remaining-requests');
    const remainingTokens = headerNumber(headers, 'x-ratelimit-remaining-tokens');
    if (remainingRequests !== null) this.health.remainingRequests = remainingRequests;
    if (remainingTokens !== null) this.health.remainingTokens = remainingTokens;
    this.health.resetRequests = headers?.get?.('x-ratelimit-reset-requests') || this.health.resetRequests;
    this.health.resetTokens = headers?.get?.('x-ratelimit-reset-tokens') || this.health.resetTokens;
  }

  markSuccess({ latencyMs, model, resolvedModel } = {}) {
    this.health.state = 'online';
    this.health.failureCount = 0;
    this.health.cooldownUntil = 0;
    this.health.lastError = null;
    this.health.lastCheckedAt = new Date().toISOString();
    if (Number.isFinite(latencyMs)) this.health.latencyMs = Math.round(latencyMs);
    if (model) this.health.lastModel = model;
    if (resolvedModel) this.health.resolvedModel = resolvedModel;
  }

  markFailure(error) {
    this.health.failureCount += 1;
    this.health.lastCheckedAt = new Date().toISOString();
    this.health.lastError = {
      code: error.code || 'provider_error',
      category: error.category || 'unknown',
      message: String(error.message || 'Falha no provedor').slice(0, 180)
    };
    const defaultCooldown = {
      quota: 120000, timeout: 30000, availability: 45000, paid_blocked: 3600000,
      authentication: 900000, model: 120000, request: 60000, context: 0
    }[error.category] ?? 30000;
    const cooldown = error.retryAfterMs || defaultCooldown;
    if (cooldown > 0) this.health.cooldownUntil = now() + cooldown;
    this.health.state = error.category === 'authentication'
      ? 'setup'
      : error.category === 'quota' || error.category === 'paid_blocked'
        ? 'cooldown'
        : 'degraded';
  }

  async models({ force = false, signal } = {}) {
    if (!this.configured) return [];
    if (!force && this.catalog && now() - this.catalogAt < this.catalogTtlMs) return this.catalog;
    const started = now();
    try {
      const catalog = await this.discoverModels({ signal });
      this.catalog = catalog;
      this.catalogAt = now();
      this.markSuccess({ latencyMs: now() - started });
      return catalog;
    } catch (error) {
      if (error?.code !== 'request_cancelled') this.markFailure(error);
      throw error;
    }
  }

  async probe() {
    if (!this.configured) return this.publicStatus();
    try { await this.models({ force: true }); } catch { /* estado já atualizado */ }
    return this.publicStatus();
  }

  publicStatus() {
    const cooldownRemainingMs = Math.max(0, this.health.cooldownUntil - now());
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      freeLabel: this.freeLabel,
      configured: this.configured,
      state: cooldownRemainingMs > 0 ? 'cooldown' : this.health.state,
      latencyMs: this.health.latencyMs,
      failureCount: this.health.failureCount,
      cooldownUntil: cooldownRemainingMs ? new Date(this.health.cooldownUntil).toISOString() : null,
      cooldownRemainingMs,
      lastError: this.health.lastError,
      lastModel: this.health.lastModel,
      resolvedModel: this.health.resolvedModel,
      remainingRequests: this.health.remainingRequests,
      remainingTokens: this.health.remainingTokens,
      resetRequests: this.health.resetRequests,
      resetTokens: this.health.resetTokens,
      lastCheckedAt: this.health.lastCheckedAt,
      modelCount: this.catalog?.length || 0
    };
  }
}
