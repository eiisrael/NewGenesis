import { ProviderError } from './errors.js';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class InferenceBudget {
  constructor(options = 4) {
    const settings = typeof options === 'object' && options !== null ? options : { limit: options };
    this.limit = positiveInteger(settings.limit, 4);
    const tokenLimit = Number.parseInt(settings.inputTokenLimit, 10);
    this.inputTokenLimit = Number.isFinite(tokenLimit) && tokenLimit > 0 ? tokenLimit : null;
    this.sentInputTokens = 0;
    this.used = 0;
    this.entries = [];
  }

  consume(meta = {}) {
    if (this.used >= this.limit) {
      throw new ProviderError(`O limite seguro de ${this.limit} requisições de IA para esta mensagem foi atingido.`, {
        providerId: meta.providerId || 'openrouter',
        category: 'budget',
        code: 'request_budget_exhausted',
        retryable: false
      });
    }
    const estimatedInputTokens = Math.max(0, Number(meta.estimatedInputTokens || meta.inputTokens || 0));
    if (this.inputTokenLimit !== null && this.sentInputTokens + estimatedInputTokens > this.inputTokenLimit) {
      throw new ProviderError(`O teto seguro de ${this.inputTokenLimit.toLocaleString('pt-BR')} tokens de entrada para esta tarefa seria ultrapassado.`, {
        providerId: meta.providerId || 'openrouter',
        category: 'budget',
        code: 'input_token_budget_exhausted',
        retryable: false
      });
    }
    this.used += 1;
    this.sentInputTokens += estimatedInputTokens;
    this.entries.push({
      number: this.used,
      providerId: meta.providerId || null,
      model: meta.model || null,
      kind: meta.kind || 'completion',
      estimatedInputTokens,
      timestamp: new Date().toISOString()
    });
    return this.used;
  }

  get remaining() {
    return Math.max(0, this.limit - this.used);
  }

  get remainingInputTokens() {
    return this.inputTokenLimit === null ? null : Math.max(0, this.inputTokenLimit - this.sentInputTokens);
  }

  snapshot() {
    const snapshot = { limit: this.limit, used: this.used, remaining: this.remaining };
    if (this.inputTokenLimit !== null) {
      snapshot.inputTokenLimit = this.inputTokenLimit;
      snapshot.sentInputTokens = this.sentInputTokens;
      snapshot.remainingInputTokens = this.remainingInputTokens;
    }
    return snapshot;
  }
}

export function createUsageLedger() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    reportedRequests: 0,
    estimatedRequests: 0,
    unknownRequests: 0,
    records: []
  };
}

export function recordUsage(ledger, usage = {}, estimates = {}, meta = {}) {
  const reportedInput = Number(usage.inputTokens ?? usage.prompt_tokens ?? 0);
  const reportedOutput = Number(usage.outputTokens ?? usage.completion_tokens ?? 0);
  const reportedTotal = Number(usage.totalTokens ?? usage.total_tokens ?? 0);
  const hasReportedUsage = reportedInput > 0 || reportedOutput > 0 || reportedTotal > 0;
  const inputTokens = hasReportedUsage ? reportedInput : Math.max(0, Number(estimates.inputTokens || 0));
  const outputTokens = hasReportedUsage ? reportedOutput : Math.max(0, Number(estimates.outputTokens || 0));
  const totalTokens = reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens;

  ledger.inputTokens += inputTokens;
  ledger.outputTokens += outputTokens;
  ledger.totalTokens += totalTokens;
  ledger.cost += Math.max(0, Number(usage.cost || 0));
  if (hasReportedUsage) ledger.reportedRequests += 1;
  else ledger.estimatedRequests += 1;
  ledger.records.push({
    requestNumber: Number(meta.requestNumber || ledger.records.length + 1),
    providerId: meta.providerId || null,
    model: meta.model || null,
    inputTokens,
    outputTokens,
    totalTokens,
    cost: Math.max(0, Number(usage.cost || 0)),
    accuracy: hasReportedUsage ? 'reported' : 'estimated'
  });
  return { inputTokens, outputTokens, totalTokens, accuracy: hasReportedUsage ? 'reported' : 'estimated' };
}

export function finalUsage(ledger, budget) {
  const requestCount = budget?.used || ledger.reportedRequests + ledger.estimatedRequests + ledger.unknownRequests;
  const accounted = ledger.reportedRequests + ledger.estimatedRequests;
  const records = new Map((ledger.records || []).map(record => [record.requestNumber, record]));
  const missingEntries = (budget?.entries || []).filter(entry => !records.has(entry.number));
  const missingInputTokens = missingEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.estimatedInputTokens || 0)), 0);
  const modelMap = new Map();
  for (const entry of budget?.entries || []) {
    const record = records.get(entry.number);
    const model = String(record?.model || entry.model || 'desconhecido');
    if (!modelMap.has(model)) modelMap.set(model, {
      providerId: record?.providerId || entry.providerId || null,
      model, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      reportedRequests: 0, estimatedRequests: 0, unknownRequests: 0
    });
    const summary = modelMap.get(model);
    summary.requests += 1;
    if (record) {
      summary.inputTokens += record.inputTokens;
      summary.outputTokens += record.outputTokens;
      summary.totalTokens += record.totalTokens;
      if (record.accuracy === 'reported') summary.reportedRequests += 1;
      else summary.estimatedRequests += 1;
    } else {
      const estimated = Math.max(0, Number(entry.estimatedInputTokens || 0));
      summary.inputTokens += estimated;
      summary.totalTokens += estimated;
      summary.unknownRequests += 1;
    }
  }
  const unknownRequests = Math.max(ledger.unknownRequests, requestCount - accounted);
  return {
    inputTokens: ledger.inputTokens + missingInputTokens,
    outputTokens: ledger.outputTokens,
    totalTokens: ledger.totalTokens + missingInputTokens,
    cost: ledger.cost,
    requestCount,
    reportedRequests: ledger.reportedRequests,
    estimatedRequests: ledger.estimatedRequests,
    unknownRequests,
    accuracy: ledger.estimatedRequests || unknownRequests ? 'mixed' : 'reported',
    sentInputTokenEstimate: budget?.sentInputTokens || 0,
    inputTokenLimit: budget?.inputTokenLimit || null,
    models: [...modelMap.values()]
  };
}
