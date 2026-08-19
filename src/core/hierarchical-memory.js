// GenESI — Hierarchical Memory
// Camadas nomeadas com TTL e escopo próprio.
// Reaproveita UserMemoryStore (preferências) e o Jsonl do SupremeMind (descobertas).
// NÃO duplica persistência: cada camada aponta para a fonte existente.

import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/6 — Catálogo das camadas e contrato de uso.
// ─────────────────────────────────────────────────────────────────────────────

// Cada camada aponta para o módulo já existente (não copiamos dados).
// ttl_ms = 0 significa "não expira automaticamente".
export const LAYERS = Object.freeze({
  ephemeral: {
    name: 'ephemeral', ttl_ms: 5 * 60 * 1000,
    storage: ':memory:', strategy: 'Memória de processo — request-local'
  },
  conversation: {
    name: 'conversation', ttl_ms: 0,
    storage: '.genesis/state.json', strategy: 'Storage de conversas (GenesisStore)'
  },
  project: {
    name: 'project', ttl_ms: 0,
    storage: '.genesis/project.json',
    strategy: 'ProjectStore read-only/editável (inclui SupremeMind)'
  },
  user: {
    name: 'user', ttl_ms: 0,
    storage: '.genesis/user-memory.json',
    strategy: 'UserMemoryStore (preferências inferidas)'
  },
  knowledge: {
    name: 'knowledge', ttl_ms: 0,
    storage: 'GENESIS_KNOWLEDGE_BASE.md',
    strategy: 'Knowledge base markdown do projeto'
  },
  architectural: {
    name: 'architectural', ttl_ms: 0,
    storage: '.genesis/edges.json',
    strategy: 'Knowledge Graph do projeto (cache do Suprememind graph.edges)'
  }
});

let LAYER_INSTANCES = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2/6 — Fila por camada garantindo zero race condition na leitura.
// Cada camada retornou uma promise ou objeto assíncrono.
// ─────────────────────────────────────────────────────────────────────────────

function queue(layer, op) {
  const prev = layer.queue ?? Promise.resolve();
  const next = prev.catch(() => null).then(op);
  layer.queue = next;
  return next;
}

function ensure(layerKey) {
  if (LAYER_INSTANCES.has(layerKey)) return LAYER_INSTANCES.get(layerKey);
  const layer = { ...LAYERS[layerKey], key: layerKey, queue: Promise.resolve() };
  LAYER_INSTANCES.set(layerKey, layer);
  return layer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3/6 — Operações read/write por camada.
// Para camadas onde os dados já vivem em outro módulo (GenesisStore,
// UserMemoryStore), expomos *ponteiros* sem duplicar arquivos.
// ─────────────────────────────────────────────────────────────────────────────

export async function put(layerKey, key, value, { ttl_ms } = {}) {
  const layer = ensure(layerKey);
  const exp = ttl_ms ?? layer.ttl_ms;
  const entry = { value, expiresAt: exp ? Date.now() + exp : null };
  if (layer.storage === ':memory:') {
    layer.memory ??= new Map();
    return queue(layer, async () => layer.memory.set(key, entry));
  }
  // Fonte externa: manter protocolo JSON para permitir sync entre camadas
  // sem assumir estrutura proprietária dos outros módulos.
  const external = layer.externalWriter || defaultWriter(layer.storage);
  return queue(layer, async () => external(key, entry));
}

export async function get(layerKey, key) {
  const layer = ensure(layerKey);
  if (layer.storage === ':memory:') {
    const entry = layer.memory?.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      layer.memory.delete(key);
      return null;
    }
    return entry.value;
  }
  const external = layer.externalReader || defaultReader(layer.storage);
  const entry = await external(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) return null;
  return entry.value;
}

async function defaultWriter(storage) {
  // Para camadas sem writer custom: arquivo JSONL simples com TTL embutido.
  return async (key, entry) => {
    await mkdir(storage, { recursive: true });
    const line = JSON.stringify({ key, ...entry, writtenAt: Date.now() });
    await writeFile(`${storage}/_memory_layer.jsonl`, line + '\n', { flag: 'a' });
  };
}

async function defaultReader(storage) {
  return async (key) => {
    const raw = await readFile(`${storage}/_memory_layer.jsonl`, 'utf8').catch(() => '');
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const row = JSON.parse(line);
        if (row.key === key) return row;
      } catch { /* sequencial: linha corrompida é pulada */ }
    }
    return null;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 4/6 — Snapshot consolidado (lê tudo que está vivo agora).
// ─────────────────────────────────────────────────────────────────────────────

export async function snapshot() {
  const collected = {};
  for (const key of Object.keys(LAYERS)) await collectLayer(key, collected);
  return collected;
}

async function collectLayer(key, target) {
  const layer = ensure(key);
  if (layer.storage === ':memory:') {
    target[key] = Object.fromEntries(layer.memory || []);
    return;
  }
  const reader = layer.externalReader || defaultReader(layer.storage);
  const raw = await readFile(`${layer.storage}/_memory_layer.jsonl`, 'utf8').catch(() => '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  target[key] = {};
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.expiresAt && row.expiresAt < Date.now()) continue;
      target[key][row.key] = row.value;
    } catch { /* ignora */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 5/6 — Adapters leves — ligam camadas a módulos já existentes sem
// duplicar dados. Stubs aguardando wiring (são overrideGenesispoints).
// ─────────────────────────────────────────────────────────────────────────────

export function attachUserMemoryAdapter(userMemoryStore) {
  // Layer "user" consulta o UserMemoryStore existente.
  const layer = ensure('user');
  layer.externalReader = async () => {
    // O GenESI não substitui a preferência — apenas a serve como snapshot.
    return { key: 'preferences', value: userMemoryStore.publicState(), expiresAt: null };
  };
}

export function attachGenesisStoreAdapter(genesisStore) {
  const layer = ensure('conversation');
  layer.externalReader = async () => {
    const convos = genesisStore.listConversations();
    return { key: 'index', value: convos, expiresAt: null };
  };
}

export function attachProjectStoreAdapter(projectStore) {
  const layer = ensure('project');
  layer.externalReader = async () => {
    const summary = projectStore.summary();
    return { key: 'summary', value: summary, expiresAt: null };
  };
}

export function attachKnowledgeGraphAdapter(supremeMind) {
  // Layer "architectural" aprovisiona um cache do grafo de Suprememind.
  const layer = ensure('architectural');
  layer.supremeMind = supremeMind;
  layer.externalReader = async () => {
    if (!supremeMind.isIndexed()) return null;
    const info = supremeMind.getProjectInfo();
    return { key: 'graph-summary', value: info, expiresAt: null };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 6/6 — Bootstrap: lê o GENESIS_KNOWLEDGE_BASE.md como camada "knowledge".
// ─────────────────────────────────────────────────────────────────────────────

let knowledgeBaseText = null;
export async function loadKnowledgeBase(projectRoot) {
  try {
    const raw = await readFile(`${projectRoot}/GENESIS_KNOWLEDGE_BASE.md`, 'utf8');
    knowledgeBaseText = raw;
    const layer = ensure('knowledge');
    layer.externalReader = async () => ({ key: 'knowledge-base', value: raw, expiresAt: null });
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function getKnowledgeBaseText() { return knowledgeBaseText; }

export function reset() {
  LAYER_INSTANCES.clear();
  knowledgeBaseText = null;
}
