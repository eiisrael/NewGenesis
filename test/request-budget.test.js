import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceBudget, createUsageLedger, recordUsage, finalUsage } from '../src/core/request-budget.js';

test('o orçamento bloqueia flood acima do teto por mensagem', () => {
  const budget = new InferenceBudget(2);
  budget.consume({ model: 'a:free' });
  budget.consume({ model: 'b:free' });
  assert.throws(() => budget.consume({ model: 'c:free' }), error => error.code === 'request_budget_exhausted');
  assert.deepEqual(budget.snapshot(), { limit: 2, used: 2, remaining: 0 });
});

test('a contabilidade soma medição real e estimativa sem esconder requisições', () => {
  const budget = new InferenceBudget(4);
  const ledger = createUsageLedger();
  budget.consume({ model: 'a:free' });
  recordUsage(ledger, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0 });
  budget.consume({ model: 'b:free' });
  recordUsage(ledger, {}, { inputTokens: 80, outputTokens: 10 });
  budget.consume({ model: 'c:free' });
  const usage = finalUsage(ledger, budget);
  assert.deepEqual({ input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens }, { input: 180, output: 30, total: 210 });
  assert.equal(usage.requestCount, 3);
  assert.equal(usage.reportedRequests, 1);
  assert.equal(usage.estimatedRequests, 1);
  assert.equal(usage.unknownRequests, 1);
  assert.equal(usage.accuracy, 'mixed');
});
