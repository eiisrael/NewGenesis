import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskContract } from '../src/core/task-contract.js';

const project = { id: 'p', name: 'QualquerProjeto', fileCount: 24, writable: true };

test('melhoria em qualquer projeto vira edição agentic com orçamento de conclusão', () => {
  const contract = createTaskContract('Melhore a qualidade desta funcionalidade e mantenha compatibilidade.', { project });
  assert.equal(contract.kind, 'change');
  assert.equal(contract.readOnly, false);
  assert.equal(contract.toolPolicy.strategy, 'bounded_agent');
  assert.equal(contract.toolPolicy.maxCallsPerBatch, 1);
  assert.equal(contract.requestBudget.limit, 6);
  assert.equal(contract.requestBudget.reserveFinal, 1);
  assert.ok(contract.toolPolicy.allowed.includes('replace_project_text'));
  assert.ok(contract.toolPolicy.allowed.includes('run_project_check'));
});

test('regressão: pedido visual de terreno é uma alteração real, não uma análise', () => {
  const contract = createTaskContract('Melhore a qualidade gráfica do terreno do jogo, separe por camadas de cores referentes ao clima, terra, grama, terra + grama, neve, agua.', { project });
  assert.equal(contract.kind, 'change');
  assert.equal(contract.readOnly, false);
  assert.equal(contract.requestBudget.limit, 6);
  assert.equal(contract.requestBudget.reserveFinal, 1);
  assert.equal(contract.toolPolicy.searchFirst, true);
  assert.ok(contract.toolPolicy.allowed.includes('replace_project_text'));
});

test('análise pura continua sem mutação', () => {
  const contract = createTaskContract('Analise como melhorar a arquitetura sem alterar nada.', { project });
  assert.equal(contract.readOnly, true);
  assert.equal(contract.toolPolicy.allowed.includes('write_project_file'), false);
});

test('mudança ampla recebe orçamento maior sem depender do domínio do projeto', () => {
  const contract = createTaskContract('Modernize a aplicação inteira e migre a arquitetura, depois atualize os testes.', {
    project: { ...project, fileCount: 900 }
  });
  assert.equal(contract.kind, 'change');
  assert.equal(contract.complexity, 'high');
  assert.equal(contract.requestBudget.limit, 14);
  assert.equal(contract.requestBudget.reserveFinal, 1);
  assert.equal(contract.toolPolicy.maxExplorationBatches, 4);
});

test('criação explícita de arquivo elimina busca e expõe somente escrita', () => {
  const contract = createTaskContract('Crie um index.html', {
    project: { ...project, fileCount: 0 }
  });
  assert.equal(contract.kind, 'change');
  assert.equal(contract.toolPolicy.strategy, 'direct_mutation');
  assert.equal(contract.toolPolicy.mutationIntent, 'create_file');
  assert.deepEqual(contract.toolPolicy.allowed, ['write_project_file']);
  assert.equal(contract.toolPolicy.searchFirst, false);
  assert.equal(contract.requestBudget.limit, 3);
  assert.equal(contract.requestBudget.deadlineMs, 60_000);
});

test('adicionar conteúdo em arquivo existente continua sendo edição com leitura', () => {
  const contract = createTaskContract('Adicione um botão no index.html', { project });
  assert.equal(contract.toolPolicy.strategy, 'bounded_agent');
  assert.equal(contract.toolPolicy.mutationIntent, 'edit');
  assert.equal(contract.toolPolicy.searchFirst, true);
  assert.ok(contract.toolPolicy.allowed.includes('search_project'));
  assert.ok(contract.toolPolicy.allowed.includes('replace_project_text'));
});
