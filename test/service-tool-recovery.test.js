import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverRequiredProjectToolCall } from '../src/core/project-tool-command-recovery.js';

const batchTool = {
  type: 'function',
  function: {
    name: 'write_project_files',
    description: 'Grava uma entrega com vários arquivos.',
    parameters: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'content'],
            properties: { path: { type: 'string' }, content: { type: 'string' } }
          }
        }
      }
    }
  }
};

const userPrompt = 'Crie uma página com um bonito layout, mostrando versículos bíblicos. Haja como senior, crie os arquivos na pasta do projeto, faça em HTML,CSS e JS. Retorne apenas quando tudo estiver finalizado.';

test('três blocos HTML/CSS/JS em texto são convertidos em write_project_files real', () => {
  const content = [
    'Vou criar os três arquivos agora:',
    '```html',
    '<!doctype html><html><body><h1>Versículos</h1><script src="script.js"></script></body></html>',
    '```',
    '```css',
    'body { margin: 0; font-family: sans-serif; }',
    '```',
    '```javascript',
    'const verses = [];\nconsole.log(verses);',
    '```',
    '',
    '<｜tool▁call▁begin｜>function main() { console.log("verificando"); }'
  ].join('\n');

  const result = recoverRequiredProjectToolCall({
    result: { content, toolCalls: [], finishReason: 'stop' },
    tools: [batchTool],
    messages: [{ role: 'user', content: userPrompt }]
  });

  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.content, '');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'write_project_files');
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.deepEqual(args.files.map(file => file.path), ['index.html', 'styles.css', 'script.js']);
  assert.match(args.files[0].content, /<!doctype html>/i);
  assert.match(args.files[1].content, /body\s*\{/i);
  assert.match(args.files[2].content, /const verses/);
});

test('JSON textual de write_project_files também vira chamada de ferramenta', () => {
  const content = JSON.stringify({
    command: 'write_project_files',
    files: [
      { path: 'index.html', content: '<!doctype html><html><body>OK</body></html>' },
      { path: 'styles.css', content: 'body{}' },
      { path: 'script.js', content: 'console.log("ok");' }
    ]
  });

  const result = recoverRequiredProjectToolCall({
    result: { content, toolCalls: [], finishReason: 'stop' },
    tools: [batchTool],
    messages: [{ role: 'user', content: userPrompt }]
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'write_project_files');
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.equal(args.files.length, 3);
});
