import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalExecutionReport } from '../src/server.js';

test('relatório distingue aprovação de gravação realmente confirmada', () => {
  const error = Object.assign(new Error('O tempo total seguro desta tarefa foi atingido.'), {
    evidence: [{
      tool: 'replace_project_text',
      ok: false,
      summary: 'A edição esperava 1 ocorrência, mas encontrou 0.',
      code: 'project_replacement_mismatch'
    }]
  });
  const report = terminalExecutionReport(error, { kind: 'change' }, {
    requestCount: 5,
    inputTokens: 28_124,
    outputTokens: 3_612
  });

  assert.match(report, /O que foi tentado, mas não foi aplicado/);
  assert.match(report, /esperava 1 ocorrência, mas encontrou 0/);
  assert.match(report, /Aprovar autorizou a tentativa, mas não confirma uma gravação/);
  assert.match(report, /nenhuma alteração foi confirmada/);
});
