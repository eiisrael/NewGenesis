import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationalFailureMessage, resolveConversationalResponse } from '../src/core/conversation.js';

test('saudações simples recebem resposta local humana e preservam continuidade', () => {
  const first = resolveConversationalResponse({ query: 'Oi chat' });
  assert.equal(first.model, 'genesis-conversation-local');
  assert.equal(first.content, 'Oi! Estou aqui. Como posso ajudar?');

  const again = resolveConversationalResponse({
    query: 'Oi Genesis',
    conversation: { messages: [{ role: 'user', content: 'Oi chat' }, { role: 'assistant', content: first.content }] }
  });
  assert.match(again.content, /Oi novamente!/);
});

test('confirma mensagem de voz sem alterar a frase reconhecida', () => {
  const result = resolveConversationalResponse({
    query: 'Genesis está me ouvindo?',
    inputMode: 'voice'
  });
  assert.match(result.content, /Recebi sua mensagem por voz/);
  assert.match(result.content, /estou ouvindo você/);
});

test('saudação misturada a uma tarefa não é interceptada localmente', () => {
  assert.equal(resolveConversationalResponse({ query: 'Oi Genesis, corrija o login.' }), null);
});

test('falha conversacional não vira relatório de alteração do projeto', () => {
  const message = conversationalFailureMessage(new Error('Rotas ocupadas.'), { kind: 'answer' });
  assert.match(message, /modelos gratuitos estão temporariamente indisponíveis/);
  assert.match(message, /contexto da conversa foram preservados/);
  assert.doesNotMatch(message, /Relatório final|nenhuma alteração|operação no projeto/i);
});
