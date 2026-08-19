import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './core/secret-sanitizer.js';

const LEVELS = new Set(['debug', 'info', 'success', 'warning', 'error']);
const MAX_TEXT = 2000;

function freshMetrics() {
  return {
    tokensSent: 0,
    tokensReceived: 0,
    tokensSaved: 0,
    cacheHits: 0,
    cacheMisses: 0,
    fallbacks: 0,
    retries: 0,
    totalLatencyMs: 0,
    requestCount: 0,
    providerRequestCount: 0,
    byProvider: {},
    byModel: {},
    byIntent: {}
  };
}

function sensitiveKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'token'
    || normalized.includes('apikey')
    || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken')
    || normalized.includes('authorization')
    || normalized.includes('password')
    || normalized.includes('credential')
    || normalized.includes('cookie')
    || normalized === 'secret'
    || normalized.endsWith('secret');
}

export function redactText(value, maxLength = MAX_TEXT) {
  const text = redactSecrets(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function sanitizeTelemetry(value, depth = 0, key = '') {
  if (sensitiveKey(key)) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 25).map(item => sanitizeTelemetry(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([name, item]) => [name, sanitizeTelemetry(item, depth + 1, name)]));
  }
  return redactText(value);
}

function matches(event, filters = {}) {
  if (filters.category && event.category !== filters.category) return false;
  if (filters.conversationId && event.conversationId !== filters.conversationId) return false;
  if (filters.thought === true && event.thought !== true) return false;
  return true;
}

