import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskContract } from '../src/core/task-contract.js';
import { recoverRequiredProjectToolCall } from '../src/core/project-tool-command-recovery.js';
import { agenticToolsForMessages } from '../src/providers/precise-openrouter-provider.js';

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const project = { id: 'p', name: 'Teste', fileCount: 1, writable: true };
const editTools = [
  'search_project',
  'read_project_file',
  'write_project_file',
  'replace_project_text',
  'create_project_directory',
  'move_project_path',
  'run_project_check'
].map(tool);

function callArguments(result) {
  return JSON.parse(result.toolCalls[0].function.arguments);
}

test('regressão: colocar conteúdo em arquivo é classificado como alteração real', () => {
  const contract = createTaskContract('Coloque no arquivo um trecho qualquer da bíblia sagrada.', { project });
  assert.equal(contract.kind, 'change');
  assert.equal(contract.readOnly, false);
  assert.equal(contract.toolPolicy.strategy, 'bounded_agent');
  assert.ok(contract.toolPolicy.allowed.includes('write_project_file'));
  assert.ok(contract.toolPolicy.allowed.includes('replace_project_text'));
});

test('arquivo vazio lido integralmente vai direto para write_project_file', () => {
  const messages = [
    { role: 'user', content: 'Coloque no arquivo index.html um trecho qualquer.' },
    {
      role: 'tool',
      name: 'read_project_file',
      content: JSON.stringify({
        ok: true,
        path: 'index.html',
        startLine: 1,
        endLine: 1,
        nextStartLine: null,
        content: '',
        truncated: false
      })
    }
  ];
  const effective = agenticToolsForMessages(editTools, messages);
  assert.deepEqual(effective.map(item => item.function.name), ['write_project_file']);
});

test('JSON command de replace vazio vira gravação real em vez de aparecer no chat', () => {
  const content = '<!-- Trecho da Bíblia Sagrada -->\n<p>"No princípio criou Deus os céus e a terra." (Gênesis 1:1)</p>';
  const result = recoverRequiredProjectToolCall({
    result: {
      content: JSON.stringify({
        command: 'replace_project_text',
        path: 'index.html',
        old_text: '',
        new_text: content
      }),
      toolCalls: []
    },
    tools: [tool('write_project_file')],
    messages: [{ role: 'user', content: 'Coloque no arquivo index.html um trecho qualquer da bíblia sagrada.' }]
  });

  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.content, '');
  assert.equal(result.toolCalls[0].function.name, 'write_project_file');
  assert.deepEqual(callArguments(result), { path: 'index.html', content });
  assert.equal(result.toolRecovery, 'empty-replace-as-write');
});

test('JSON command com substituição válida preserva replace_project_text', () => {
  const result = recoverRequiredProjectToolCall({
    result: {
      content: JSON.stringify({
        command: 'replace_project_text',
        path: 'index.html',
        old_text: '<title>Teste</title>',
        new_text: '<title>Genesis</title>'
      }),
      toolCalls: []
    },
    tools: [tool('replace_project_text')],
    messages: [{ role: 'user', content: 'Altere o título do index.html.' }]
  });

  assert.equal(result.toolCalls[0].function.name, 'replace_project_text');
  assert.deepEqual(callArguments(result), {
    path: 'index.html',
    old_text: '<title>Teste</title>',
    new_text: '<title>Genesis</title>'
  });
  assert.equal(result.toolRecovery, 'declared-command-json');
});
