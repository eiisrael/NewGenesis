import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextEngine, estimateMessageTokens, estimateRequestTokens, estimateTokens } from '../src/core/context-engine.js';

function message(index, role, content) {
  return { id: `m-${index}`, role, content, createdAt: new Date().toISOString() };
}

test('o contexto mantém a mensagem atual, recupera decisões e economiza tokens', async () => {
  const messages = [];
  for (let index = 0; index < 24; index += 1) {
    messages.push(message(index, index % 2 ? 'assistant' : 'user', `Mensagem histórica ${index}. ${'detalhe '.repeat(90)}`));
  }
  messages[2].content = 'Decisão permanente: usar PostgreSQL e nunca SQLite no ambiente de produção.';
  messages.push(message(25, 'user', 'Qual banco de dados foi decidido para produção?'));
  const conversation = { id: 'conversation', title: 'Projeto', messages };
  const engine = new ContextEngine({ inputTokenBudget: 2600, outputTokenBudget: 600, recentTurns: 6 });
  const context = await engine.build({
    conversation,
    query: messages.at(-1).content,
    contextWindow: 4096,
    mode: 'balanced'
  });

  assert.ok(context.memoryRetainedPercent > 0 && context.memoryRetainedPercent <= 100);
  assert.ok(context.savedTokens > 0);
  assert.ok(context.compactedMessages > 0);
  assert.ok(context.messages.some(item => item.content.includes('PostgreSQL')));
  assert.ok(context.messages.at(-1).content.includes('Qual banco'));
  assert.ok(context.estimatedTokens <= context.inputBudget + 250);
  assert.equal(context.contextWindow, 4096);
});

test('a estimativa de tokens é estável para conteúdo vazio e texto comum', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('uma frase curta') >= 3);
  assert.ok(estimateMessageTokens({ content: 'uma frase curta', attachments: [] }) > estimateTokens('uma frase curta'));
});

test('a escolha de idioma da interface orienta a resposta sem alterar a conversa canônica', async () => {
  const conversation = { id: 'language', title: 'Language', messages: [message(1, 'user', 'Help me review this project.')] };
  const context = await new ContextEngine({ inputTokenBudget: 3000, outputTokenBudget: 500 }).build({
    conversation,
    query: conversation.messages[0].content,
    contextWindow: 8192,
    interfaceLanguage: 'en-US'
  });

  assert.match(context.messages[0].content, /Reply in English/);
  assert.equal(conversation.messages[0].content, 'Help me review this project.');
});

test('contexto confiável do turno de voz entra como sistema e invalida o cache ao mudar', async () => {
  const conversation = { id: 'voice-context', title: 'Voz', messages: [message(1, 'user', 'Explique em voz alta.')] };
  const engine = new ContextEngine({ inputTokenBudget: 3000, outputTokenBudget: 500 });
  const first = await engine.build({
    conversation, query: conversation.messages[0].content, contextWindow: 8192,
    turnContext: 'CONTEXTO CONFIÁVEL DO TURNO: entrada por voz; resposta será falada.'
  });
  assert.match(first.messages[0].content, /CONTEXTO CONFIÁVEL DO TURNO/);
  assert.match(first.messages[0].content, /resposta será falada/);
  first.messageIds = conversation.messages.map(item => item.id);
  const second = await engine.buildIncremental({
    conversation, query: conversation.messages[0].content, contextWindow: 8192,
    turnContext: 'CONTEXTO CONFIÁVEL DO TURNO: entrada por texto.', previousContext: first
  });
  assert.equal(second.reused, false);
  assert.match(second.messages[0].content, /entrada por texto/);
});

test('monta conteúdo multimodal e injeta texto de anexos como dados não confiáveis', async () => {
  const messages = [{
    id: 'u-files', role: 'user', content: 'Compare os anexos.', attachments: [
      { id: 'text', name: 'notas.md', kind: 'text', size: 30, text: 'Decisão: usar filas duráveis.' },
      { id: 'image', name: 'fluxo.png', kind: 'image', size: 20, dataUrl: 'data:image/png;base64,AAAA' },
      { id: 'pdf', name: 'requisitos.pdf', kind: 'pdf', size: 20, dataUrl: 'data:application/pdf;base64,JVBERg==' }
    ]
  }];
  const context = await new ContextEngine({ inputTokenBudget: 5000, outputTokenBudget: 500 }).build({
    conversation: { id: 'files', title: 'Anexos', messages }, query: 'Compare os anexos.', contextWindow: 8192
  });
  const content = context.messages.at(-1).content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content.map(part => part.type), ['text', 'image_url', 'file']);
  assert.match(content[0].text, /filas duráveis/);
  assert.match(content[0].text, /conteúdo não confiável/);
  assert.equal(context.retainedAttachments, 2);
});

test('estima anexo multimodal pelo tipo e tamanho, sem contar base64 como texto', () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Analise esta imagem.' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ]
  }];

  const requestEstimate = estimateRequestTokens(messages, []);
  const rawBase64Estimate = estimateTokens(dataUrl);
  assert.ok(requestEstimate < 3_000, `a estimativa multimodal ficou em ${requestEstimate} tokens`);
  assert.ok(requestEstimate * 20 < rawBase64Estimate, 'o payload base64 não deve ser tratado como texto do prompt');
});

