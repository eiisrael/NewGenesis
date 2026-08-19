import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEventBus, createSeenEventTracker, deriveTaskMetrics, eventModules,
  mergeGraph, normalizeEventType, normalizeGraphPayload
} from '../public/neural/neural-core.js';
import { EVENT_MODULES } from '../public/neural/neural.config.js';

test('barramento Neural entrega somente o canal solicitado', () => {
  const bus = createEventBus();
  const telemetry = [];
  const fps = [];
  bus.on('telemetry', value => telemetry.push(value));
  bus.on('fps', value => fps.push(value));
  bus.emit('fps', 60);
  assert.deepEqual(fps, [60]);
  assert.deepEqual(telemetry, []);
});

test('normaliza tipos já prefixados e tipos curtos sem duplicar categoria', () => {
  assert.equal(normalizeEventType({ category: 'agent', type: 'agent.route' }), 'agent.route');
  assert.equal(normalizeEventType({ category: 'suprememind', type: 'index.progress' }), 'suprememind.index.progress');
  assert.equal(normalizeEventType({ category: 'suprememind', type: 'init' }), 'suprememind.init');
  assert.equal(normalizeEventType({ category: 'system', type: 'permissions.updated' }), 'system.permissions.updated');
});

test('deduplicador impede replay de snapshots reconectados', () => {
  const tracker = createSeenEventTracker(3);
  assert.equal(tracker.accept({ id: 'a' }), true);
  assert.equal(tracker.accept({ id: 'a' }), false);
  assert.equal(tracker.accept({ id: 'b' }), true);
  assert.equal(tracker.accept({ id: 'c' }), true);
  assert.equal(tracker.accept({ id: 'd' }), true);
  assert.equal(tracker.accept({ id: 'a' }), true);
});

test('mapeia eventos reais do agente para módulos do runtime', () => {
  const modules = eventModules({ category: 'agent', type: 'agent.attempt' }, EVENT_MODULES);
  assert.deepEqual(modules, ['context', 'router', 'provider']);
  assert.deepEqual(eventModules({ category: 'suprememind', type: 'init' }, EVENT_MODULES), ['suprememind']);
});

test('métricas ao vivo somam inputs das tentativas e marcam estimativa', () => {
  const logs = [
    { timestamp: '2026-01-01T00:00:00Z', category: 'agent', type: 'agent.request.accepted' },
    { timestamp: '2026-01-01T00:00:01Z', category: 'agent', type: 'agent.attempt', providerId: 'openrouter', meta: { model: 'a:free', inputTokens: 1200 } },
    { timestamp: '2026-01-01T00:00:02Z', category: 'agent', type: 'agent.fallback' },
    { timestamp: '2026-01-01T00:00:03Z', category: 'agent', type: 'agent.attempt', providerId: 'openrouter', meta: { model: 'b:free', inputTokens: 800 } }
  ];
  const metrics = deriveTaskMetrics(logs, Date.parse('2026-01-01T00:00:04Z'));
  assert.equal(metrics.active, true);
  assert.equal(metrics.inputTokens, 2000);
  assert.equal(metrics.totalTokens, 2000);
  assert.equal(metrics.requestCount, 2);
  assert.equal(metrics.fallbacks, 1);
  assert.equal(metrics.accuracy, 'estimated');
  assert.equal(metrics.model, 'b:free');
});

test('medição reportada da conclusão substitui estimativas intermediárias', () => {
  const logs = [
    { timestamp: '2026-01-01T00:00:00Z', category: 'agent', type: 'agent.request.accepted' },
    { timestamp: '2026-01-01T00:00:01Z', category: 'agent', type: 'agent.attempt', meta: { inputTokens: 900 } },
    { timestamp: '2026-01-01T00:00:02Z', category: 'agent', type: 'agent.complete', meta: { latencyMs: 2000, model: 'model:free', usage: { inputTokens: 920, outputTokens: 80, totalTokens: 1000, requestCount: 1, accuracy: 'reported' } } }
  ];
  const metrics = deriveTaskMetrics(logs);
  assert.equal(metrics.active, false);
  assert.equal(metrics.status, 'complete');
  assert.equal(metrics.inputTokens, 920);
  assert.equal(metrics.outputTokens, 80);
  assert.equal(metrics.totalTokens, 1000);
  assert.equal(metrics.accuracy, 'reported');
});

test('normaliza e combina grafo usando caminhos como identidade', () => {
  const graph = normalizeGraphPayload({
    nodes: [{ id: 'hash-a', path: 'src/a.js' }, { id: 'hash-b', path: 'src/b.js' }],
    edges: [{ source: 'src/a.js', target: 'src/b.js', type: 'dependency' }]
  });
  assert.deepEqual(graph.nodes.map(node => node.id), ['src/a.js', 'src/b.js']);
  assert.equal(graph.edges.length, 1);
  const merged = mergeGraph(graph, { nodes: [{ id: 'src/c.js', path: 'src/c.js' }], edges: [{ source: 'src/b.js', target: 'src/c.js', type: 'call' }] });
  assert.equal(merged.nodes.length, 3);
  assert.equal(merged.edges.length, 2);
});
