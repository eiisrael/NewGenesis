import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskContract } from '../src/core/task-contract.js';
import { projectMutationIntent } from '../src/core/project-tool-policy.js';

const project = { id: 'p', name: 'TESTE', fileCount: 1, writable: true };

const prompt = 'Faça uma página bonita (html,css,js) com versículos bíblicos. E salve os arquivos na pasta do projeto.';

test('regressão: “Faça uma página” com salvamento no projeto é mutação real', () => {
  const contract = createTaskContract(prompt, { project });
  assert.equal(contract.kind, 'change');
  assert.equal(contract.readOnly, false);
  assert.equal(contract.toolPolicy.strategy, 'direct_mutation');
  assert.equal(contract.toolPolicy.mutationIntent, 'create_file');
  assert.deepEqual(contract.toolPolicy.allowed, ['write_project_file']);
  assert.equal(contract.requestBudget.limit, 1);
});

test('criação genérica de página destinada ao projeto dispensa exploração', () => {
  assert.equal(projectMutationIntent(prompt), 'create_file');
});