export class GenesisTelemetry {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'events.jsonl');
    this.previousFile = path.join(dataDir, 'events.previous.jsonl');
    this.capacity = options.capacity || 500;
    this.maxFileBytes = options.maxFileBytes || 5 * 1024 * 1024;
    this.events = [];
    this.sequence = 0;
    this.subscribers = new Set();
    this.writeQueue = Promise.resolve();
    // Timing metrics
    this.timers = new Map();
    this.timerSequence = 0;
    this.metrics = freshMetrics();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > this.maxFileBytes) {
        await fs.rm(this.previousFile, { force: true });
        await fs.rename(this.file, this.previousFile);
        await fs.writeFile(this.file, '', { mode: 0o600 });
      }
      const content = await fs.readFile(this.file, 'utf8');
      const previousContent = await fs.readFile(this.previousFile, 'utf8').catch(() => '');
      const parseEvents = source => source.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const currentEvents = parseEvents(content);
      const previousEvents = parseEvents(previousContent);
      const loaded = (currentEvents.length ? currentEvents : previousEvents).slice(-this.capacity);
      this.events = loaded;
      this.sequence = loaded.reduce((highest, event) => Math.max(highest, Number(event.sequence) || 0), 0);
      for (const event of [...previousEvents, ...currentEvents]) {
        if (event?.category === 'tokens' && event?.type === 'usage') {
          this.metrics.tokensSent += Number(event.meta?.inputTokens || 0);
          this.metrics.tokensReceived += Number(event.meta?.outputTokens || 0);
          this.metrics.tokensSaved += Number(event.meta?.savedTokens || 0);
          this.metrics.providerRequestCount += Math.max(0, Number(event.meta?.requestCount || 0));
        }
        if (event?.category === 'performance' && event?.type === 'timing') {
          this.metrics.requestCount += 1;
          this.metrics.totalLatencyMs += Math.max(0, Number(event.meta?.durationMs || 0));
          if (event.meta?.provider) this.metrics.byProvider[event.meta.provider] = (this.metrics.byProvider[event.meta.provider] || 0) + 1;
          if (event.meta?.model) this.metrics.byModel[event.meta.model] = (this.metrics.byModel[event.meta.model] || 0) + 1;
          if (event.meta?.intent) this.metrics.byIntent[event.meta.intent] = (this.metrics.byIntent[event.meta.intent] || 0) + 1;
        }
        if (event?.type === 'agent.attempt') {
          if (event.meta?.cacheHit === true) this.metrics.cacheHits += 1;
          else this.metrics.cacheMisses += 1;
          if (event.meta?.compactRetry === true) this.metrics.retries += 1;
        }
        if (event?.type === 'agent.fallback') this.metrics.fallbacks += 1;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.writeFile(this.file, '', { mode: 0o600 });
    }
    return this;
  }

  emit(input = {}) {
    const event = sanitizeTelemetry({
      id: `${Date.now().toString(36)}-${(this.sequence + 1).toString(36)}`,
      sequence: this.sequence + 1,
      timestamp: new Date().toISOString(),
      level: LEVELS.has(input.level) ? input.level : 'info',
      category: redactText(input.category || 'system', 80),
      type: redactText(input.type || 'system.event', 120),
      title: redactText(input.title || 'Evento do Genesis', 180),
      detail: redactText(input.detail || '', MAX_TEXT),
      conversationId: input.conversationId ? redactText(input.conversationId, 100) : null,
      providerId: input.providerId ? redactText(input.providerId, 80) : null,
      thought: input.thought === true,
      meta: input.meta || {}
    });
    this.sequence = event.sequence;
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => fs.appendFile(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 }));
    for (const subscriber of this.subscribers) {
      try { subscriber(structuredClone(event)); } catch { /* subscriber isolation */ }
    }
    return structuredClone(event);
  }

  // Timer methods for performance tracking
  startTimer(label) {
    const token = `${String(label || 'timer')}:${++this.timerSequence}`;
    this.timers.set(token, { label: String(label || 'timer'), start: process.hrtime.bigint() });
    return token;
  }

  stopTimer(token, meta = {}) {
    const timer = this.timers.get(token);
    if (!timer) return 0;
    const elapsedNs = process.hrtime.bigint() - timer.start;
    const elapsedMs = Number(elapsedNs) / 1e6;
    this.timers.delete(token);
    const label = timer.label;
    
    // Record metric
    this.metrics.totalLatencyMs += elapsedMs;
    this.metrics.requestCount++;
    
    if (meta.provider) {
      this.metrics.byProvider[meta.provider] = (this.metrics.byProvider[meta.provider] || 0) + 1;
    }
    if (meta.model) {
      this.metrics.byModel[meta.model] = (this.metrics.byModel[meta.model] || 0) + 1;
    }
    if (meta.intent) {
      this.metrics.byIntent[meta.intent] = (this.metrics.byIntent[meta.intent] || 0) + 1;
    }
    
    // Emit timing event
    this.emit({
      category: 'performance',
      type: 'timing',
      title: `Tempo ${label}`,
      detail: `${elapsedMs.toFixed(1)}ms`,
      level: 'debug',
      meta: { ...meta, durationMs: elapsedMs }
    });
    
    return elapsedMs;
  }

  recordTokens(inputTokens, outputTokens, savedTokens = 0, requestCount = 1, accuracy = 'reported') {
    this.metrics.tokensSent += inputTokens;
    this.metrics.tokensReceived += outputTokens;
    this.metrics.tokensSaved += savedTokens;
    this.metrics.providerRequestCount += Math.max(0, Number(requestCount || 0));
    
    this.emit({
      category: 'tokens',
      type: 'usage',
      title: 'Tokens utilizados',
      detail: `Enviados: ${inputTokens} | Recebidos: ${outputTokens} | Economizados: ${savedTokens}`,
      level: 'info',
      meta: { inputTokens, outputTokens, savedTokens, requestCount, accuracy }
    });
  }

  recordCacheHit() {
    this.metrics.cacheHits++;
  }

  recordCacheMiss() {
    this.metrics.cacheMisses++;
  }

  recordFallback() {
    this.metrics.fallbacks++;
  }

  recordRetry() {
    this.metrics.retries++;
  }

  getMetrics() {
    const cacheTotal = this.metrics.cacheHits + this.metrics.cacheMisses;
    return {
      ...this.metrics,
      cacheHitRate: cacheTotal > 0 ? (this.metrics.cacheHits / cacheTotal * 100).toFixed(1) + '%' : '0%',
      avgLatencyMs: this.metrics.requestCount > 0 ? (this.metrics.totalLatencyMs / this.metrics.requestCount).toFixed(1) : '0',
      totalRequests: this.metrics.providerRequestCount,
      totalTimedOperations: this.metrics.requestCount,
      memoryUsage: process.memoryUsage()
    };
  }

  list(filters = {}) {
    const limit = Math.max(1, Math.min(Number(filters.limit) || 200, this.capacity));
    return this.events.filter(event => matches(event, filters)).slice(-limit).map(event => structuredClone(event));
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async clear() {
    await this.writeQueue.catch(() => {});
    this.events = [];
    this.metrics = freshMetrics();
    await fs.rm(this.previousFile, { force: true });
    await fs.writeFile(this.file, '', { mode: 0o600 });
  }

  async flush() {
    await this.writeQueue;
  }
}
