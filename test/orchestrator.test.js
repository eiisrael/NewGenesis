import test from 'node:test';
import assert from 'node:assert/strict';
import { GenesisOrchestrator } from '../src/core/orchestrator.js';
import { ContextEngine } from '../src/core/context-engine.js';
import { ProviderError } from '../src/core/errors.js';
import { createTaskContract } from '../src/core/task-contract.js';

class MockProvider {
  constructor(id, behavior, score = 20) {
    this.id = id;
    this.name = id.toUpperCase();
    this.behavior = behavior;
    this.score = score;
    this.calls = [];
    this.failures = 0;
    this.probeCalls = 0;
    this.lastSuccess = null;
  }

  publicStatus() {
    return {
      id: this.id, name: this.name, configured: true, state: 'online',
      latencyMs: 10, failureCount: this.failures, remainingRequests: 100, remainingTokens: 10000
    };
  }

  async resolveCandidate() {
    return { providerId: this.id, model: `${this.id}-free`, displayName: `${this.id} free`, contextWindow: 8192, score: this.score, freeVerified: true };
  }

  async generate(input) {
    this.calls.push(input);
    return this.behavior(this.calls.length, input);
  }

  markFailure() { this.failures += 1; }
  markSuccess(value) { this.lastSuccess = value; }
  async probe() { this.probeCalls += 1; return this.publicStatus(); }
}

const conversation = {
  id: 'session-1',
  title: 'Teste',
  lastProviderId: null,
  messages: [{ id: 'u1', role: 'user', content: 'Continue o plano sem perder contexto.' }]
};

function createOrchestrator(providers, imageProviders = null) {
  return new GenesisOrchestrator({
    providers,
    imageProviders,
    contextEngine: new ContextEngine({ inputTokenBudget: 3000, outputTokenBudget: 500 }),
    outputTokenBudget: 500,
    recoveryDelaysMs: []
  });
}

test('abre uma nova rodada automaticamente e preserva a mensagem quando as rotas estão ocupadas', async () => {
  const provider = new MockProvider('openrouter', call => {
    if (call === 1) throw new ProviderError('Cota temporária', {
      providerId: 'openrouter', category: 'quota', code: 'quota_exhausted'
    });
    return {
      content: 'Resposta recuperada sem novo envio.', model: 'openrouter/free', resolvedModel: 'dynamic-free',
      resolvedProvider: 'OpenRouter', latencyMs: 9, finishReason: 'stop',
      usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 }
    };
  }, 80);
  const orchestrator = new GenesisOrchestrator({
    providers: [provider],
    contextEngine: new ContextEngine({ inputTokenBudget: 3000, outputTokenBudget: 500 }),
    outputTokenBudget: 500,
    recoveryDelaysMs: [0]
  });
  const events = [];
  const result = await orchestrator.respond({
    conversation,
    mode: 'balanced',
    onEvent: (event, payload) => events.push({ event, payload })
  });

  assert.equal(result.content, 'Resposta recuperada sem novo envio.');
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0].sessionId, provider.calls[1].sessionId);
  assert.ok(events.some(item => item.event === 'recovery'));
});

