import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectToolExecutor } from '../src/project-tools.js';
import { verifyTaskOutcome } from '../src/core/task-verifier.js';

function executorWith(store) {
  return new ProjectToolExecutor({
    projectStore: store,
    permissionStore: { mode: 'full' },
    approvalManager: { request: () => { throw new Error('não deveria pedir aprovação'); } }
  });
}

function missingFileError() {
  return Object.assign(new Error('arquivo ausente'), { code: 'project_path_not_found' });
}

test('write_project_file só confirma sucesso depois de reler o conteúdo gravado', async () => {
  let persisted = null;
  const store = {
    summary: () => ({ writable: true }),
    readText: async () => {
      if (persisted === null) throw missingFileError();
      return persisted;
    },
    writeText: async (_path, content) => { persisted = String(content); }
  };

  const result = await executorWith(store).execute({ function: {
    name: 'write_project_file',
    arguments: JSON.stringify({ path: 'index.html', content: '<main>Genesis</main>' })
  }});

  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.verification, 'read_after_write');
  assert.match(result.summary, /confirmado por releitura no disco/);
});

test('write_project_file falha se a releitura não corresponder ao conteúdo solicitado', async () => {
  let written = false;
  const store = {
    summary: () => ({ writable: true }),
    readText: async () => {
      if (!written) throw missingFileError();
      return '<main>conteúdo diferente</main>';
    },
    writeText: async () => { written = true; }
  };

  const result = await executorWith(store).execute({ function: {
    name: 'write_project_file',
    arguments: JSON.stringify({ path: 'index.html', content: '<main>Genesis</main>' })
  }});

  assert.equal(result.ok, false);
  assert.equal(result.code, 'project_write_verification_failed');
  assert.match(result.error, /conteúdo relido do disco difere/);
});

test('relatório final não pode declarar arquivos concluídos sem evidência de mutação', () => {
  const result = verifyTaskOutcome({
    contract: { kind: 'change', outputFormat: 'markdown' },
    response: {
      finishReason: 'stop',
      content: [
        '## Relatório final do Genesis',
        '- `index.html` criado com estrutura HTML5.',
        '- `script.js` criado com a interação.',
        '- `style.css` atualizado com segurança.',
        '',
        '**Arquivos completos disponíveis: index.html, style.css, script.js.**'
      ].join('\n')
    },
    evidence: [{
      tool: 'write_project_file',
      ok: true,
      arguments: JSON.stringify({ path: 'style.css', content: 'body{}' }),
      summary: 'style.css gravado e confirmado por releitura no disco.'
    }],
    usage: {}
  });

  const claimsCheck = result.checks.find(item => item.id === 'mutation-claims-grounded');
  assert.equal(result.status, 'failed');
  assert.equal(claimsCheck?.passed, false);
  assert.match(claimsCheck?.detail || '', /index\.html/);
  assert.match(claimsCheck?.detail || '', /script\.js/);
});

test('relatório final aceita arquivo concluído quando há evidência real da escrita', () => {
  const result = verifyTaskOutcome({
    contract: { kind: 'change', outputFormat: 'markdown' },
    response: { finishReason: 'stop', content: '- `style.css` gravado e confirmado no projeto.' },
    evidence: [{
      tool: 'write_project_file',
      ok: true,
      arguments: JSON.stringify({ path: 'style.css', content: 'body{}' }),
      summary: 'style.css gravado e confirmado por releitura no disco.'
    }],
    usage: {}
  });

  const claimsCheck = result.checks.find(item => item.id === 'mutation-claims-grounded');
  assert.equal(result.status, 'partial');
  assert.equal(claimsCheck?.passed, true);
});
