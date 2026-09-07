import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferProjectTargetPath,
  recoverRequiredProjectToolCall
} from '../src/core/direct-tool-recovery.js';

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const messages = content => [{ role: 'user', content }];

function args(result) {
  return JSON.parse(result.toolCalls[0].function.arguments);
}

test('infere um único caminho de arquivo do pedido do usuário', () => {
  assert.equal(inferProjectTargetPath(messages('Crie um index.html na pasta do projeto')), 'index.html');
  assert.equal(inferProjectTargetPath(messages('Crie `src/pages/home.html`')), 'src/pages/home.html');
});

test('não escolhe caminho quando o pedido cita vários arquivos', () => {
  assert.equal(inferProjectTargetPath(messages('Compare index.html e app.js antes de alterar')), '');
});

test('recupera argumentos JSON quando só existe uma ferramenta de escrita', () => {
  const result = recoverRequiredProjectToolCall({
    result: { content: '{"path":"index.html","content":"<!doctype html><html></html>"}', toolCalls: [] },
    tools: [tool('write_project_file')],
    messages: messages('Crie um index.html')
  });
  assert.equal(result.toolCalls[0].function.name, 'write_project_file');
  assert.equal(args(result).path, 'index.html');
  assert.match(args(result).content, /doctype html/i);
});

test('recupera HTML puro como conteúdo do arquivo solicitado', () => {
  const html = '<!doctype html><html lang="pt-BR"><head><title>Teste</title></head><body>OK</body></html>';
  const result = recoverRequiredProjectToolCall({
    result: { content: html, toolCalls: [] },
    tools: [tool('write_project_file')],
    messages: messages('Crie um index.html')
  });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(args(result).path, 'index.html');
  assert.equal(args(result).content, html);
});

test('recupera um único bloco HTML mesmo com uma introdução curta do modelo', () => {
  const result = recoverRequiredProjectToolCall({
    result: { content: 'Arquivo completo:\n```html\n<!doctype html><html><body>Genesis</body></html>\n```', toolCalls: [] },
    tools: [tool('write_project_file')],
    messages: messages('Crie o arquivo index.html')
  });
  assert.equal(args(result).path, 'index.html');
  assert.equal(args(result).content, '<!doctype html><html><body>Genesis</body></html>');
});

test('não transforma prosa comum em conteúdo de arquivo', () => {
  const original = { content: 'Claro. Vou criar o arquivo para você.', toolCalls: [] };
  const result = recoverRequiredProjectToolCall({
    result: original,
    tools: [tool('write_project_file')],
    messages: messages('Crie um index.html')
  });
  assert.equal(result, original);
  assert.equal(result.toolCalls.length, 0);
});

test('não recupera escrita se mais de uma ferramenta estiver habilitada', () => {
  const result = recoverRequiredProjectToolCall({
    result: { content: '<!doctype html><html></html>', toolCalls: [] },
    tools: [tool('write_project_file'), tool('replace_project_text')],
    messages: messages('Crie um index.html')
  });
  assert.equal(result.toolCalls.length, 0);
});
