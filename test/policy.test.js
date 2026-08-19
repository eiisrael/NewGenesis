import test from 'node:test';
import assert from 'node:assert/strict';
import { ADULT_CONTENT_MESSAGE, FREE_POLICY, GENESIS_SYSTEM_PROMPT, assertFreeOpenRouterModels, isAdultContent, isFreeOpenRouterModel } from '../src/core/policy.js';

test('a política não inclui provedores pagos', () => {
  assert.equal(FREE_POLICY.paidApisEnabled, false);
  assert.equal(FREE_POLICY.genericEndpointsEnabled, false);
  assert.deepEqual(FREE_POLICY.providers, ['openrouter', 'aihorde-image']);
  assert.equal(FREE_POLICY.providers.includes('openai'), false);
  assert.equal(FREE_POLICY.providers.includes('anthropic'), false);
  assert.equal(FREE_POLICY.providers.includes('gemini'), false);
  assert.equal(FREE_POLICY.providers.includes('groq'), false);
  assert.equal(FREE_POLICY.providers.includes('ollama'), false);
});

test('OpenRouter aceita somente o roteador free e variantes :free', () => {
  assert.equal(isFreeOpenRouterModel('openrouter/free'), true);
  assert.equal(isFreeOpenRouterModel('qwen/qwen3:free'), true);
  assert.equal(isFreeOpenRouterModel('openai/gpt-5'), false);
  assert.doesNotThrow(() => assertFreeOpenRouterModels(['openrouter/free', 'qwen/qwen3:free']));
  assert.throws(() => assertFreeOpenRouterModels(['openrouter/free', 'anthropic/claude-sonnet']), /free-only/);
});

test('bloqueia conteúdo adulto localmente com mensagem padronizada', () => {
  assert.equal(isAdultContent('Crie uma imagem NSFW'), true);
  assert.equal(isAdultContent('Escreva conteúdo pornográfico'), true);
  assert.equal(isAdultContent('Quero conteúdo +18'), true);
  assert.equal(isAdultContent('Ajude a revisar um painel profissional'), false);
  assert.equal(ADULT_CONTENT_MESSAGE, 'Não é permitido a utilização do serviço para criação de conteúdos impróprios.');
});

test('a identidade oficial reconhece Erick Israel como criador', () => {
  assert.match(GENESIS_SYSTEM_PROMPT, /criado por Erick Israel/);
  assert.match(GENESIS_SYSTEM_PROMPT, /conteúdo adulto/);
});