test('usa a rede comunitária quando o catálogo principal não possui imagem gratuita', async () => {
  const textProvider = new MockProvider('openrouter', () => { throw new Error('não deveria usar chat'); }, 80);
  textProvider.generateImage = async () => {
    throw new ProviderError('Nenhum modelo gratuito de imagem.', {
      providerId: 'openrouter', category: 'availability', code: 'free_image_model_unavailable'
    });
  };
  const community = {
    id: 'aihorde-image', name: 'Rede comunitária gratuita', calls: 0,
    async generateImage() {
      this.calls += 1;
      return {
        content: 'Imagem criada.', generatedImages: [{ name: 'genesis.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
        model: 'community-model', resolvedModel: 'community-model', resolvedProvider: this.name,
        latencyMs: 20, finishReason: 'stop', attempts: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      };
    }
  };
  const imageConversation = {
    ...conversation,
    messages: [{ id: 'u-image-create', role: 'user', content: 'Crie uma imagem de uma árvore futurista.' }]
  };
  const events = [];
  const result = await createOrchestrator([textProvider], [textProvider, community]).respond({
    conversation: imageConversation,
    mode: 'balanced',
    onEvent: (event, payload) => events.push({ event, payload })
  });

  assert.equal(result.providerId, 'aihorde-image');
  assert.equal(community.calls, 1);
  assert.equal(textProvider.failures, 0);
  assert.ok(events.some(item => item.event === 'image_fallback'));
});

test('faz fallback para a próxima rota gratuita mantendo a mesma sessão', async () => {
  const first = new MockProvider('route-primary', () => {
    throw new ProviderError('Cota encerrada', { providerId: 'route-primary', category: 'quota', code: 'quota_exhausted' });
  }, 80);
  const second = new MockProvider('route-fallback', () => ({
    content: 'Plano continuado.', model: 'fallback-free', resolvedModel: 'fallback-free',
    resolvedProvider: 'OpenRouter', latencyMs: 12, finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
  }), 30);
  const events = [];
  const result = await createOrchestrator([first, second]).respond({
    conversation,
    mode: 'balanced',
    onEvent: (event, payload) => events.push({ event, payload })
  });

  assert.equal(result.providerId, 'route-fallback');
  assert.equal(result.content, 'Plano continuado.');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.context.contextWindow, 8192);
  assert.equal(result.context.usedTokens, 120);
  assert.equal(result.context.remainingTokens, 8072);
  assert.equal(result.context.usageAccuracy, 'mixed');
  assert.equal(result.usage.requestCount, 2);
  assert.equal(result.usage.unknownRequests, 1);
  assert.ok(events.some(item => item.event === 'fallback'));
  assert.equal(first.probeCalls, 0, 'não deve redescobrir todo o catálogo após cada falha');
  assert.equal(second.calls[0].sessionId, conversation.id);
  assert.ok(second.calls[0].messages.some(item => item.content.includes('Continue o plano')));
});

test('recompõe um contexto menor antes de abandonar o mesmo provedor', async () => {
  const provider = new MockProvider('openrouter', call => {
    if (call === 1) throw new ProviderError('context length exceeded', {
      providerId: 'openrouter', category: 'context', code: 'context_too_large'
    });
    return {
      content: 'Resposta compacta.', model: 'free', resolvedModel: 'free', resolvedProvider: 'router',
      latencyMs: 8, finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }
    };
  }, 80);
  const result = await createOrchestrator([provider]).respond({ conversation, mode: 'balanced' });
  assert.equal(result.content, 'Resposta compacta.');
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[1].messages.reduce((sum, item) => sum + item.content.length, 0)
    <= provider.calls[0].messages.reduce((sum, item) => sum + item.content.length, 0));
});

test('usa o binário durante a chamada sem devolvê-lo em métricas ou eventos', async () => {
  const provider = new MockProvider('openrouter', () => ({
    content: 'Imagem analisada.', model: 'openrouter/free', resolvedModel: 'vision-free', resolvedProvider: 'router',
    latencyMs: 8, finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }
  }), 80);
  const withImage = {
    ...conversation,
    messages: [{
      id: 'u-image', role: 'user', content: 'Analise.',
      attachments: [{ id: 'image', name: 'tela.png', kind: 'image', size: 20, dataUrl: 'data:image/png;base64,AAAA' }]
    }]
  };
  const events = [];
  const result = await createOrchestrator([provider]).respond({
    conversation: withImage, mode: 'balanced', onEvent: (event, payload) => events.push({ event, payload })
  });
  assert.match(JSON.stringify(provider.calls[0].messages), /data:image\/png;base64/);
  assert.equal('messages' in result.context, false);
  assert.equal(JSON.stringify(result).includes('data:image/png;base64'), false);
  assert.equal(JSON.stringify(events).includes('data:image/png;base64'), false);
});

