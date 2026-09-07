import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agenticToolsForMessages,
  projectToolActionRequired
} from '../src/providers/precise-openrouter-provider.js';

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const tools = [
  tool('search_project'), tool('read_project_file'), tool('replace_project_text'), tool('write_project_file')
];

test('tarefa de edição começa somente com leitura e exige ação mesmo em modelo legado', () => {
  const effective = agenticToolsForMessages(tools, []);
  assert.deepEqual(effective.map(item => item.function.name), ['search_project', 'read_project_file']);
  assert.equal(projectToolActionRequired(tools, effective), true);
});

test('uma evidência mantém escolha entre contexto adicional ou escrita, mas exige ação', () => {
  const messages = [{ role: 'tool', name: 'search_project', content: '{"ok":true,"matches":[{"path":"index.html","line":10}]}' }];
  const effective = agenticToolsForMessages(tools, messages);
  assert.deepEqual(effective.map(item => item.function.name), tools.map(item => item.function.name));
  assert.equal(projectToolActionRequired(tools, effective), true);
});

test('duas evidências encerram exploração e deixam somente mutação', () => {
  const messages = [
    { role: 'tool', name: 'search_project', content: '{"ok":true,"matches":[{"path":"index.html","line":10}]}' },
    { role: 'tool', name: 'read_project_file', content: '{"ok":true,"path":"index.html","content":"ASTRAEON"}' }
  ];
  const effective = agenticToolsForMessages(tools, messages);
  assert.deepEqual(effective.map(item => item.function.name), ['replace_project_text']);
  assert.equal(projectToolActionRequired(tools, effective), true);
});