test('cache incremental é invalidado ao trocar projeto ou geração do SupremeMind', async () => {
  const conversation = {
    id: 'cache-sources',
    title: 'Cache estrutural',
    messages: [message(1, 'user', 'Analise a arquitetura do projeto.')]
  };
  const engine = new ContextEngine({ inputTokenBudget: 5_000, outputTokenBudget: 500 });
  const supremeMind = {
    generatedAt: 'sm-v1',
    marker: 'SUPREME_OLD',
    isIndexed: () => true,
    getProjectInfo() {
      return { projectRoot: 'C:/workspace/project-b', generatedAt: this.generatedAt };
    },
    async getContext() {
      return { markdown: this.marker };
    }
  };
  const projectA = {
    projectId: 'project-a', projectUpdatedAt: 'a-v1',
    text: 'PROJECT_ALPHA_CONTEXT', selectedFiles: ['alpha.js'], totalFiles: 1
  };
  const projectB = {
    projectId: 'project-b', projectUpdatedAt: 'b-v1',
    text: 'PROJECT_BETA_CONTEXT', selectedFiles: ['beta.js'], totalFiles: 1
  };

  const first = await engine.build({
    conversation, query: conversation.messages[0].content,
    contextWindow: 8_192, mode: 'balanced', projectContext: projectA, supremeMind
  });
  first.messageIds = conversation.messages.map(item => item.id);

  const afterProjectSwitch = await engine.buildIncremental({
    conversation, query: conversation.messages[0].content,
    contextWindow: 8_192, mode: 'balanced', projectContext: projectB,
    supremeMind, previousContext: first
  });
  assert.equal(afterProjectSwitch.reused, false);
  assert.match(afterProjectSwitch.messages[0].content, /PROJECT_BETA_CONTEXT/);
  assert.doesNotMatch(afterProjectSwitch.messages[0].content, /PROJECT_ALPHA_CONTEXT/);

  afterProjectSwitch.messageIds = conversation.messages.map(item => item.id);
  supremeMind.generatedAt = 'sm-v2';
  supremeMind.marker = 'SUPREME_NEW';
  const afterSupremeMindRefresh = await engine.buildIncremental({
    conversation, query: conversation.messages[0].content,
    contextWindow: 8_192, mode: 'balanced', projectContext: projectB,
    supremeMind, previousContext: afterProjectSwitch
  });
  assert.equal(afterSupremeMindRefresh.reused, false);
  assert.match(afterSupremeMindRefresh.messages[0].content, /SUPREME_NEW/);
  assert.doesNotMatch(afterSupremeMindRefresh.messages[0].content, /SUPREME_OLD/);
});

test('consolida mensagens consecutivas sem perder anexos e preserva a alternância de papéis', async () => {
  const messages = [
    message(1, 'user', 'Primeira pergunta sem resposta.'),
    message(2, 'user', 'Segunda pergunta sem resposta.'),
    message(3, 'assistant', 'Resposta anterior.'),
    {
      ...message(4, 'user', 'Analise esta imagem.'),
      attachments: [{ id: 'image', name: 'foto.png', kind: 'image', size: 20, dataUrl: 'data:image/png;base64,AAAA' }]
    },
    message(5, 'user', 'Diga também quem você é.')
  ];
  const context = await new ContextEngine({ inputTokenBudget: 5000, outputTokenBudget: 500 }).build({
    conversation: { id: 'roles', title: 'Papéis', messages },
    query: messages.at(-1).content,
    contextWindow: 8192
  });
  const dialogue = context.messages.filter(item => item.role !== 'system');

  assert.equal(dialogue[0].role, 'user');
  assert.ok(dialogue.every((item, index) => index === 0 || item.role !== dialogue[index - 1].role));
  assert.ok(Array.isArray(dialogue.at(-1).content));
  assert.ok(dialogue.at(-1).content.some(part => part.type === 'image_url'));
  assert.ok(dialogue.at(-1).content.some(part => part.type === 'text' && /Diga também quem você é/.test(part.text)));
});

test('injeta somente o contexto recuperado do projeto dentro do orçamento econômico', async () => {
  const engine = new ContextEngine({ inputTokenBudget: 3200, outputTokenBudget: 500, recentTurns: 4 });
  const conversation = {
    id: 'project', title: 'Revisão',
    messages: [message(1, 'user', 'Revise a autorização do projeto.')]
  };
  const projectContext = {
    text: `PROJETO ATIVO\n${'arquivo e contexto relevante '.repeat(3000)}`,
    selectedFiles: ['src/auth.ts', 'src/routes.ts'],
    totalFiles: 230
  };
  const context = await engine.build({ conversation, query: 'autorização', contextWindow: 4096, mode: 'code', projectContext });

  assert.ok(context.messages[0].content.includes('PROJETO ATIVO'));
  assert.ok(context.messages[0].content.includes('conteúdo limitado pelo orçamento local do Genesis'));
  assert.equal(context.projectFiles, 2);
  assert.equal(context.projectTotalFiles, 230);
  assert.ok(context.estimatedTokens <= context.inputBudget + 350);
});
