export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.providerId = options.providerId;
    this.status = options.status || 0;
    this.code = options.code || 'provider_error';
    this.category = options.category || 'unknown';
    this.retryAfterMs = options.retryAfterMs || 0;
    this.retryable = options.retryable ?? true;
  }
}

export class GenesisUnavailableError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = 'GenesisUnavailableError';
    this.code = 'no_free_provider_available';
    this.attempts = attempts;
  }
}

const includesAny = (value, terms) => terms.some(term => value.includes(term));

export function retryAfterMilliseconds(value, timestamp = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - timestamp) : 0;
}

export function classifyProviderError(providerId, response, payload) {
  const responseStatus = Number(response?.status || 0);
  const payloadStatus = Number(payload?.error?.code || 0);
  const status = responseStatus >= 400 ? responseStatus : payloadStatus;
  const rawMessage = payload?.error?.message || payload?.message || `Falha HTTP ${status || 'desconhecida'}`;
  const message = String(rawMessage).slice(0, 500);
  const text = message.toLowerCase();
  const retryAfterMs = retryAfterMilliseconds(response?.headers?.get?.('retry-after'));

  let category = 'unknown';
  let code = 'provider_error';
  let retryable = true;

  if (status === 401 || status === 403) {
    category = 'authentication';
    code = 'invalid_credentials';
    retryable = false;
  } else if (status === 402) {
    category = 'paid_blocked';
    code = 'paid_route_blocked';
    retryable = false;
  } else if (status === 429 || includesAny(text, ['resource_exhausted', 'rate limit', 'quota'])) {
    category = 'quota';
    code = 'quota_exhausted';
  } else if (includesAny(text, ['no providers', 'no available provider', 'no endpoints', 'no endpoints found', 'provider requires payment', 'all providers failed'])) {
    // OpenRouter retorna 400 quando não há provedor gratuito disponível
    // para um modelo, 402 quando exige pagamento. Não são quota da chave,
    // são problemas DE ROTEAMENTO upstream do OpenRouter.
    category = 'availability';
    code = 'no_provider_available';
    retryable = true;
  } else if (status === 404 || includesAny(text, ['model not found', 'does not exist'])) {
    category = 'model';
    code = 'model_unavailable';
  } else if (status === 408 || status === 504 || includesAny(text, ['timeout', 'timed out', 'operation was aborted', 'aborted'])) {
    category = 'timeout';
    code = 'provider_timeout';
  } else if (status === 413 || includesAny(text, ['context length', 'context_length', 'too many tokens', 'token limit', 'string too long'])) {
    category = 'context';
    code = 'context_too_large';
  } else if (status >= 500 || includesAny(text, ['overloaded', 'unavailable', 'capacity', 'internal server error'])) {
    category = 'availability';
    code = 'provider_unavailable';
  } else if (includesAny(text, ['cannot read properties of undefined', 'cannot read property', 'filter is not a function', 'typeerror', 'undefined is not', 'map is not a function', 'foreach is not a function', 'reduce is not a function', 'find is not a function', 'includes is not a function'])) {
    category = 'model';
    code = 'response_processing_error';
    retryable = false;
  } else if (includesAny(text, ['roles must alternate', 'role must alternate'])) {
    category = 'request';
    code = 'invalid_conversation_sequence';
    retryable = false;
  } else if (status >= 400 && status < 500) {
    category = 'request';
    code = 'invalid_request';
    retryable = false;
  }

  const friendlyMessage = {
    authentication: 'A chave configurada foi recusada. Atualize-a nas configurações.',
    paid_blocked: 'A rota solicitou créditos pagos e foi bloqueada pelo modo gratuito.',
    quota: 'A cota temporária deste modelo gratuito foi atingida.',
    model: 'Este modelo gratuito está temporariamente indisponível.',
    timeout: 'A rota gratuita excedeu o tempo de resposta.',
    context: 'A conversa ultrapassou o limite de contexto deste modelo.',
    availability: 'O modelo gratuito está temporariamente indisponível.',
    request: code === 'invalid_conversation_sequence'
      ? 'O histórico da conversa precisa ser reorganizado antes do envio.'
      : 'O modelo gratuito recusou o formato desta solicitação.',
    unknown: 'A rota gratuita não concluiu esta solicitação.'
  }[category];

  return new ProviderError(friendlyMessage, {
    providerId,
    status,
    category,
    code,
    retryAfterMs,
    retryable
  });
}

export function safeError(error) {
  return {
    code: error?.code || 'unexpected_error',
    category: error?.category || 'unknown',
    message: String(error?.message || 'Erro inesperado').slice(0, 300),
    retryAfterMs: error?.retryAfterMs || 0
  };
}
