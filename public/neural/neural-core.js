export function createEventBus() {
  const channels = new Map();
  return {
    on(name, handler) {
      if (typeof handler !== 'function') throw new TypeError('O listener deve ser uma função.');
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name).add(handler);
      return () => channels.get(name)?.delete(handler);
    },
    emit(name, payload) {
      const listeners = [...(channels.get(name) || []), ...(channels.get('*') || [])];
      for (const handler of listeners) handler(payload, name);
    },
    clear() { channels.clear(); }
  };
}

export function normalizeEventType(log = {}) {
  const category = String(log.category || '').trim().toLowerCase();
  const type = String(log.type || '').trim().toLowerCase();
  if (!type) return category ? category + '.event' : 'system.event';
  if (!category || type.startsWith(category + '.')) return type;
  return category + '.' + type;
}

export function createSeenEventTracker(limit = 1200) {
  const ids = new Set();
  const order = [];
  return {
    accept(event) {
      const id = String(event?.id || '').trim();
      if (!id) return true;
      if (ids.has(id)) return false;
      ids.add(id);
      order.push(id);
      while (order.length > limit) ids.delete(order.shift());
      return true;
    },
    clear() { ids.clear(); order.length = 0; },
    get size() { return ids.size; }
  };
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function lastOf(logs, predicate) {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (predicate(logs[index])) return logs[index];
  }
  return null;
}

export function deriveTaskMetrics(logs = [], now = Date.now()) {
  const acceptedIndex = logs.map(normalizeEventType).lastIndexOf('agent.request.accepted');
  const taskLogs = acceptedIndex >= 0 ? logs.slice(acceptedIndex) : logs;
  const attempts = taskLogs.filter(log => normalizeEventType(log) === 'agent.attempt');
  const fallbacks = taskLogs.filter(log => normalizeEventType(log) === 'agent.fallback');
  const toolStarts = taskLogs.filter(log => normalizeEventType(log) === 'agent.tool.started');
  const completion = lastOf(taskLogs, log => normalizeEventType(log) === 'agent.complete');
  const failure = lastOf(taskLogs, log => ['agent.failed', 'agent.stopped'].includes(normalizeEventType(log)));
  const accepted = acceptedIndex >= 0 ? logs[acceptedIndex] : null;
  const terminal = completion || failure;
  const acceptedAt = accepted?.timestamp ? new Date(accepted.timestamp).getTime() : 0;
  const terminalAt = terminal?.timestamp ? new Date(terminal.timestamp).getTime() : 0;
  const active = Boolean(accepted && (!terminal || terminalAt < acceptedAt));
  const lastAttempt = attempts.at(-1) || null;
  const reportedUsage = completion?.meta?.usage || null;
  const estimatedInput = attempts.reduce((sum, log) => sum + numeric(log.meta?.inputTokens), 0);
  const elapsedMs = completion?.meta?.latencyMs
    ? numeric(completion.meta.latencyMs)
    : acceptedAt ? Math.max(0, (active ? now : terminalAt || now) - acceptedAt) : 0;
  let status = accepted ? 'processing' : 'idle';
  if (completion) status = 'complete';
  if (failure) status = normalizeEventType(failure) === 'agent.stopped' ? 'stopped' : 'error';
  if (active) status = 'processing';
  return {
    active, status, startedAt: acceptedAt, elapsedMs,
    model: completion?.meta?.model || lastAttempt?.meta?.model || '',
    provider: completion?.providerId || lastAttempt?.providerId || '',
    inputTokens: reportedUsage ? numeric(reportedUsage.inputTokens) : estimatedInput,
    outputTokens: reportedUsage ? numeric(reportedUsage.outputTokens) : 0,
    totalTokens: reportedUsage ? numeric(reportedUsage.totalTokens) : estimatedInput,
    requestCount: reportedUsage ? numeric(reportedUsage.requestCount) : attempts.length,
    accuracy: reportedUsage?.accuracy || (attempts.length ? 'estimated' : 'unknown'),
    fallbacks: fallbacks.length,
    tools: toolStarts.length,
    lastEvent: taskLogs.at(-1) || null,
    taskLogs
  };
}

export function moduleStateForEvent(log = {}) {
  const type = normalizeEventType(log);
  if (log.level === 'error' || ['agent.failed', 'agent.tool.failed'].includes(type)) return 'error';
  if (log.level === 'warning' || type.endsWith('.fallback') || type.endsWith('.required')) return 'waiting';
  if (log.level === 'success' || type.endsWith('.complete') || type.endsWith('.completed')) return 'complete';
  return 'processing';
}

export function eventModules(log, mapping = {}) {
  return mapping[normalizeEventType(log)] || [];
}

export function normalizeGraphPayload(payload = {}) {
  const root = payload.graph || payload;
  const rawNodes = root.nodes || root.files || payload.results || [];
  const rawEdges = root.edges || [];
  const nodes = rawNodes.map((node, index) => {
    const id = String(node.path || node.id || node.name || 'node-' + index);
    return {
      ...node,
      id,
      path: String(node.path || node.id || node.name || id),
      label: String(node.label || basename(node.path || node.id || node.name || id)),
      language: String(node.language || 'text'),
      score: numeric(node.score ?? node.centrality ?? node.pageRank),
      centrality: numeric(node.centrality ?? node.pageRank ?? node.score),
      basin: String(node.basin || node.attractor || '')
    };
  });
  const known = new Set(nodes.map(node => node.id));
  const edges = rawEdges.flatMap((edge, index) => {
    const source = String(edge.source?.id || edge.source || '');
    const target = String(edge.target?.id || edge.target || '');
    if (!source || !target || !known.has(source) || !known.has(target)) return [];
    return [{ ...edge, id: String(edge.id || 'edge-' + index), source, target, type: String(edge.type || 'relation'), weight: numeric(edge.weight || 0.5) }];
  });
  return { nodes, edges };
}

export function mergeGraph(base = { nodes: [], edges: [] }, addition = { nodes: [], edges: [] }) {
  const nodeMap = new Map((base.nodes || []).map(node => [node.id, node]));
  for (const node of addition.nodes || []) nodeMap.set(node.id, { ...(nodeMap.get(node.id) || {}), ...node });
  const edgeMap = new Map((base.edges || []).map(edge => [edge.id || edge.source + '|' + edge.target + '|' + edge.type, edge]));
  for (const edge of addition.edges || []) edgeMap.set(edge.id || edge.source + '|' + edge.target + '|' + edge.type, edge);
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

export function basename(value = '') {
  return String(value).replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || String(value);
}

export function formatTokenCount(value) {
  const number = numeric(value);
  if (number >= 1_000_000) return (number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1).replace('.0', '') + 'M';
  if (number >= 1_000) return (number / 1_000).toFixed(number >= 100_000 ? 0 : 1).replace('.0', '') + 'K';
  return Math.round(number).toLocaleString('pt-BR');
}

export function formatDuration(value) {
  const ms = numeric(value);
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace('.0', '') + ' s';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes + ' min ' + seconds + ' s';
}