test('base64 multimodal não provoca compactação artificial do prompt de sistema', async () => {
  const provider = new MockProvider('openrouter', () => ({
    content: 'Imagem analisada com o contexto integral.',
    model: 'openrouter/free', resolvedModel: 'vision-free', resolvedProvider: 'router',
    latencyMs: 8, finishReason: 'stop',
    usage: { inputTokens: 900, outputTokens: 10, totalTokens: 910 }
  }), 80);
  const multimodalConversation = {
    id: 'large-image-context',
    title: 'Imagem e projeto',
    lastProviderId: null,
    messages: [{
      id: 'u-large-image', role: 'user', content: 'Analise a imagem no contexto do projeto.',
      attachments: [{
        id: 'large-image', name: 'cena.png', kind: 'image', size: 1_572_864,
        dataUrl: `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`
      }]
    }]
  };
  const projectContext = {
    projectId: 'astraeon', projectUpdatedAt: 'v1',
    text: 'PROJETO ASTRAEON\nPROJECT_CONTEXT_SENTINEL',
    selectedFiles: ['game.js'], totalFiles: 1
  };
  const contextEngine = new ContextEngine({ inputTokenBudget: 3_000, outputTokenBudget: 500 });
  const expected = await contextEngine.build({
    conversation: multimodalConversation,
    query: multimodalConversation.messages[0].content,
    contextWindow: 8_192,
    mode: 'reasoning',
    projectContext
  });
  const orchestrator = new GenesisOrchestrator({
    providers: [provider], contextEngine, outputTokenBudget: 500, recoveryDelaysMs: []
  });

  await orchestrator.respond({
    conversation: multimodalConversation,
    mode: 'reasoning',
    projectContext
  });

  const sentSystem = provider.calls[0].messages.find(message => message.role === 'system')?.content;
  assert.equal(sentSystem, expected.messages.find(message => message.role === 'system')?.content);
  assert.match(sentSystem, /PROJECT_CONTEXT_SENTINEL/);
});

test('interrompe a rota ativa sem marcar o modelo como falho ou tentar fallback', async () => {
  const provider = new MockProvider('openrouter', (call, input) => new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(new ProviderError('Interrompida', {
      providerId: 'openrouter', category: 'cancelled', code: 'request_cancelled', retryable: false
    })), { once: true });
  }), 80);
  const controller = new AbortController();
  const response = createOrchestrator([provider]).respond({ conversation, mode: 'balanced', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();

  await assert.rejects(response, error => error.code === 'request_cancelled');
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.failures, 0);
});

test('atualiza silenciosamente uma rota em espera antes de informar indisponibilidade', async () => {
  const provider = new MockProvider('openrouter', () => ({
    content: 'Rota recuperada automaticamente.', model: 'openrouter/free', resolvedModel: 'free-recovered',
    resolvedProvider: 'OpenRouter', latencyMs: 10, finishReason: 'stop',
    usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 }
  }), 80);
  provider.recovered = false;
  provider.publicStatus = () => ({
    id: provider.id, name: provider.name, configured: true, state: provider.recovered ? 'online' : 'cooldown',
    latencyMs: 10, failureCount: 0, remainingRequests: 100, remainingTokens: 10000
  });
  provider.resolveCandidate = async () => provider.recovered
    ? { providerId: provider.id, model: 'openrouter/free', displayName: 'Free Models Router', contextWindow: 8192, score: 80, freeVerified: true }
    : null;
  provider.probe = async () => { provider.recovered = true; return provider.publicStatus(); };

  const result = await createOrchestrator([provider]).respond({ conversation, mode: 'balanced' });

  assert.equal(provider.recovered, true);
  assert.equal(provider.calls.length, 1);
  assert.equal(result.content, 'Rota recuperada automaticamente.');
});

