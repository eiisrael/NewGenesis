import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMemoryStore } from '../src/user-memory.js';
import { ContextEngine } from '../src/core/context-engine.js';

test('preferências multimodais persistem e a correção mais recente prevalece', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-preferences-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const memory = await new UserMemoryStore(directory).init();
  await memory.observe('Prefiro respostas detalhadas. Prefiro imagens realistas. Quero voz natural.');
  await memory.observe('Prefiro respostas curtas.');
  const restored = await new UserMemoryStore(directory).init();
  const context = await restored.context('Explique e ilustre.');
  assert.match(context, /diretas e compactas/);
  assert.doesNotMatch(context, /Explicações completas/);
  assert.match(context, /realismo fotográfico/);
  assert.match(context, /frases naturais/);
  await restored.observe('Quero uma imagem em anime só desta vez.');
  await restored.observe('Quero uma imagem em anime.');
  assert.match(await restored.context(), /realismo fotográfico/);
  await restored.observe('Traduza a frase: "Olá. Prefiro imagens em aquarela."');
  await restored.observe('Traduza: Prefiro imagens em aquarela.');
  assert.match(await restored.context(), /realismo fotográfico/);
  await restored.observe('Prefiro imagem em aquarela.');
  assert.match(await restored.context(), /Imagens em aquarela/);
  await restored.observe('Prefiro imagem realista.');
  assert.match(await restored.context(), /realismo fotográfico/);
  await restored.observe('Não quero mais respostas curtas, prefiro respostas detalhadas.');
  assert.match(await restored.context(), /Explicações completas/);
  assert.doesNotMatch(await restored.context(), /diretas e compactas/);
  await restored.clear();
  assert.equal(await restored.context(), '');
});

test('memória desativada não consulta projetos e seleção de projeto não mistura memórias', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-memory-scope-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const source = label => ({
    isIndexed: () => true,
    async listMemories() { calls += 1; return [{ title: label, content: label, files: [] }]; }
  });
  const memory = await new UserMemoryStore(directory, source('PROJETO_ANTIGO')).init();
  await memory.setEnabled(false);
  assert.equal(await memory.context('memória'), '');
  assert.equal(calls, 0);
  await memory.setEnabled(true);
  const context = await memory.context('memória', { supremeMind: source('PROJETO_ATUAL') });
  assert.match(context, /PROJETO_ATUAL/);
  assert.doesNotMatch(context, /PROJETO_ANTIGO/);
});

test('cache detecta edição, remoção e mudança de anexo sem novos IDs', async () => {
  const conversation = { id: 'mutable', title: 'Histórico', messages: [
    { id: 'u1', role: 'user', content: 'Banco escolhido: SQLite.' },
    { id: 'a1', role: 'assistant', content: 'Registrado SQLite.' },
    { id: 'u2', role: 'user', content: 'Qual banco?', attachments: [{ id: 'a', name: 'decisao.txt', kind: 'text', text: 'VERSAO_ANTIGA', size: 10 }] }
  ] };
  const engine = new ContextEngine({ inputTokenBudget: 5000 });
  const options = { conversation, query: 'Qual banco?' };
  const first = await engine.build(options);
  first.messageIds = conversation.messages.map(item => item.id);
  assert.equal((await engine.buildIncremental({ ...options, previousContext: first })).reused, true);
  conversation.messages[0].content = 'Banco escolhido: PostgreSQL.';
  conversation.messages.splice(1, 1);
  conversation.messages.at(-1).attachments[0].text = 'VERSAO_ATUAL';
  const next = await engine.buildIncremental({ ...options, previousContext: first });
  assert.equal(next.reused, false);
  assert.match(JSON.stringify(next.messages), /PostgreSQL/);
  assert.match(JSON.stringify(next.messages), /VERSAO_ATUAL/);
  assert.doesNotMatch(JSON.stringify(next.messages), /SQLite|VERSAO_ANTIGA/);
});

test('tarefas de código e depuração preservam preferências no contexto', async () => {
  const engine = new ContextEngine({ inputTokenBudget: 6000 });
  for (const query of ['Implemente a função.', 'Corrija o erro.']) {
    const context = await engine.build({
      conversation: { title: 'Código', messages: [{ id: 'u1', role: 'user', content: query }] }, query,
      userMemoryContext: 'PREFERÊNCIA_CONFIRMADA: respostas diretas, valide mudanças.'
    });
    assert.match(context.messages[0].content, /PREFERÊNCIA_CONFIRMADA/);
    assert.ok(context.budgetAllocation.memory > 0);
  }
});

test('cache usa a geração do SupremeMind configurado no engine', async () => {
  const sm = {
    revision: 'v1', isIndexed: () => true,
    getProjectInfo() { return { generatedAt: this.revision }; },
    async getContext() { return { markdown: this.revision }; }
  };
  const engine = new ContextEngine({ supremeMind: sm });
  const options = { conversation: { title: 'Projeto', messages: [{ id: 'u1', role: 'user', content: 'Analise.' }] }, query: 'Analise.' };
  const first = await engine.build(options);
  first.messageIds = ['u1'];
  assert.equal((await engine.buildIncremental({ ...options, previousContext: first })).reused, true);
  sm.revision = 'v2';
  assert.equal((await engine.buildIncremental({ ...options, previousContext: first })).reused, false);
});
