import fs from 'node:fs';
import path from 'node:path';
import { assertFreeOpenRouterModels } from './core/policy.js';

const packageMetadata = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const GENESIS_VERSION = String(packageMetadata.version);

export function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function loadLocalEnv(root = process.cwd()) {
  for (const filename of ['.env.local', '.env']) {
    const target = path.join(root, filename);
    if (!fs.existsSync(target)) continue;
    const content = fs.readFileSync(target, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index < 1) continue;
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    break;
  }
}

const toInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function createConfig(root = process.cwd()) {
  loadLocalEnv(root);
  const openRouterModels = String(process.env.OPENROUTER_FREE_MODELS || 'openrouter/free').split(',').map(item => item.trim()).filter(Boolean);
  assertFreeOpenRouterModels(openRouterModels);
  const host = String(process.env.GENESIS_HOST || '127.0.0.1').trim();
  if (!isLoopbackHost(host)) {
    const error = new Error('GENESIS_HOST deve permanecer em loopback (127.0.0.1, ::1 ou localhost). Acesso remoto seguro ainda não é suportado.');
    error.code = 'unsafe_remote_bind';
    throw error;
  }

  return {
    version: GENESIS_VERSION,
    root,
    host,
    port: toInt(process.env.GENESIS_PORT, 7331, 1, 65535),
    dataDir: path.resolve(root, process.env.GENESIS_DATA_DIR || '.genesis'),
    requestTimeoutMs: toInt(process.env.GENESIS_REQUEST_TIMEOUT_MS, 60000, 5000, 300000),
    discoveryTimeoutMs: toInt(process.env.GENESIS_DISCOVERY_TIMEOUT_MS, 6000, 1000, 30000),
    inputTokenBudget: toInt(process.env.GENESIS_INPUT_TOKEN_BUDGET, 12000, 2000, 128000),
    outputTokenBudget: toInt(process.env.GENESIS_OUTPUT_TOKEN_BUDGET, 8192, 256, 32768),
    maxRoutesPerMessage: toInt(process.env.GENESIS_MAX_ROUTES_PER_MESSAGE, 4, 1, 6),
    maxRequestsPerMessage: toInt(process.env.GENESIS_MAX_REQUESTS_PER_MESSAGE, 5, 1, 12),
    // O contrato da tarefa controla o teto efetivo. Tarefas comuns de edição
    // permanecem econômicas e tarefas de alta complexidade podem usar até 14 chamadas.
    maxToolRequestsPerMessage: toInt(process.env.GENESIS_MAX_TOOL_REQUESTS_PER_MESSAGE, 14, 2, 16),
    maxToolRounds: toInt(process.env.GENESIS_MAX_TOOL_ROUNDS, 12, 1, 12),
    maxMessageCharacters: toInt(process.env.GENESIS_MAX_MESSAGE_CHARACTERS, 120000, 20000, 500000),
    providers: {
      openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        models: openRouterModels,
        baseUrl: 'https://openrouter.ai/api/v1'
      }
    },
    images: {
      aiHorde: {
        apiKey: process.env.AI_HORDE_API_KEY || '0000000000',
        baseUrl: process.env.AI_HORDE_BASE_URL || 'https://aihorde.net/api/v2',
        generationTimeoutMs: toInt(process.env.GENESIS_IMAGE_TIMEOUT_MS, 180000, 30000, 300000),
        pollIntervalMs: toInt(process.env.GENESIS_IMAGE_POLL_MS, 1500, 500, 10000)
      }
    }
  };
}
