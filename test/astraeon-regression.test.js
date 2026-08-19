import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeModelText, opaqueTokenEstimate } from '../src/core/content-sanitizer.js';
import { createTaskContract } from '../src/core/task-contract.js';
import { InferenceBudget } from '../src/core/request-budget.js';
import { ContextEngine } from '../src/core/context-engine.js';
import { GenesisOrchestrator } from '../src/core/orchestrator.js';
import { ProjectStore } from '../src/project-store.js';
import {
  ProjectToolExecutor,
  projectToolDefinitionsFor
} from '../src/project-tools.js';

const ASTRAEON_PROMPT = 'Analise o Astraeon e retorne um bash com as informações do projeto.';

const astraeonProject = Object.freeze({
  id: 'astraeon-project',
  name: 'ASTRAEON',
  fileCount: 10,
  writable: true
});

function embeddedPng(characters = 96_000) {
  const prefix = 'iVBORw0KGgoAAAANSUhEUgAA';
  return `data:image/png;base64,${prefix}${'A'.repeat(Math.max(256, characters - prefix.length))}`;
}

async function writableFixture(t, { longLines = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-astraeon-regression-'));
  const dataDirectory = path.join(directory, 'data');
  const projectDirectory = path.join(directory, 'ASTRAEON');
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.mkdir(path.join(projectDirectory, 'Memory'), { recursive: true });

  const lines = Array.from({ length: 900 }, (_, index) => {
    if (index === 110) return `const portrait = ${JSON.stringify(embeddedPng())};`;
    const suffix = longLines ? 'x'.repeat(96) : 'cena jogável';
    return `linha ${String(index + 1).padStart(4, '0')} ${suffix}`;
  });
  await fs.writeFile(path.join(projectDirectory, 'index.html'), [
    '<!doctype html>',
    '<html><body><canvas id="game"></canvas><script>',
    ...lines,
    '</script></body></html>'
  ].join('\n'));
  await fs.writeFile(path.join(projectDirectory, 'game-editor.html'), '<!doctype html><title>Editor ASTRAEON</title>\n');
  await fs.writeFile(path.join(projectDirectory, 'Memory', 'README.md'), '# ASTRAEON\nJogo 2D executado no navegador.\n');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new ProjectStore(dataDirectory).init();
  await store.openPath(projectDirectory);
  return { store, directory, projectDirectory };
}

test('sanitizador remove data URI e bloco base64 antes de montar o contexto do modelo', () => {
  const opaque = 'Q'.repeat(4_096);
  const source = [
    '<section>ASTRAEON</section>',
    `<img src="${embeddedPng()}">`,
    `const opaqueAsset = "${opaque}";`
  ].join('\n');

  assert.ok(opaqueTokenEstimate(source) > 70_000, 'o preflight deve tratar base64 como caro');
  const sanitized = sanitizeModelText(source, { maxCharacters: 16_000, maxLineCharacters: 3_000 });

  assert.equal(sanitized.dataUriCount, 1);
  assert.ok(sanitized.removedOpaqueCharacters >= 100_000);
  assert.match(sanitized.text, /omitidos localmente/);
  assert.doesNotMatch(sanitized.text, /data:image\/png;base64,/i);
  assert.doesNotMatch(sanitized.text, /[AQ]{256,}/);
});

test('contrato reconhece o prompt exato do ASTRAEON como overview Bash inteiramente local', () => {
  const contract = createTaskContract(ASTRAEON_PROMPT, {
    project: astraeonProject,
    mode: 'balanced'
  });

  assert.equal(contract.kind, 'project_overview');
  assert.equal(contract.outputFormat, 'bash');
  assert.equal(contract.readOnly, true);
  assert.equal(contract.toolPolicy.strategy, 'local_project_profile');
  assert.deepEqual(contract.toolPolicy.allowed, []);
  assert.deepEqual(contract.requestBudget, {
    limit: 0,
    inputTokenLimit: 0,
    maxRequestInputTokens: 0,
    reserveFinal: 0,
    deadlineMs: 0
  });
});

test('relatório Bash do projeto é local, pequeno e nunca incorpora o base64 do ASTRAEON', async t => {
  const { store } = await writableFixture(t);
  const report = store.localReport('bash');

  assert.match(report, /^```bash\n#!\/usr\/bin\/env bash/m);
  assert.match(report, /readonly PROJECT_NAME='ASTRAEON'/);
  assert.match(report, /nenhum token de IA foi necessário/i);
  assert.match(report, /data URI\/base64 permanecem locais/i);
  assert.ok(report.length < 8_000, `relatório local inesperadamente grande: ${report.length}`);
  assert.doesNotMatch(report, /data:image\/png;base64,/i);
  assert.doesNotMatch(report, /A{256,}/);

  let remoteCalls = 0;
  const neverRemote = {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    publicStatus: () => ({ configured: true, state: 'online', failureCount: 0, remainingRequests: 100, remainingTokens: 100_000 }),
    resolveCandidates: async () => { remoteCalls += 1; throw new Error('não deveria rotear'); },
    markFailure() {},
    markSuccess() {}
  };
  const contract = createTaskContract(ASTRAEON_PROMPT, { project: store.summary(), mode: 'balanced' });
  const result = await new GenesisOrchestrator({
    providers: [neverRemote],
    contextEngine: new ContextEngine({ inputTokenBudget: 3_000, outputTokenBudget: 500 }),
    outputTokenBudget: 500
  }).respond({
    conversation: {
      id: 'astraeon-local',
      title: 'ASTRAEON',
      lastProviderId: null,
      messages: [{ id: 'u1', role: 'user', content: ASTRAEON_PROMPT, attachments: [] }]
    },
    mode: 'balanced',
    projectContext: store.contextFor(ASTRAEON_PROMPT),
    taskContract: contract,
    localResponse: report,
    tools: [{ type: 'function', function: { name: 'write_project_file' } }],
    toolExecutor: async () => { throw new Error('não deveria executar ferramenta'); }
  });

  assert.equal(remoteCalls, 0);
  assert.equal(result.providerId, 'genesis-local');
  assert.equal(result.usage.requestCount, 0);
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.content, report);
});

test('overview de projeto editável não recebe ferramentas e análise comum permanece somente leitura', () => {
  const overview = createTaskContract(ASTRAEON_PROMPT, { project: astraeonProject });
  assert.deepEqual(projectToolDefinitionsFor(overview, { writable: true }), []);

  const analysis = createTaskContract('Analise os riscos do fluxo de combate.', { project: astraeonProject });
  const names = projectToolDefinitionsFor(analysis, { writable: true })
    .map(tool => tool.function.name)
    .sort();
  assert.deepEqual(names, ['read_project_file', 'search_project']);
  assert.equal(analysis.readOnly, true);
  assert.equal(names.some(name => /write|delete|move|create/.test(name)), false);
});

test('orçamento cumulativo bloqueia a próxima requisição antes de exceder tokens', () => {
  const budget = new InferenceBudget({ limit: 6, inputTokenLimit: 10_000 });
  budget.consume({ providerId: 'openrouter', model: 'first:free', estimatedInputTokens: 6_400 });

  assert.throws(
    () => budget.consume({ providerId: 'openrouter', model: 'second:free', estimatedInputTokens: 3_601 }),
    error => error.code === 'input_token_budget_exhausted' && error.category === 'budget'
  );
  assert.deepEqual(budget.snapshot(), {
    limit: 6,
    used: 1,
    remaining: 5,
    inputTokenLimit: 10_000,
    sentInputTokens: 6_400,
    remainingInputTokens: 3_600
  });
});

test('leitura do projeto limita 400 linhas e 16K, remove base64 e informa a próxima página', async t => {
  const { store } = await writableFixture(t, { longLines: true });
  const executor = new ProjectToolExecutor({
    projectStore: store,
    permissionStore: { mode: 'full' },
    approvalManager: { request: () => { throw new Error('leitura não requer aprovação'); } }
  });
  const result = await executor.execute({
    function: {
      name: 'read_project_file',
      arguments: JSON.stringify({ path: 'index.html', start_line: 1, end_line: 900 })
    }
  }, { conversationId: 'astraeon-read' });

  assert.equal(result.ok, true);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 400);
  assert.ok(result.endLine - result.startLine + 1 <= 400);
  assert.equal(result.nextStartLine, 401);
  assert.ok(result.totalLines > 800);
  assert.ok(result.content.length <= 16_000, `trecho excedeu 16K: ${result.content.length}`);
  assert.equal(result.omittedDataUris, 1);
  assert.ok(result.omittedOpaqueCharacters >= 90_000);
  assert.doesNotMatch(result.content, /data:image\/png;base64,/i);
});

test('tool calls paralelas têm lote limitado e sempre deixam uma requisição para síntese', async () => {
  const provider = {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    calls: [],
    publicStatus() {
      return {
        configured: true,
        state: 'online',
        latencyMs: 5,
        failureCount: 0,
        remainingRequests: 100,
        remainingTokens: 100_000
      };
    },
    async resolveCandidates() {
      return [{
        providerId: this.id,
        model: 'parallel-tools:free',
        displayName: 'Parallel Tools Free',
        contextWindow: 32_768,
        outputLimit: 1_024,
        supportedParameters: ['tools', 'parallel_tool_calls'],
        supportsTools: true,
        score: 100,
        freeVerified: true
      }];
    },
    async generate(input) {
      this.calls.push(structuredClone({ messages: input.messages, tools: input.tools }));
      if (this.calls.length === 1) {
        return {
          content: '',
          model: 'parallel-tools:free',
          resolvedModel: 'parallel-tools:free',
          resolvedProvider: 'Mock',
          latencyMs: 4,
          finishReason: 'tool_calls',
          usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
          toolCalls: Array.from({ length: 7 }, (_, index) => ({
            id: `call-${index + 1}`,
            type: 'function',
            function: {
              name: 'read_project_file',
              arguments: JSON.stringify({ path: `src/file-${index + 1}.js` })
            }
          }))
        };
      }
      return {
        content: 'Síntese final produzida com as evidências limitadas.',
        model: 'parallel-tools:free',
        resolvedModel: 'parallel-tools:free',
        resolvedProvider: 'Mock',
        latencyMs: 3,
        finishReason: 'stop',
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        toolCalls: []
      };
    },
    markFailure() {},
    markSuccess() {},
    async probe() { return this.publicStatus(); }
  };

  const conversation = {
    id: 'astraeon-bounded-tools',
    title: 'Riscos de combate',
    lastProviderId: null,
    messages: [{
      id: 'u-analysis',
      role: 'user',
      content: 'Analise os riscos do fluxo de combate.',
      attachments: []
    }]
  };
  const contract = createTaskContract(conversation.messages[0].content, { project: astraeonProject });
  const tools = projectToolDefinitionsFor(contract, { writable: true });
  const executed = [];
  const events = [];
  const orchestrator = new GenesisOrchestrator({
    providers: [provider],
    contextEngine: new ContextEngine({ inputTokenBudget: 3_000, outputTokenBudget: 500 }),
    outputTokenBudget: 500,
    maxToolRequests: 12,
    maxToolRounds: 6,
    recoveryDelaysMs: []
  });

  const result = await orchestrator.respond({
    conversation,
    mode: 'balanced',
    projectContext: { text: 'Projeto ASTRAEON; fluxo de combate.', selectedFiles: [], totalFiles: 10 },
    taskContract: contract,
    tools,
    toolExecutor: async toolCall => {
      executed.push(toolCall.function.arguments);
      return { ok: true, path: JSON.parse(toolCall.function.arguments).path, summary: 'Arquivo lido.' };
    },
    onEvent: (event, payload) => events.push({ event, payload })
  });

  assert.equal(contract.toolPolicy.maxBatches, 1);
  assert.equal(contract.toolPolicy.maxCallsPerBatch, 4);
  assert.equal(contract.requestBudget.limit, 3);
  assert.equal(contract.requestBudget.reserveFinal, 1);
  assert.equal(executed.length, 4, 'somente quatro chamadas paralelas podem ser executadas');
  assert.equal(provider.calls.length, 2, 'uma rodada de exploração e uma de síntese');
  assert.equal(provider.calls[0].tools.length, 2);
  assert.deepEqual(provider.calls[1].tools, []);
  assert.match(JSON.stringify(provider.calls[1].messages), /Sintetize agora/i);
  assert.equal(result.content, 'Síntese final produzida com as evidências limitadas.');
  assert.equal(result.usage.requestCount, 2);
  assert.equal(result.usage.totalTokens, 250);
  assert.ok(events.some(item => item.event === 'inference_start' && item.payload.kind === 'final-synthesis'));
});