test('valida a memória canônica antes de transferir para um modelo gratuito com contexto maior', async () => {
  const provider = new MockProvider('openrouter', () => ({
    content: 'CONTINUIDADE_VALIDADA', model: 'large:free', resolvedModel: 'large:free',
    resolvedProvider: 'OpenRouter', latencyMs: 9, finishReason: 'stop',
    usage: { inputTokens: 160, outputTokens: 4, totalTokens: 164 }
  }), 80);
  provider.configured = true;
  provider.catalog = [
    { id: 'small:free', name: 'Small Free', contextWindow: 8192, supportedParameters: [] },
    { id: 'large:free', name: 'Large Free', contextWindow: 131072, supportedParameters: ['tools'] }
  ];
  provider.models = async () => provider.catalog;
  provider.candidate = model => ({ providerId: provider.id, model, displayName: model, contextWindow: 131072, score: 1, freeVerified: true });
  const events = [];
  const handoff = await createOrchestrator([provider]).prepareHandoff({
    conversation: {
      ...conversation,
      messages: [
        conversation.messages[0],
        { id: 'a1', role: 'assistant', content: 'Plano aprovado.', meta: { model: 'small:free' } }
      ]
    },
    currentContextWindow: 8192,
    requirements: { tools: true },
    onEvent: (event, payload) => events.push({ event, payload })
  });

  assert.equal(handoff.model, 'large:free');
  assert.equal(handoff.contextWindow, 131072);
  assert.equal(handoff.validationTokens, 164);
  assert.match(JSON.stringify(provider.calls[0].messages), /Plano aprovado/);
  assert.ok(events.some(item => item.event === 'handoff_complete'));
});

test('executa ferramentas em etapas e entrega somente a resposta final ao chat', async () => {
  const provider = new MockProvider('openrouter', call => call === 1 ? {
    content: '', model: 'free', resolvedModel: 'free', resolvedProvider: 'router', latencyMs: 4,
    finishReason: 'tool_calls', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"README.md"}' } }]
  } : {
    content: 'Arquivo analisado e alteração concluída.', model: 'free', resolvedModel: 'free', resolvedProvider: 'router', latencyMs: 5,
    finishReason: 'stop', usage: { inputTokens: 25, outputTokens: 8, totalTokens: 33 }, toolCalls: []
  }, 80);
  const calls = [];
  const result = await createOrchestrator([provider]).respond({
    conversation, mode: 'code',
    tools: [{ type: 'function', function: { name: 'read_project_file', parameters: { type: 'object' } } }],
    toolExecutor: async toolCall => { calls.push(toolCall); return { ok: true, content: '# Projeto' }; }
  });
  assert.equal(calls.length, 1);
  assert.equal(provider.calls.length, 2);
  assert.equal(result.content, 'Arquivo analisado e alteração concluída.');
  assert.equal(result.usage.totalTokens, 57);
  assert.equal(result.context.usedTokens, 33);
  assert.equal(result.context.totalRequestTokens, 57);
  assert.match(JSON.stringify(provider.calls[1].messages), /tool_call_id/);
});

test('continua automaticamente uma resposta encerrada por limite', async () => {
  const provider = new MockProvider('openrouter', call => call === 1 ? {
    content: 'Primeira metade da resposta', model: 'free', resolvedModel: 'free', resolvedProvider: 'router',
    latencyMs: 4, finishReason: 'length', usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }
  } : {
    content: ' e conclusão.', model: 'free', resolvedModel: 'free', resolvedProvider: 'router',
    latencyMs: 4, finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 6, totalTokens: 46 }
  }, 80);
  const events = [];
  const result = await createOrchestrator([provider]).respond({
    conversation, mode: 'balanced', onEvent: (event, payload) => events.push({ event, payload })
  });
  assert.equal(result.content, 'Primeira metade da resposta\ne conclusão.');
  assert.equal(result.usage.requestCount, 2);
  assert.equal(result.usage.totalTokens, 86);
  assert.ok(events.some(item => item.event === 'continuation'));
});

