import test from 'node:test';
import assert from 'node:assert/strict';
import { GenesisOrchestrator } from '../src/core/orchestrator.js';
import { ContextEngine } from '../src/core/context-engine.js';
import { ProviderError } from '../src/core/errors.js';
import { recordUsage, finalUsage } from '../src/core/request-budget.js';

const conversation = { id: 'visual-budget', messages: [{ id: 'u1', role: 'user', content: 'Crie uma imagem realista de um gato.' }] };
const create = imageProviders => new GenesisOrchestrator({
  providers: [], imageProviders, contextEngine: new ContextEngine(), maxInferenceRequests: 2, maxToolRequests: 8
});

test('imagem compartilha orçamento entre fallbacks, mantém modo visual e contabiliza falhas', async () => {
  let initialBudget;
  const first = {
    id: 'first', name: 'First', async generateImage({ requestBudget, mode }) {
      initialBudget = requestBudget;
      assert.equal(mode, 'balanced');
      assert.equal(requestBudget.limit, 2);
      requestBudget.consume({ providerId: this.id, model: 'first:free', estimatedInputTokens: 80 });
      throw new ProviderError('indisponível', { category: 'availability' });
    }
  };
  const second = {
    id: 'second', name: 'Second', async generateImage({ requestBudget, usageLedger }) {
      assert.equal(requestBudget, initialBudget);
      const number = requestBudget.consume({ providerId: this.id, model: 'second:free', estimatedInputTokens: 60 });
      recordUsage(usageLedger, { inputTokens: 60 }, {}, { requestNumber: number, model: 'second:free' });
      return { model: 'second:free', generatedImages: [], usage: finalUsage(usageLedger, requestBudget) };
    }
  };
  const result = await create([first, second]).respond({
    conversation, mode: 'balanced', tools: [{ function: { name: 'write_project_file' } }], toolExecutor() {}
  });
  assert.equal(result.usage.requestCount, 2);
  assert.equal(result.usage.unknownRequests, 1);
  assert.equal(result.usage.inputTokens, 140);
});

test('exaustão visual encerra rotas com consumo preservado', async () => {
  let fallbackCalled = false;
  const provider = { id: 'first', async generateImage({ requestBudget }) {
    requestBudget.consume({ estimatedInputTokens: 10 });
    requestBudget.consume({ estimatedInputTokens: 10 });
    requestBudget.consume({ estimatedInputTokens: 10 });
  } };
  const fallback = { id: 'fallback', async generateImage() { fallbackCalled = true; } };
  await assert.rejects(create([provider, fallback]).respond({ conversation }), error => {
    assert.equal(error.code, 'request_budget_exhausted');
    assert.equal(error.usage.requestCount, 2);
    return true;
  });
  assert.equal(fallbackCalled, false);
});
