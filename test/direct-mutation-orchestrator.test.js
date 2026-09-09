import test from 'node:test';
import assert from 'node:assert/strict';
import { GenesisOrchestrator } from '../src/core/orchestrator.js';
import { createTaskContract } from '../src/core/task-contract.js';

const writeTool = {
  type: 'function',
  function: {
    name: 'write_project_file',
    description: 'Grava arquivo.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } }
    }
  }
};

const batchWriteTool = {
  type: 'function',
  function: {
    name: 'write_project_files',
    description: 'Grava vários arquivos.',
    parameters: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'content'],
            properties: { path: { type: 'string' }, content: { type: 'string' } }
          }
        }
      }
    }
  }
};

function contextFor(conversation) {
  return {
    messages: [
      { role: 'system', content: 'Você é o Genesis.' },
      ...conversation.messages.map(message => ({ role: message.role, content: message.content }))
    ],
    estimatedTokens: 40,
    canonicalTokens: 40,
    contextWindow: 32_000,
    inputBudget: 12_000,
    outputReserve: 2_000,
    retainedMessages: conversation.messages.length,
    totalMessages: conversation.messages.length,
    compactedMessages: 0,
    projectFiles: 0,
    projectTotalFiles: 0,
    savedTokens: 0,
    memoryRetainedPercent: 100,
    usedTokens: 40,
    remainingTokens: 31_960,
    budgetAllocation: {},
    reused: false
  };
}

test('criação simples faz uma inferência, grava e finaliza com relatório local', async () => {
  let generateCalls = 0;
  let toolCalls = 0;
  const provider = {
    id: 'fake-free',
    name: 'Fake Free',
    handlesRequestBudget: false,
    publicStatus() {
      return {
        configured: true,
        latencyMs: 0,
        failureCount: 0,
        remainingRequests: null,
        remainingTokens: null
      };
    },
    async resolveCandidates() {
      return [{
        model: 'fake:free',
        displayName: 'Fake Free',
        contextWindow: 32_000,
        outputLimit: 4_000,
        score: 100,
        supportsTools: true
      }];
    },
    async generate({ tools }) {
      generateCalls += 1;
      assert.deepEqual(tools.map(item => item.function.name), ['write_project_file']);
      return {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'call-write',
          type: 'function',
          function: {
            name: 'write_project_file',
            arguments: JSON.stringify({ path: 'index.html', content: '<!doctype html><html><body>OK</body></html>' })
          }
        }],
        model: 'fake:free',
        resolvedModel: 'fake:free',
        resolvedProvider: 'Fake Free',
        latencyMs: 5,
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, requestCount: 1 }
      };
    },
    markSuccess() {}
  };

  const conversation = {
    id: 'conversation-direct',
    lastProviderId: null,
    messages: [{ id: 'u1', role: 'user', content: 'Crie um index.html na pasta do projeto' }]
  };
  const taskContract = createTaskContract(conversation.messages[0].content, {
    project: { id: 'project', name: 'Teste', fileCount: 0, writable: true }
  });
  assert.equal(taskContract.requestBudget.limit, 1);

  const orchestrator = new GenesisOrchestrator({
    providers: [provider],
    contextEngine: { buildIncremental: async () => contextFor(conversation) },
    outputTokenBudget: 4_000,
    maxRoutes: 1,
    maxInferenceRequests: 4,
    maxToolRequests: 14,
    maxToolRounds: 12
  });

  const result = await orchestrator.respond({
    conversation,
    mode: 'code',
    taskContract,
    tools: [writeTool],
    toolExecutor: async call => {
      toolCalls += 1;
      assert.equal(call.function.name, 'write_project_file');
      return { ok: true, path: 'index.html', summary: 'index.html atualizado com segurança.' };
    }
  });

  assert.equal(generateCalls, 1);
  assert.equal(toolCalls, 1);
  assert.match(result.content, /Alterações realizadas/);
  assert.match(result.content, /index\.html/);
  assert.match(result.content, /Alterações aplicadas/);
  assert.equal(result.verification.status, 'partial');
  assert.equal(result.usage.requestCount, 1);
});

test('serviço multi-arquivo para após gravação confirmada e não estoura orçamento repetindo a mutação', async () => {
  let generateCalls = 0;
  let toolCalls = 0;
  const files = [
    { path: 'index.html', content: '<!doctype html>\n<html><body><script src="script.js"></script></body></html>' },
    { path: 'styles.css', content: 'body {\n  margin: 0;\n}' },
    { path: 'script.js', content: 'const ready = true;\nconsole.log(ready);' }
  ];
  const provider = {
    id: 'fake-free',
    name: 'Fake Free',
    handlesRequestBudget: false,
    publicStatus() {
      return {
        configured: true,
        latencyMs: 0,
        failureCount: 0,
        remainingRequests: null,
        remainingTokens: null
      };
    },
    async resolveCandidates() {
      return [{
        model: 'fake:free',
        displayName: 'Fake Free',
        contextWindow: 32_000,
        outputLimit: 4_000,
        score: 100,
        supportsTools: true
      }];
    },
    async generate({ tools }) {
      generateCalls += 1;
      if (generateCalls === 1) {
        assert.deepEqual(tools.map(item => item.function.name), ['write_project_files']);
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'call-batch-write',
            type: 'function',
            function: {
              name: 'write_project_files',
              arguments: JSON.stringify({ files })
            }
          }],
          model: 'fake:free',
          resolvedModel: 'fake:free',
          resolvedProvider: 'Fake Free',
          latencyMs: 5,
          usage: { inputTokens: 40, outputTokens: 60, totalTokens: 100, requestCount: 1 }
        };
      }
      assert.deepEqual(tools, []);
      return {
        content: 'Arquivos criados e confirmados no projeto.',
        finishReason: 'stop',
        toolCalls: [],
        model: 'fake:free',
        resolvedModel: 'fake:free',
        resolvedProvider: 'Fake Free',
        latencyMs: 4,
        usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45, requestCount: 1 }
      };
    },
    markSuccess() {}
  };

  const conversation = {
    id: 'conversation-service-batch',
    lastProviderId: null,
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'Crie uma página bonita em HTML, CSS e JS e salve os arquivos na pasta do projeto.'
    }]
  };
  const taskContract = createTaskContract(conversation.messages[0].content, {
    project: { id: 'project', name: 'Teste', fileCount: 0, writable: true }
  });
  assert.equal(taskContract.toolPolicy.mutationIntent, 'create_project');
  assert.equal(taskContract.requestBudget.limit, 3);

  const orchestrator = new GenesisOrchestrator({
    providers: [provider],
    contextEngine: { buildIncremental: async () => contextFor(conversation) },
    outputTokenBudget: 4_000,
    maxRoutes: 1,
    maxInferenceRequests: 4,
    maxToolRequests: 14,
    maxToolRounds: 12
  });

  const result = await orchestrator.respond({
    conversation,
    mode: 'code',
    taskContract,
    tools: [batchWriteTool],
    toolExecutor: async call => {
      toolCalls += 1;
      assert.equal(call.function.name, 'write_project_files');
      return {
        ok: true,
        verified: true,
        paths: files.map(file => file.path),
        summary: '3 arquivo(s) gravado(s) e confirmado(s) por releitura no disco: index.html, styles.css, script.js.'
      };
    }
  });

  assert.equal(toolCalls, 1);
  assert.equal(generateCalls, 2);
  assert.equal(result.verification.status, 'partial');
  assert.equal(result.usage.requestCount, 2);
  assert.match(result.content, /confirmados/i);
  assert.doesNotMatch(result.content, /orçamento seguro/i);
});