test('resposta truncada após todas as continuações falha sem complete, fallback ou falso sucesso', async () => {
  const provider = new MockProvider('openrouter', call => ({
    content: `Trecho parcial ${call}.`,
    model: 'mock:free',
    resolvedModel: 'mock:free',
    resolvedProvider: 'OpenRouter',
    latencyMs: 4,
    finishReason: 'length',
    usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }
  }), 80);
  const events = [];
  const contract = createTaskContract(conversation.messages[0].content);

  await assert.rejects(() => createOrchestrator([provider]).respond({
    conversation,
    mode: 'balanced',
    taskContract: contract,
    onEvent: (event, payload) => events.push({ event, payload })
  }), error => {
    assert.equal(error.code, 'task_verification_failed');
    assert.equal(error.category, 'verification');
    assert.equal(error.retryable, false);
    assert.equal(error.task.id, contract.id);
    assert.equal(error.verification.status, 'failed');
    assert.equal(error.providerId, 'openrouter');
    assert.equal(error.model, 'mock:free');
    assert.equal(error.usage.requestCount, 3);
    assert.equal(error.usage.totalTokens, 120);
    assert.match(error.partialContent, /marcada como parcial/i);
    return true;
  });

  assert.equal(provider.calls.length, 3);
  assert.equal(provider.lastSuccess, null);
  assert.equal(provider.failures, 0);
  assert.equal(events.filter(item => item.event === 'complete').length, 0);
  assert.equal(events.filter(item => item.event === 'fallback').length, 0);
  assert.ok(events.some(item => item.event === 'verification' && item.payload.verification.status === 'failed'));
});

