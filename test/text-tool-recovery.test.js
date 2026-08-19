import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextToolCall } from '../src/providers/resilient-openrouter-provider.js';

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

test('recupera markup legado read_file como ferramenta real do projeto', () => {
  const calls = parseTextToolCall('<read_file index.html>', [tool('read_project_file')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_project_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'index.html' });
});

test('recupera busca textual simples sem expor markup no chat', () => {
  const calls = parseTextToolCall('<search_project ASTRAEON>', [tool('search_project')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'search_project');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { query: 'ASTRAEON' });
});

test('mutações textuais só são recuperadas quando trazem argumentos JSON verificáveis', () => {
  assert.deepEqual(parseTextToolCall('<write_file index.html>', [tool('write_project_file')]), []);
  const calls = parseTextToolCall(
    '<replace_project_text>{"path":"index.html","old_text":"ASTRAEON","new_text":"Astraeon Zika"}</replace_project_text>',
    [tool('replace_project_text')]
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'replace_project_text');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    path: 'index.html', old_text: 'ASTRAEON', new_text: 'Astraeon Zika'
  });
});
