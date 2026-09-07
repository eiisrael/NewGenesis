import { isProjectMutationTool, isProjectVerificationTool } from './project-tool-policy.js';

function check(id, label, passed, detail, required = true) {
  return { id, label, passed: Boolean(passed), detail: String(detail || ''), required };
}

export function verifyTaskOutcome({ contract, response = {}, evidence = [], usage = {} } = {}) {
  const content = String(response.content || '').trim();
  const finishReason = String(response.finishReason || '').toLowerCase();
  if (!new Set(['stop', 'tool_calls']).has(finishReason)) {
    response = { ...response, finishReason: 'partial' };
  }

  const checks = [
    check('answer-present', 'Resposta final presente', content.length > 0, content ? `${content.length} caracteres entregues.` : 'Nenhum conteúdo final foi produzido.'),
    check('answer-finished', 'Resposta concluída pelo modelo', !['length', 'partial'].includes(response.finishReason), ['length', 'partial'].includes(response.finishReason) ? 'A saída terminou por limite e foi marcada como parcial.' : `Motivo final: ${response.finishReason || 'local/stop'}.`)
  ];

  if (contract?.outputFormat === 'bash') {
    checks.push(check('format-bash', 'Formato Bash solicitado', /^```bash[\s\S]*```$/i.test(content), 'A resposta deve conter um bloco Bash completo.'));
  } else if (contract?.outputFormat === 'json') {
    const fenced = content.match(/^```json\s*([\s\S]*?)\s*```$/i)?.[1] || content;
    let valid = false;
    try { JSON.parse(fenced); valid = true; } catch { /* formato inválido */ }
    checks.push(check('format-json', 'JSON válido solicitado', valid, valid ? 'JSON analisado com sucesso.' : 'O conteúdo não é JSON válido.'));
  }

  if (contract?.kind === 'project_overview') {
    checks.push(check('local-profile', 'Análise local sem API', Number(usage.requestCount || 0) === 0, `${Number(usage.requestCount || 0)} requisição(ões) remota(s).`));
    checks.push(check('project-inventory', 'Inventário do projeto presente', /arquivos|project_files|invent[aá]rio/i.test(content), 'O relatório deve informar o inventário.'));
  }

  if (['change', 'fix'].includes(contract?.kind)) {
    const mutation = evidence.find(item => isProjectMutationTool(item?.tool) && item?.ok === true);
    const mutationFailures = evidence.filter(item => isProjectMutationTool(item?.tool) && item?.ok !== true);
    const verification = evidence.find(item => isProjectVerificationTool(item?.tool) && item?.ok === true);
    checks.push(check(
      'mutation-executed',
      'Resultado solicitado confirmado no projeto',
      Boolean(mutation),
      mutation?.summary || (mutationFailures.length
        ? `${mutationFailures.length} tentativa(s) de alteração não foram confirmadas.`
        : 'Nenhuma ferramenta de escrita confirmou alteração.')
    ));
    checks.push(check(
      'verification-run',
      'Verificação executada',
      Boolean(verification),
      verification?.summary || 'A alteração foi confirmada, mas não houve teste/build/lint/diff seguro concluído nesta execução.',
      false
    ));
  }

  const required = checks.filter(item => item.required);
  const passedRequired = required.filter(item => item.passed).length;
  const optionalFailures = checks.filter(item => !item.required && !item.passed).length;
  const score = required.length ? Math.round((passedRequired / required.length) * 100) : 100;
  const status = passedRequired < required.length ? 'failed' : optionalFailures ? 'partial' : 'verified';
  return {
    status,
    score,
    verified: status === 'verified',
    checks,
    summary: status === 'verified'
      ? 'Todos os critérios obrigatórios foram verificados localmente.'
      : status === 'partial'
        ? 'A entrega foi concluída, mas há verificações opcionais pendentes.'
        : 'Um ou mais critérios obrigatórios não foram atendidos.'
  };
}
