// Genesis — Performance Analytics
// Identifica gargalos (CPU/RAM/I/O/latência/tokens) a partir de fontes reais:
//   - Telemetry (latência por modelo, tokens de input/output)
//   - GenesisTelemetry.events (taxa de erro por nível, quantidade por categoria)
//   - SupremeMind (tamanho do índice, símbolos)
//   - Node process.memoryUsage (snapshots)
// Combina tudo em uma única resposta tipada. Não faz profiling de CPU real
// (isso pertence a `node --prof`).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/4 — Análise do snapshot de telemetria.
// ─────────────────────────────────────────────────────────────────────────────

function percentile(numbers, p) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(2));
}

export function summarizeTokens(events) {
  const inputs = [];
  const outputs = [];
  for (const e of events) {
    const m = e.meta?.usage || {};
    if (Number.isFinite(m.inputTokens)) inputs.push(m.inputTokens);
    if (Number.isFinite(m.outputTokens)) outputs.push(m.outputTokens);
  }
  return {
    samples: { input: inputs.length, output: outputs.length },
    input:  { p50: percentile(inputs, 50), p95: percentile(inputs, 95), max: Math.max(0, ...inputs) },
    output: { p50: percentile(outputs, 50), p95: percentile(outputs, 95), max: Math.max(0, ...outputs) }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2/4 — Latência por modelo/provedor.
// ─────────────────────────────────────────────────────────────────────────────

export function summarizeLatency(events) {
  const groups = new Map();
  for (const e of events) {
    if (e.type !== 'agent.complete') continue;
    const model = e.meta?.model || 'unknown';
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model).push(Number(e.meta?.latencyMs || 0));
  }
  const out = {};
  for (const [model, samples] of groups) {
    samples.sort((a, b) => a - b);
    out[model] = {
      samples: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      max: Math.max(0, ...samples)
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3/4 — Erros e categorias: taxa de fallback e recovery.
// ─────────────────────────────────────────────────────────────────────────────

export function summarizeEvents(events) {
  const summary = { total: events.length, byLevel: {}, byCategory: {}, fallbacks: 0, recoveries: 0 };
  for (const e of events) {
    summary.byLevel[e.level] = (summary.byLevel[e.level] || 0) + 1;
    summary.byCategory[e.category] = (summary.byCategory[e.category] || 0) + 1;
    if (e.type === 'agent.fallback') summary.fallbacks += 1;
    if (e.type === 'agent.recovery') summary.recoveries += 1;
  }
  const errRate = (summary.byLevel.error || 0) / Math.max(1, summary.total);
  summary.errorRate = Number(errRate.toFixed(4));
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 4/4 — Memória JS atual + resumo geral.
// ─────────────────────────────────────────────────────────────────────────────

export function summarizeMemory(extra = {}) {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1048576),
    heapTotal: Math.round(mem.heapTotal / 1048576),
    heapUsed: Math.round(mem.heapUsed / 1048576),
    external: Math.round(mem.external / 1048576),
    arrayBuffers: Math.round(mem.arrayBuffers / 1048576),
    extra
  };
}

// Lê os arquivos persistidos de telemetria e gera um overview completo.
export async function analyzeProjectPerformance({ dataDir, projectIndex } = {}) {
  const eventsFile = dataDir ? join(dataDir, 'events.jsonl') : null;
  let events = [];
  if (eventsFile) {
    const raw = await readFile(eventsFile, 'utf8').catch(() => '');
    events = raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).slice(-500);
  }
  return {
    collected: Date.now(),
    events: summarizeEvents(events),
    tokens: summarizeTokens(events),
    latency: summarizeLatency(events),
    memory: summarizeMemory(projectIndex ? { files: projectIndex.stats.indexed, symbols: projectIndex.stats.symbols } : {})
  };
}

export function renderPerformanceReport(report) {
  const lines = [
    `Eventos: ${report.events.total} (erro ${(report.events.errorRate * 100).toFixed(2)}%)`,
    `Fallbacks: ${report.events.fallbacks}, recuperações: ${report.events.recoveries}`,
    `Tokens input p50=${report.tokens.input.p50} · p95=${report.tokens.input.p95} · max=${report.tokens.input.max}`,
    `Tokens output p50=${report.tokens.output.p50} · p95=${report.tokens.output.p95} · max=${report.tokens.output.max}`,
    `Memória JS: RSS=${report.memory.rss} MB · heap=${report.memory.heapUsed}/${report.memory.heapTotal} MB`
  ];
  const lat = Object.entries(report.latency);
  if (lat.length) {
    lines.push('Latência por modelo:');
    for (const [m, s] of lat.slice(0, 8)) lines.push(`  • ${m}: p50=${s.p50}ms · p95=${s.p95}ms · n=${s.samples}`);
  }
  return lines.join('\n');
}
