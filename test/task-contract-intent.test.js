import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaskContract } from '../src/core/task-contract.js';

const project = { id: 'project-1', name: 'Projeto', fileCount: 12, writable: true };

test('reconhece pedidos naturais e explícitos de mutação', () => {
  const prompts = [
    'Faça a correção do login.',
    'Faça as correções do cadastro.',
    'Faça os ajustes necessários no painel.',
    'Resolva o bug de autenticação.',
    'Aplique a correção sugerida.',
    'Faça o fix do login.',
    'Melhore o painel.',
    'Otimize a busca.',
    'Arrume o sistema.'
  ];

  for (const prompt of prompts) {
    const contract = createTaskContract(prompt, { project });
    assert.equal(contract.readOnly, false, prompt);
    assert.ok(['change', 'fix'].includes(contract.kind), `${prompt} => ${contract.kind}`);
    assert.ok(contract.toolPolicy.allowed.includes('write_project_file'), prompt);
  }
});

test('pedido analítico permanece somente leitura sem uma ação subsequente explícita', () => {
  const prompts = [
    'Analise o fix aplicado no login.',
    'Revise a função delete do usuário.',
    'Explique como melhorar o painel.',
    'Analise como otimizar a busca.',
    'Quais ajustes seriam úteis no sistema?'
  ];

  for (const prompt of prompts) {
    const contract = createTaskContract(prompt, { project });
    assert.equal(contract.readOnly, true, `${prompt} => ${contract.kind}`);
    assert.equal(contract.toolPolicy.allowed.includes('write_project_file'), false, prompt);
  }
});

test('análise seguida de ordem explícita habilita mutação', () => {
  for (const prompt of [
    'Analise o login e melhore o tratamento de erros.',
    'Revise a solução; depois faça os ajustes necessários.',
    'Explique o problema e aplique a correção.'
  ]) {
    const contract = createTaskContract(prompt, { project });
    assert.equal(contract.readOnly, false, prompt);
  }
});
