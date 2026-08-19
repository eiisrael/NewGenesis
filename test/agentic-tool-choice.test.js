import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agenticToolsForMessages,
  prepareAgenticToolRequest
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

test('duas evidências úteis encerram exploração e expõem somente escrita', () => {
  const tools = [tool('search_project'), tool('read_project_file'), tool('replace_project_text'), tool('write_project_file')];
  const messages = [
    { role: 'tool', name: 'search_project', content: JSON.stringify({ ok: true, matches: [{ path: 'src/app.js', line: 10 }] }) },
    { role: 'tool', name: 'read_project_file', content: JSON.stringify({ ok: true, path: 'src/app.js', content: 'trecho' }) }
  ];
  assert.deepEqual(agenticToolsForMessages(tools, messages).map(item => item.function.name), [
    'replace_project_text', 'write_project_file'
  ]);
});
