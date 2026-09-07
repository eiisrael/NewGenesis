import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agenticToolsForMessages,
  prepareAgenticToolRequest,
  projectToolActionRequired
} from '../src/providers/precise-openrouter-provider.js';

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

test('primeira exploração força busca e permanece sequencial', () => {
  const body = prepareAgenticToolRequest({
    messages: [{ role: 'user', content: 'Melhore o projeto.' }],
    tools: [tool('search_project'), tool('read_project_file'), tool('replace_project_text')]
  });
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'search_project' } });
  assert.equal(body.parallel_tool_calls, false);
});

test('criação direta expõe somente escrita e força a ferramenta', () => {
  const tools = [tool('search_project'), tool('read_project_file'), tool('replace_project_text'), tool('write_project_file')];
  const messages = [{ role: 'user', content: 'Crie um index.html na pasta do projeto' }];
  const effective = agenticToolsForMessages(tools, messages);
  assert.deepEqual(effective.map(item => item.function.name), ['write_project_file']);
  assert.deepEqual(prepareAgenticToolRequest({ messages, tools: effective }).tool_choice, {
    type: 'function', function: { name: 'write_project_file' }
  });
});

test('requisição agentic não elimina rotas gratuitas por require_parameters rígido', () => {
  const body = prepareAgenticToolRequest({
    provider: { allow_fallbacks: true, require_parameters: true },
    messages: [{ role: 'user', content: 'Crie um index.html.' }],
    tools: [tool('write_project_file')]
  });
  assert.equal(body.provider.require_parameters, false);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'write_project_file' } });
});

test('depois da primeira evidência uma tarefa de edição continua exigindo ação', () => {
  const body = prepareAgenticToolRequest({
    messages: [{ role: 'tool', tool_call_id: 'x', content: '{"ok":true}' }],
    tools: [tool('search_project'), tool('read_project_file'), tool('replace_project_text')]
  });
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.parallel_tool_calls, false);
});

test('exploração somente leitura continua auto e sequencial', () => {
  const body = prepareAgenticToolRequest({
    messages: [{ role: 'tool', tool_call_id: 'x', content: '{"ok":true}' }],
    tools: [tool('search_project'), tool('read_project_file')]
  });
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, false);
});

test('fase de mutação força uma ferramenta real', () => {
  const body = prepareAgenticToolRequest({ tools: [tool('replace_project_text'), tool('write_project_file')] });
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.parallel_tool_calls, false);
});

test('verificação com uma ferramenta força exatamente essa função', () => {
  const body = prepareAgenticToolRequest({ tools: [tool('run_project_check')] });
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'run_project_check' } });
});

test('verificação já tentada não é repetida em loop quando falha', () => {
  const supplied = [tool('run_project_check')];
  const messages = [
    { role: 'tool', name: 'run_project_check', tool_call_id: 'check-1', content: '{"ok":false,"code":"project_check_failed"}' }
  ];
  const effective = agenticToolsForMessages(supplied, messages);
  assert.deepEqual(effective, []);
  assert.equal(projectToolActionRequired(supplied, effective), false);
});

test('duas evidências úteis encerram exploração e expõem somente escrita', () => {
  const tools = [tool('search_project'), tool('read_project_file'), tool('replace_project_text'), tool('write_project_file')];
  const messages = [
    { role: 'tool', name: 'search_project', content: JSON.stringify({ ok: true, matches: [{ path: 'src/app.js', line: 10 }] }) },
    { role: 'tool', name: 'read_project_file', content: JSON.stringify({ ok: true, path: 'src/app.js', content: 'trecho' }) }
  ];
  assert.deepEqual(agenticToolsForMessages(tools, messages).map(item => item.function.name), [
    'replace_project_text'
  ]);
});

test('edição localizada força somente substituição mesmo com todas as mutações disponíveis', () => {
  const tools = [
    tool('search_project'), tool('read_project_file'), tool('replace_project_text'),
    tool('write_project_file'), tool('create_project_directory'), tool('move_project_path'), tool('delete_project_path')
  ];
  const messages = [
    { role: 'user', content: 'Remova do index.html tudo referente ao Editor Astral.' },
    { role: 'tool', name: 'search_project', content: '{"ok":true,"matches":[{"path":"index.html","line":1}]}' },
    { role: 'tool', name: 'read_project_file', content: '{"ok":true,"path":"index.html","content":"Editor Astral"}' }
  ];
  const effective = agenticToolsForMessages(tools, messages);
  assert.deepEqual(effective.map(item => item.function.name), ['replace_project_text']);
  assert.deepEqual(prepareAgenticToolRequest({ messages, tools: effective }).tool_choice, {
    type: 'function', function: { name: 'replace_project_text' }
  });
});