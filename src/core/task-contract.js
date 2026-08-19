import crypto from 'node:crypto';

const normalize = value => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const ANALYSIS = /\b(analise|analisar|analise|examine|examinar|inspecione|inspecionar|revise|revisar|avalie|avaliar|audit|review|analyze|inspect|explain|explique)\b/;
const READ_ONLY_LEAD = /^(?:por favor[, ]+)?(?:analise|analisar|examine|examinar|inspecione|inspecionar|revise|revisar|avalie|avaliar|audit|review|analyze|inspect|explain|explique|descreva|descrever|como|por que|porque|qual|quais|o que)\b/;
const PORTUGUESE_IMPERATIVE = /\b(?:crie|adicione|altere|atualize|corrija|conserte|implemente|remova|mova|renomeie|ajuste|edite|refatore|apague|exclua|resolva|aplique|melhore|otimize|arrume)\b/;
const PORTUGUESE_ACTION = /(?:criar|adicionar|alterar|atualizar|corrigir|consertar|implementar|remover|deletar|mover|renomear|ajustar|editar|refatorar|apagar|excluir|resolver|aplicar|melhorar|otimizar|arrumar)/;
const PORTUGUESE_ACTION_NOUN = /(?:correc(?:ao|oes)|ajustes?|alteracoes?|mudancas?|implementacao|refatoracao|otimizacao|melhorias?|fix)/;
const DO_ACTION = new RegExp(`^\\s*(?:por favor[, ]+)?faca\\s+(?:(?:os?|as?|uma?)\\s+)?${PORTUGUESE_ACTION_NOUN.source}\\b`);
const FOLLOW_UP_DO_ACTION = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)(?:por favor\\s+)?faca\\s+(?:(?:os?|as?|uma?)\\s+)?${PORTUGUESE_ACTION_NOUN.source}\\b`);
const ENGLISH_ACTION = /(?:fix|create|update|change|implement|remove|delete|move|rename|edit|write|improve|optimize)/;
const ACTION_VERB = new RegExp(`(?:${PORTUGUESE_ACTION.source}|${ENGLISH_ACTION.source})`);
const ACTION_LEAD = new RegExp(`^(?:por favor[, ]+)?(?:${ACTION_VERB.source})\\b|\\b(?:quero|preciso|pode|poderia|deve|vamos|favor|need you to|want you to|can you|could you|please)\\s+(?:${ACTION_VERB.source})\\b`);
const FOLLOW_UP_ACTION = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)(?:por favor\\s+)?(?:faca\\s+)?(?:${PORTUGUESE_IMPERATIVE.source}|${PORTUGUESE_ACTION.source}\\b)|\\b(?:and|then|also)\\s+(?:please\\s+)?${ENGLISH_ACTION.source}\\b`);
const DELETE_IMPERATIVE = /\b(?:remova|apague|exclua)\b/;
const DELETE_ACTION = /(?:remover|deletar|apagar|excluir|remove|delete)/;
const DELETE_LEAD = new RegExp(`^(?:por favor[, ]+)?(?:${DELETE_ACTION.source})\\b|\\b(?:quero|preciso|pode|poderia|deve|vamos|favor|need you to|want you to|can you|could you|please)\\s+(?:${DELETE_ACTION.source})\\b`);
const FOLLOW_UP_DELETE = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)(?:por favor\\s+)?(?:${DELETE_IMPERATIVE.source}|(?:remover|deletar|apagar|excluir)\\b)|\\b(?:and|then|also)\\s+(?:please\\s+)?(?:remove|delete)\\b`);
const PROJECT_OVERVIEW = /\b(arquitetura|architecture|estrutura|structure|informacoes|informacao|overview|visao geral|mapa|inventario|entry point|entrypoint)\b/;
const DIAGNOSE = /\b(erro|error|bug|falha|crash|exception|nao funciona|quebrou|debug|diagnost)\b/;
const CHECK = /\b(teste|testes|tests?|lint|build|compile|compilar|status|diff)\b/;

const FORMAT_PATTERNS = [
  ['bash', /\b(bash|shell script|\.sh)\b/],
  ['json', /\bjson\b/],
  ['table', /\b(tabela|table)\b/],
  ['markdown', /\b(markdown|\.md)\b/]
];

function outputFormat(text) {
  return FORMAT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || 'markdown';
}

function requestsMutation(text) {
  if (ANALYSIS.test(text) && (FOLLOW_UP_ACTION.test(text) || FOLLOW_UP_DO_ACTION.test(text))) return true;
  if (READ_ONLY_LEAD.test(text)) return false;
  return PORTUGUESE_IMPERATIVE.test(text) || ACTION_LEAD.test(text) || DO_ACTION.test(text);
}

function requestsDeletion(text) {
  if (ANALYSIS.test(text) && FOLLOW_UP_DELETE.test(text)) return true;
  if (READ_ONLY_LEAD.test(text)) return false;
  return DELETE_IMPERATIVE.test(text) || DELETE_LEAD.test(text);
}

function taskKind(text, hasProject) {
  const mutation = requestsMutation(text);
  if (mutation) return DIAGNOSE.test(text) ? 'fix' : 'change';
  if (DIAGNOSE.test(text)) return 'diagnose';
  if (hasProject && ANALYSIS.test(text) && PROJECT_OVERVIEW.test(text)) return 'project_overview';
  if (ANALYSIS.test(text)) return 'analysis';
  return 'answer';
}

function complexityFor(kind, query, project = null) {
  let score = Math.min(3, Math.floor(String(query || '').length / 900));
  if (['change', 'fix'].includes(kind)) score += 2;
  if (kind === 'project_overview') score += 1;
  if ((project?.fileCount || 0) > 250) score += 1;
  if ((project?.fileCount || 0) > 1500) score += 1;
  return score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
}

function toolPolicyFor(kind, text, complexity = 'low') {
  if (kind === 'project_overview') {
    return {
      strategy: 'local_project_profile',
      allowed: [],
      maxBatches: 0,
      maxCallsPerBatch: 0,
      maxResultCharacters: 0,
      maxTaskResultCharacters: 0
    };
  }
  if (kind === 'answer') {
    return {
      strategy: 'no_project_tools',
      allowed: [],
      maxBatches: 0,
      maxCallsPerBatch: 0,
      maxResultCharacters: 0,
      maxTaskResultCharacters: 0
    };
  }
  if (['change', 'fix'].includes(kind)) {
    const allowed = [
      'search_project', 'read_project_file', 'replace_project_text', 'write_project_file',
      'create_project_directory', 'move_project_path', 'run_project_check'
    ];
    if (requestsDeletion(text)) allowed.push('delete_project_path');
    return {
      strategy: 'bounded_agent',
      allowed,
      maxBatches: complexity === 'high' ? 3 : 2,
      maxCallsPerBatch: 4,
      maxResultCharacters: 16_000,
      maxTaskResultCharacters: complexity === 'high' ? 56_000 : complexity === 'medium' ? 36_000 : 24_000
    };
  }
  const allowed = ['search_project', 'read_project_file'];
  if (CHECK.test(text)) allowed.push('run_project_check');
  return {
    strategy: 'bounded_read_only',
    allowed,
    maxBatches: 1,
    maxCallsPerBatch: 4,
    maxResultCharacters: 12_000,
    maxTaskResultCharacters: 24_000
  };
}

function successCriteria(kind, format, project) {
  const criteria = ['Responder integralmente ao pedido sem inventar informações.'];
  if (project) criteria.push('Usar somente dados do projeto ativo e identificar incertezas.');
  if (kind === 'project_overview') criteria.push('Incluir inventário, tecnologias, pontos de entrada, estrutura e riscos observáveis.');
  if (['change', 'fix'].includes(kind)) criteria.push('Registrar arquivos alterados e executar uma verificação compatível quando disponível.');
  if (format !== 'markdown') criteria.push(`Entregar o resultado principal no formato ${format}.`);
  return criteria;
}

function stepsFor(kind) {
  const steps = {
    project_overview: ['Inventariar o projeto localmente', 'Identificar arquitetura e pontos de entrada', 'Gerar relatório verificável'],
    diagnose: ['Localizar evidências', 'Determinar causa provável', 'Relatar diagnóstico e validação'],
    analysis: ['Recuperar contexto relevante', 'Analisar evidências', 'Sintetizar conclusão'],
    change: ['Localizar arquivos relevantes', 'Aplicar alteração mínima', 'Verificar resultado'],
    fix: ['Reproduzir e localizar a causa', 'Aplicar correção mínima', 'Executar verificação de regressão'],
    answer: ['Compreender o pedido', 'Responder objetivamente']
  }[kind];
  return steps.map((label, index) => ({ id: `step-${index + 1}`, label, status: index === 0 ? 'in_progress' : 'pending' }));
}

export function createTaskContract(query, options = {}) {
  const text = normalize(query);
  const project = options.project || null;
  const kind = taskKind(text, Boolean(project));
  const format = outputFormat(text);
  const complexity = complexityFor(kind, query, project);
  const toolPolicy = toolPolicyFor(kind, text, complexity);
  const requestLimit = kind === 'project_overview' ? 0
    : ['change', 'fix'].includes(kind) ? (complexity === 'high' ? 8 : 6)
    : ['analysis', 'diagnose'].includes(kind) ? 3
    : 3;
  const inputTokenLimit = kind === 'project_overview' ? 0
    : ['change', 'fix'].includes(kind) ? (complexity === 'high' ? 80_000 : 56_000)
    : ['analysis', 'diagnose'].includes(kind) ? 30_000
    : 30_000;
  const maxRequestInputTokens = kind === 'project_overview' ? 0
    : ['change', 'fix'].includes(kind) ? 18_000
    : ['analysis', 'diagnose'].includes(kind) ? 14_000
    : 12_000;
  const deadlineMs = kind === 'project_overview' ? 0
    : ['change', 'fix'].includes(kind) ? 120_000
    : 90_000;

  return {
    id: crypto.randomUUID(),
    version: 1,
    createdAt: new Date().toISOString(),
    objective: String(query || '').trim(),
    kind,
    complexity,
    readOnly: !['change', 'fix'].includes(kind),
    outputFormat: format,
    project: project ? { id: project.id, name: project.name, fileCount: project.fileCount, writable: project.writable } : null,
    requestBudget: { limit: requestLimit, inputTokenLimit, maxRequestInputTokens, reserveFinal: requestLimit > 1 ? 1 : 0, deadlineMs },
    toolPolicy,
    successCriteria: successCriteria(kind, format, project),
    steps: stepsFor(kind)
  };
}

export function publicTaskContract(contract) {
  if (!contract) return null;
  return structuredClone(contract);
}
