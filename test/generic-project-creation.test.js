import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskContract } from '../src/core/task-contract.js';
import { projectMutationIntent } from '../src/core/project-tool-policy.js';

const project = { id: 'p', name: 'TESTE', fileCount: 1, writable: true };

const prompt = 'Faça uma página bonita (html,css,js) com versículos bíblicos. E salve os arquivos na pasta do projeto.';
const exactServicePrompt = 'Crie uma página com um bonito layout, mostrando versículos bíblicos. Haja como senior, crie os arquivos na pasta do projeto, faça em HTML,CSS e JS. Retorne apenas quando tudo estiver finalizado.';

function assertServiceContract(contract) {
  assert.equal(contract.kind, 'change');
  assert.equal(contract.readOnly, false);
  assert.equal(contract.toolPolicy.strategy, 'direct_service');
  assert.equal(contract.toolPolicy.mutationIntent, 'create_project');
  assert.deepEqual(contract.toolPolicy.allowed, ['write_project_files']);
  assert.equal(contract.requestBudget.limit, 3);
  assert.equal(contract.artifacts.mode, 'multi_file');
  assert.deepEqual(contract.artifacts.requiredExtensions, ['.html', '.css', '.js']);
  assert.ok(contract.artifacts.minimumWrites >= 3);
}

test('regressão: “Faça uma página” HTML/CSS/JS vira serviço multi-arquivo real', () => {
  const contract = createTaskContract(prompt, { project });
  assertServiceContract(contract);
});

test('regressão: prompt exato do usuário exige entrega atômica HTML/CSS/JS', () => {
  const contract = createTaskContract(exactServicePrompt, { project });
  assertServiceContract(contract);
});

test('criação genérica de página destinada ao projeto dispensa exploração', () => {
  assert.equal(projectMutationIntent(prompt), 'create_project');
  assert.equal(projectMutationIntent(exactServicePrompt), 'create_project');
});