test('reserva fases de escrita e verificação depois da exploração sem remover as ferramentas cedo demais', async () => {
  const toolResult = (call, name, args) => ({
    content: '', model: 'free', resolvedModel: 'free', resolvedProvider: 'router', latencyMs: 4,
    finishReason: 'tool_calls', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
    toolCalls: [{ id: `call-${call}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  });
  const provider = new MockProvider('openrouter', (call, input) => {
    const enabled = input.tools.map(tool => tool.function.name);
    if (call <= 3) {
      assert.ok(enabled.includes('read_project_file'));
      return toolResult(call, 'read_project_file', { path: 'index.html', start_line: (call - 1) * 400 + 1 });
    }
    if (call === 4) {
      assert.deepEqual(enabled, ['replace_project_text']);
      assert.match(JSON.stringify(input.messages), /Fase obrigatória de execução/);
      return toolResult(call, 'replace_project_text', { path: 'index.html', old_text: 'mapa antigo', new_text: 'mapa aprimorado' });
    }
    if (call === 5) {
      assert.deepEqual(enabled, ['run_project_check']);
      return toolResult(call, 'run_project_check', {});
    }
    assert.deepEqual(enabled, []);
    return {
      content: 'Mapa alterado e verificado.', model: 'free', resolvedModel: 'free', resolvedProvider: 'router', latencyMs: 4,
      finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 }, toolCalls: []
    };
  }, 80);
  const mutationConversation = {
    ...conversation,
    messages: [{ id: 'u-change', role: 'user', content: 'Melhore o mapa e aplique as alterações completas.' }]
  };
  const project = { id: 'astraeon', name: 'ASTRAEON', fileCount: 11, writable: true };
  const contract = createTaskContract(mutationConversation.messages[0].content, { project });
  const evidence = [];
  const executed = [];
  const tools = ['read_project_file', 'replace_project_text', 'run_project_check'].map(name => ({
    type: 'function', function: { name, parameters: { type: 'object' } }
  }));

  const result = await createOrchestrator([provider]).respond({
    conversation: mutationConversation,
    mode: 'code',
    taskContract: contract,
    tools,
    _taskEvidence: evidence,
    toolExecutor: async toolCall => {
      executed.push(toolCall.function.name);
      return { ok: true, summary: `${toolCall.function.name} concluída` };
    }
  });

  assert.equal(provider.calls.length, 6);
  assert.deepEqual(executed, [
    'read_project_file', 'read_project_file', 'read_project_file',
    'replace_project_text', 'run_project_check'
  ]);
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.content, 'Mapa alterado e verificado.');
});

test('fallback preserva leituras e usa o orçamento restante para escrever em vez de reiniciar a exploração', async () => {
  const toolResult = (call, name, args) => ({
    content: '', model: 'free', resolvedModel: 'free', resolvedProvider: 'router', latencyMs: 4,
    finishReason: 'tool_calls', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 },
    toolCalls: [{ id: `primary-${call}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  });
  const primary = new MockProvider('primary', call => {
    if (call <= 3) return toolResult(call, 'read_project_file', { path: 'index.html', start_line: (call - 1) * 400 + 1 });
    throw new ProviderError('Fluxo interrompido pela rota.', {
      providerId: 'primary', category: 'network', code: 'stream_error', retryable: true
    });
  }, 90);
  const fallback = new MockProvider('fallback', (call, input) => {
    const enabled = input.tools.map(tool => tool.function.name);
    if (call === 1) {
      assert.deepEqual(enabled, ['replace_project_text']);
      assert.match(JSON.stringify(input.messages), /TRECHO_LIDO_801/);
      assert.match(JSON.stringify(input.messages), /Continuidade entre rotas gratuitas/);
      return {
        ...toolResult(5, 'replace_project_text', { path: 'index.html', old_text: 'mapa antigo', new_text: 'mapa aprimorado' }),
        toolCalls: [{ id: 'fallback-write', type: 'function', function: { name: 'replace_project_text', arguments: '{"path":"index.html","old_text":"mapa antigo","new_text":"mapa aprimorado"}' } }]
      };
    }
    assert.deepEqual(enabled, []);
    return {
      content: 'Alteração aplicada; a verificação disponível não coube no orçamento após a falha da primeira rota.',
      model: 'free', resolvedModel: 'free', resolvedProvider: 'router', latencyMs: 4,
      finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 }, toolCalls: []
    };
  }, 40);
  const mutationConversation = {
    ...conversation,
    messages: [{ id: 'u-fallback-change', role: 'user', content: 'Melhore o mapa e aplique as alterações completas.' }]
  };
  const contract = createTaskContract(mutationConversation.messages[0].content, {
    project: { id: 'astraeon', name: 'ASTRAEON', fileCount: 11, writable: true }
  });
  const tools = ['read_project_file', 'replace_project_text', 'run_project_check'].map(name => ({
    type: 'function', function: { name, parameters: { type: 'object' } }
  }));
  const result = await createOrchestrator([primary, fallback]).respond({
    conversation: mutationConversation,
    mode: 'code',
    taskContract: contract,
    tools,
    toolExecutor: async toolCall => toolCall.function.name === 'read_project_file'
      ? { ok: true, content: `TRECHO_LIDO_${JSON.parse(toolCall.function.arguments).start_line}` }
      : { ok: true, summary: 'index.html alterado' }
  });

  assert.equal(primary.calls.length, 4);
  assert.equal(fallback.calls.length, 2);
  assert.equal(result.verification.status, 'partial');
  assert.match(result.content, /Alteração aplicada/);
});

test('o teto global encerra tentativas sem percorrer todas as rotas', async () => {
  const providers = Array.from({ length: 5 }, (_, index) => new MockProvider(`route-${index}`, () => {
    throw new ProviderError('indisponível', { providerId: `route-${index}`, category: 'availability', code: 'provider_unavailable' });
  }, 100 - index));
  const orchestrator = new GenesisOrchestrator({
    providers,
    contextEngine: new ContextEngine({ inputTokenBudget: 3000, outputTokenBudget: 500 }),
    outputTokenBudget: 500,
    recoveryDelaysMs: [],
    maxRoutes: 3,
    maxInferenceRequests: 2
  });
  await assert.rejects(() => orchestrator.respond({ conversation, mode: 'balanced' }), error => {
    assert.match(error.message, /limite seguro|orçamento seguro/i);
    return true;
  });
  assert.equal(providers.reduce((sum, provider) => sum + provider.calls.length, 0), 2);
});
