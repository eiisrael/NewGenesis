import { isProjectMutationTool, isProjectVerificationTool } from './project-tool-policy.js';

const FILE_PATH_SOURCE = '[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.[A-Za-z0-9]{1,12}';
const COMPLETION_CLAIM = /\b(?:criad|atualiz|alterad|modificad|gravad|escrit|aplicad|confirmad|disponivel|pront|complet|concluid)\w*\b/;
const NEGATED_COMPLETION_CLAIM = /\b(?:nao|nenhum|nenhuma|sem)\b.{0,80}\b(?:criad|atualiz|alterad|modificad|gravad|escrit|aplicad|confirmad|disponivel|pront|complet|concluid)\w*\b/;

function check(id, label, passed, detail, required = true) {
  return { id, label, passed: Boolean(passed), detail: String(detail || ''), required };
}

function normalizedClaimText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function filePathsIn(value) {
  const pattern = new RegExp(FILE_PATH_SOURCE, 'gi');
  return [...String(value || '').matchAll(pattern)].map(match => match[0].replace(/^\.\//, '').toLowerCase());
}

function successfulMutationTargets(evidence = []) {
  const targets = new Set();
  for (const item of evidence) {
    if (item?.ok !== true || !isProjectMutationTool(item?.tool)) continue;
    try {
      const args = JSON.parse(String(item.arguments || '{}'));
      if (args.path) targets.add(String(args.path).replace(/^\.\//, '').toLowerCase());
      if (args.to) targets.add(String(args.to).replace(/^\.\//, '').toLowerCase());
      if (Array.isArray(args.files)) {
        for (const file of args.files) if (file?.path) targets.add(String(file.path).replace(/^\.\//, '').toLowerCase());
      }
    } catch { /* argumentos podem estar compactados; o resumo ainda fornece evidência */ }
    for (const target of filePathsIn(item.summary)) targets.add(target);
  }
  return targets;
}

function claimedCompletedFiles(content) {
  const claims = new Set();
  for (const line of String(content || '').split(/\r?\n/)) {
    const normalized = normalizedClaimText(line);
    if (!COMPLETION_CLAIM.test(normalized) || NEGATED_COMPLETION_CLAIM.test(normalized)) continue;
    for (const target of filePathsIn(line)) claims.add(target);
  }
  return claims;
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
    const mutationTargets = successfulMutationTargets(evidence);
    const completedFileClaims = claimedCompletedFiles(content);
    const unsupportedClaims = [...completedFileClaims].filter(target => !mutationTargets.has(target));
    checks.push(check(
      'mutation-executed',
      'Resultado solicitado confirmado no projeto',
      Boolean(mutation),
      mutation?.summary || (mutationFailures.length
        ? `${mutationFailures.length} tentativa(s) de alteração não foram confirmadas.`
        : 'Nenhuma ferramenta de escrita confirmou alteração.')
    ));
    checks.push(check(
      'mutation-claims-grounded',
      'Arquivos declarados como concluídos possuem evidência real',
      unsupportedClaims.length === 0,
      unsupportedClaims.length
        ? `A resposta declarou como concluído(s) sem evidência de mutação confirmada: ${unsupportedClaims.join(', ')}.`
        : completedFileClaims.size
          ? `${completedFileClaims.size} arquivo(s) declarado(s) como concluído(s) possuem evidência de mutação confirmada.`
          : 'A resposta não declarou arquivos específicos como concluídos sem evidência.'
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
