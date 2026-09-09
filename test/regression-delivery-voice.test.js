import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskContract } from '../src/core/task-contract.js';
import { recoverRequiredProjectToolCall } from '../src/core/project-tool-command-recovery.js';
import { verifyTaskOutcome } from '../src/core/task-verifier.js';
import { normalizeSpokenText } from '../public/voice/speech-normalizer.js';
import { AdaptiveVoiceActivityDetector } from '../public/voice/audio-input.js';
import { DEFAULT_VOICE_SETTINGS, sanitizeVoiceSettings } from '../public/voice/voice-settings.js';

const project = { id: 'p', name: 'TESTE', fileCount: 0, writable: true };
const batchTool = {
  type: 'function',
  function: {
    name: 'write_project_files',
    description: 'Grava todos os arquivos da entrega.',
    parameters: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] }
  }
};
const prompt = 'Crie uma pagina index.html usando maximas habilidades e criatividade.';

function response(content) {
  return { content, toolCalls: [], finishReason: 'stop', usage: {} };
}

function batchEvidence(paths) {
  return [{
    tool: 'write_project_files',
    ok: true,
    arguments: JSON.stringify({ files: paths.map(path => ({ path, content: 'x' })) }),
    summary: `${paths.length} arquivo(s) gravado(s): ${paths.join(', ')}.`
  }];
}

test('página web comum exige HTML, CSS e JavaScript na mesma entrega', () => {
  const contract = createTaskContract(prompt, { project });
  assert.equal(contract.kind, 'change');
  assert.equal(contract.toolPolicy.mutationIntent, 'create_project');
  assert.deepEqual(contract.toolPolicy.allowed, ['write_project_files']);
  assert.equal(contract.artifacts.webBundle, true);
  assert.deepEqual(contract.artifacts.requiredExtensions.sort(), ['.css', '.html', '.js']);
  assert.equal(contract.artifacts.minimumWrites, 3);
  assert.equal(contract.requestBudget.limit, 2);
});

test('pedido explicitamente single-file não força CSS/JS externos', () => {
  const contract = createTaskContract('Crie uma página em um único arquivo index.html, com CSS e JS internos.', { project });
  assert.equal(contract.artifacts.webBundle, false);
});

test('recuperação rejeita HTML sozinho quando a página exige bundle completo', () => {
  const result = recoverRequiredProjectToolCall({
    result: response('```html\n<!doctype html><html><head></head><body><button>Enviar</button></body></html>\n```'),
    tools: [batchTool],
    messages: [{ role: 'user', content: prompt }]
  });
  assert.equal(result.toolCalls?.length || 0, 0);
  assert.equal(result.toolRecovery, 'rejected-incomplete-web-bundle');
  assert.match(result.toolRecoveryRejected, /\.css/);
  assert.match(result.toolRecoveryRejected, /\.js/);
});

test('recuperação aceita HTML + CSS + JavaScript juntos', () => {
  const result = recoverRequiredProjectToolCall({
    result: response([
      '```html',
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><form id="f"><button>Enviar</button></form><script src="script.js"></script></body></html>',
      '```',
      '```css',
      'body { font-family: sans-serif; }',
      '```',
      '```javascript',
      "document.getElementById('f').addEventListener('submit', event => { event.preventDefault(); });",
      '```'
    ].join('\n')),
    tools: [batchTool],
    messages: [{ role: 'user', content: prompt }]
  });
  assert.equal(result.toolCalls.length, 1);
  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.deepEqual(args.files.map(file => file.path).sort(), ['index.html', 'script.js', 'styles.css']);
});

test('verificador não permite marcar página multi-arquivo como pronta com apenas index.html', () => {
  const contract = createTaskContract(prompt, { project });
  const verification = verifyTaskOutcome({
    contract,
    response: { content: 'index.html gravado.', finishReason: 'stop' },
    evidence: batchEvidence(['index.html']),
    usage: {}
  });
  const artifacts = verification.checks.find(item => item.id === 'artifact-set-complete');
  assert.equal(artifacts.passed, false);
  assert.equal(verification.status, 'failed');
});

test('verificador aceita o conjunto HTML/CSS/JS confirmado', () => {
  const contract = createTaskContract(prompt, { project });
  const verification = verifyTaskOutcome({
    contract,
    response: { content: 'index.html, styles.css e script.js gravados.', finishReason: 'stop' },
    evidence: batchEvidence(['index.html', 'styles.css', 'script.js']),
    usage: {}
  });
  const artifacts = verification.checks.find(item => item.id === 'artifact-set-complete');
  assert.equal(artifacts.passed, true);
  assert.notEqual(verification.status, 'failed');
});

test('TTS não soletra JavaScript, HTML ou JSON de ferramenta', () => {
  const spoken = normalizeSpokenText([
    'Aqui está a implementação.',
    "const form = document.getElementById('contactForm');",
    "form.addEventListener('submit', (event) => { event.preventDefault(); });",
    '<div class="resultado">Ok</div>',
    '{ "tool": "write_project_file", "arguments": { "path": "script.js" } }',
    'A página está pronta para teste.'
  ].join('\n'));
  assert.match(spoken, /Aqui está a implementação/);
  assert.match(spoken, /Há um bloco de código na resposta/);
  assert.match(spoken, /A página está pronta para teste/);
  assert.doesNotMatch(spoken, /getElementById|addEventListener|write_project_file|<div|\{|\}/);
});

test('TTS silencia fence de código ainda incompleto durante streaming', () => {
  const spoken = normalizeSpokenText('Vou mostrar o código.\n```javascript\nconst x = () => { return 1; };');
  assert.equal(spoken, 'Vou mostrar o código. Há um bloco de código na resposta.');
});

test('VAD detecta fala normal abaixo do antigo limiar 0.018', () => {
  const vad = new AdaptiveVoiceActivityDetector({ threshold: 0.009, startFrames: 2, silenceMs: 650 });
  vad.pushLevel(0.003, 0);
  vad.pushLevel(0.004, 20);
  assert.equal(vad.pushLevel(0.014, 40), null);
  const start = vad.pushLevel(0.014, 60);
  assert.equal(start?.type, 'start');
  vad.pushLevel(0.002, 400);
  const end = vad.pushLevel(0.002, 1100);
  assert.equal(end?.type, 'end');
});

test('configuração persistida com limiar legado 0.018 é migrada', () => {
  const settings = sanitizeVoiceSettings({ vadThreshold: 0.018, vadSilenceMs: 550 });
  assert.equal(settings.vadThreshold, DEFAULT_VOICE_SETTINGS.vadThreshold);
  assert.equal(settings.vadThreshold, 0.009);
});
