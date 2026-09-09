import crypto from 'node:crypto';
import {
  PROJECT_READ_TOOL_NAMES,
  PROJECT_MUTATION_TOOL_NAMES,
  PROJECT_VERIFICATION_TOOL_NAMES,
  projectMutationIntent
} from './project-tool-policy.js';

const normalize = value => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const ANALYSIS = /\b(analise|analisar|examine|examinar|inspecione|inspecionar|revise|revisar|avalie|avaliar|audit|review|analyze|inspect|explain|explique)\b/;
const READ_ONLY_LEAD = /^(?:por favor[, ]+)?(?:analise|analisar|examine|examinar|inspecione|inspecionar|revise|revisar|avalie|avaliar|audit|review|analyze|inspect|explain|explique|descreva|descrever|como|por que|porque|qual|quais|o que)\b/;
const PORTUGUESE_IMPERATIVE = /\b(?:crie|adicione|altere|atualize|corrija|conserte|implemente|remova|mova|renomeie|ajuste|edite|refatore|apague|exclua|resolva|aplique|melhore|otimize|arrume|organize|simplifique|modernize|migra|migre)\b/;
const PORTUGUESE_ACTION = /(?:criar|adicionar|alterar|atualizar|corrigir|consertar|implementar|remover|deletar|mover|renomear|ajustar|editar|refatorar|apagar|excluir|resolver|aplicar|melhorar|otimizar|arrumar|organizar|simplificar|modernizar|migrar)/;
const PORTUGUESE_ACTION_NOUN = /(?:correc(?:ao|oes)|ajustes?|alteracoes?|mudancas?|implementacao|refatoracao|otimizacao|melhorias?|migracao|fix)/;
const DO_ACTION = new RegExp(`^\\s*(?:por favor[, ]+)?faca\\s+(?:(?:os?|as?|uma?)\\s+)?${PORTUGUESE_ACTION_NOUN.source}\\b`);
const FOLLOW_UP_DO_ACTION = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)(?:por favor\\s+)?faca\\s+(?:(?:os?|as?|uma?)\\s+)?${PORTUGUESE_ACTION_NOUN.source}\\b`);
const GENERIC_BUILD_ACTION = /\b(?:faca|fazer|monte|montar|desenvolva|desenvolver|construa|construir)\b[^.!?\n]{0,120}\b(?:pagina|site|app|aplicacao|interface|landing page|dashboard|jogo|game)\b/;
const ENGLISH_ACTION = /(?:fix|create|update|change|implement|remove|delete|move|rename|edit|write|improve|optimize|refactor|organize|simplify|modernize|migrate)/;
const ACTION_VERB = new RegExp(`(?:${PORTUGUESE_ACTION.source}|${ENGLISH_ACTION.source})`);
const ACTION_LEAD = new RegExp(`^(?:por favor[, ]+)?(?:${ACTION_VERB.source})\\b|\\b(?:quero|preciso|pode|poderia|deve|vamos|favor|need you to|want you to|can you|could you|please)\\s+(?:${ACTION_VERB.source})\\b`);
const FOLLOW_UP_ACTION = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)(?:por favor\\s+)?(?:faca\\s+)?(?:${PORTUGUESE_IMPERATIVE.source}|${PORTUGUESE_ACTION.source}\\b)|\\b(?:and|then|also)\\s+(?:please\\s+)?${ENGLISH_ACTION.source}\\b`);
const PROJECT_CONTENT_VERB = '(?:coloque|colocar|insira|inserir|inclua|incluir|preencha|preencher|ponha|escreva|escrever)';
const PROJECT_CONTENT_TARGET = '(?:arquivo|file|[a-z0-9_.-]+(?:\\/[a-z0-9_.-]+)*\\.[a-z0-9]{1,12})';
const PROJECT_CONTENT_ACTION = new RegExp(`\\b${PROJECT_CONTENT_VERB}\\b[^.!?\\n]{0,80}\\b${PROJECT_CONTENT_TARGET}\\b|\\b${PROJECT_CONTENT_TARGET}\\b[^.!?\\n]{0,80}\\b${PROJECT_CONTENT_VERB}\\b`);
const FOLLOW_UP_PROJECT_CONTENT_ACTION = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)[^.!?\\n]{0,32}\\b${PROJECT_CONTENT_VERB}\\b[^.!?\\n]{0,80}\\b${PROJECT_CONTENT_TARGET}\\b`);
const DELETE_IMPERATIVE = /\b(?:remova|apague|exclua)\b/;
const DELETE_ACTION = /(?:remover|deletar|apagar|excluir|remove|delete)/;
const DELETE_LEAD = new RegExp(`^(?:por favor[, ]+)?(?:${DELETE_ACTION.source})\\b|\\b(?:quero|preciso|pode|poderia|deve|vamos|favor|need you to|want you to|can you|could you|please)\\s+(?:${DELETE_ACTION.source})\\b`);
const FOLLOW_UP_DELETE = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)(?:por favor\\s+)?(?:${DELETE_IMPERATIVE.source}|(?:remover|deletar|apagar|excluir)\\b)|\\b(?:and|then|also)\\s+(?:please\\s+)?(?:remove|delete)\\b`);
const PROJECT_OVERVIEW = /\b(arquitetura|architecture|estrutura|structure|informacoes|informacao|overview|visao geral|mapa|inventario|entry point|entrypoint)\b/;
const DIAGNOSE = /\b(erro|error|bug|falha|crash|exception|nao funciona|quebrou|debug|diagnost)\b/;
const CHECK = /\b(teste|testes|tests?|lint|build|compile|compilar|status|diff|verifique|verificar|validate|validar)\b/;
const BROAD_SCOPE = /\b(todo|toda|todos|todas|inteiro|inteira|completo|completa|global|projeto todo|aplicacao toda|codebase|whole|entire|all files|everywhere|arquitetura|architecture|migrar|migrate|modernizar|modernize)\b/;
const MULTI_STEP = /\b(e depois|depois|tambem|al[eé]m disso|em seguida|then|also|after that|and then)\b/;

const FORMAT_PATTERNS = [
  ['bash', /\b(bash|shell script|\.sh)\b/],
  ['json', /\bjson\b/],
  ['table', /\b(tabela|table)\b/],
  ['markdown', /\b(markdown|\.md)\b/]
];

const ARTIFACT_EXTENSION_PATTERNS = Object.freeze([
  ['.html', /(?:^|[^a-z0-9])(?:html|\.html)(?=$|[^a-z0-9])/i],
  ['.css', /(?:^|[^a-z0-9])(?:css|\.css)(?=$|[^a-z0-9])/i],
  ['.js', /(?:^|[^a-z0-9])(?:javascript|java script|js|\.js)(?=$|[^a-z0-9])/i],
  ['.ts', /(?:^|[^a-z0-9])(?:typescript|ts|\.ts)(?=$|[^a-z0-9])/i],
  ['.py', /(?:^|[^a-z0-9])(?:python|py|\.py)(?=$|[^a-z0-9])/i],
  ['.php', /(?:^|[^a-z0-9])(?:php|\.php)(?=$|[^a-z0-9])/i],
  ['.json', /(?:^|[^a-z0-9])(?:json|\.json)(?=$|[^a-z0-9])/i]
]);
const EXPLICIT_FILE_PATTERN = /(?:^|[\s`"'(])([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*\.[a-z0-9]{1,12})(?=$|[\s`"'),.;:!?])/gi;

function outputFormat(text) {
  return FORMAT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || 'markdown';
}

function requestsMutation(text) {
  if (ANALYSIS.test(text) && (FOLLOW_UP_ACTION.test(text) || FOLLOW_UP_DO_ACTION.test(text) || FOLLOW_UP_PROJECT_CONTENT_ACTION.test(text))) return true;
  if (READ_ONLY_LEAD.test(text)) return false;
  return PORTUGUESE_IMPERATIVE.test(text)
    || ACTION_LEAD.test(text)
    || DO_ACTION.test(text)
    || GENERIC_BUILD_ACTION.test(text)
    || PROJECT_CONTENT_ACTION.test(text);
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
  const text = normalize(query);
  let score = Math.min(3, Math.floor(String(query || '').length / 700));
  if (['change', 'fix'].includes(kind)) score += 2;
  if (kind === 'project_overview') score += 1;
  if (BROAD_SCOPE.test(text)) score += 2;
  if (MULTI_STEP.test(text)) score += 1;
  if ((String(query || '').match(/[,;]\s*/g) || []).length >= 5) score += 1;
  if ((project?.fileCount || 0) > 80) score += 1;
  if ((project?.fileCount || 0) > 500) score += 1;
  if ((project?.fileCount || 0) > 2000) score += 1;
  return score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
}

function artifactPlanFor(query, mutationIntent) {
  const source = String(query || '');
  const normalized = normalize(source);
  const requiredFiles = [];
  for (const match of normalized.matchAll(EXPLICIT_FILE_PATTERN)) {
    const candidate = String(match[1] || '').replace(/^\.\//, '');
    if (candidate && !requiredFiles.includes(candidate)) requiredFiles.push(candidate);
  }
  const requiredExtensions = ARTIFACT_EXTENSION_PATTERNS
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([extension]) => extension);
  const minimumWrites = mutationIntent === 'create_project'
    ? Math.max(1, requiredFiles.length, requiredExtensions.length)
    : mutationIntent === 'create_file' ? 1 : 0;
  return {
    mode: mutationIntent === 'create_project' ? 'multi_file' : mutationIntent === 'create_file' ? 'single_file' : 'unspecified',
    requiredFiles,
    requiredExtensions,
    minimumWrites
  };
}

function toolPolicyFor(kind, text, complexity = 'low', mutationIntent = 'edit', artifacts = null) {
  if (kind === 'project_overview') {
    return {
      strategy: 'local_project_profile', allowed: [], maxBatches: 0, maxCallsPerBatch: 0,
      maxResultCharacters: 0, maxTaskResultCharacters: 0
    };
  }
  if (kind === 'answer') {
    return {
      strategy: 'no_project_tools', allowed: [], maxBatches: 0, maxCallsPerBatch: 0,
      maxResultCharacters: 0, maxTaskResultCharacters: 0
    };
  }
  if (['change', 'fix'].includes(kind)) {
    if (mutationIntent === 'create_project') {
      return {
        strategy: 'direct_service',
        mutationIntent,
        allowed: ['write_project_files'],
        maxBatches: 0,
        maxExplorationBatches: 0,
        maxMutationAttempts: 3,
        maxCallsPerBatch: 1,
        maxResultCharacters: 16_000,
        maxTaskResultCharacters: 40_000,
        searchFirst: false,
        preferTargetedReplacement: false,
        verificationMode: 'batch_write_confirmation',
        expectedArtifacts: artifacts
      };
    }
    if (mutationIntent === 'create_file') {
      return {
        strategy: 'direct_mutation',
        mutationIntent,
        allowed: ['write_project_file'],
        maxBatches: 0,
        maxExplorationBatches: 0,
        maxMutationAttempts: complexity === 'high' ? 2 : 1,
        maxCallsPerBatch: 1,
        maxResultCharacters: 12_000,
        maxTaskResultCharacters: complexity === 'high' ? 36_000 : 24_000,
        searchFirst: false,
        preferTargetedReplacement: false,
        verificationMode: 'write_confirmation'
      };
    }
    if (mutationIntent === 'create_directory') {
      return {
        strategy: 'direct_mutation',
        mutationIntent,
        allowed: ['create_project_directory'],
        maxBatches: 0,
        maxExplorationBatches: 0,
        maxMutationAttempts: 1,
        maxCallsPerBatch: 1,
        maxResultCharacters: 4_000,
        maxTaskResultCharacters: 8_000,
        searchFirst: false,
        preferTargetedReplacement: false,
        verificationMode: 'write_confirmation'
      };
    }

    const allowed = [
      ...PROJECT_READ_TOOL_NAMES,
      ...PROJECT_MUTATION_TOOL_NAMES.filter(name => name !== 'delete_project_path' && name !== 'write_project_files'),
      ...PROJECT_VERIFICATION_TOOL_NAMES
    ];
    if (requestsDeletion(text)) allowed.push('delete_project_path');
    const explorationBatches = complexity === 'high' ? 4 : complexity === 'medium' ? 3 : 2;
    return {
      strategy: 'bounded_agent',
      mutationIntent,
      allowed,
      maxBatches: explorationBatches,
      maxExplorationBatches: explorationBatches,
      maxMutationAttempts: complexity === 'high' ? 5 : 4,
      maxCallsPerBatch: 1,
      maxResultCharacters: 12_000,
      maxTaskResultCharacters: complexity === 'high' ? 48_000 : complexity === 'medium' ? 36_000 : 28_000,
      searchFirst: true,
      preferTargetedReplacement: true,
      verificationMode: 'auto'
    };
  }
  const allowed = [...PROJECT_READ_TOOL_NAMES];
  if (CHECK.test(text)) allowed.push(...PROJECT_VERIFICATION_TOOL_NAMES);
  return {
    strategy: 'bounded_read_only', allowed, maxBatches: 1,
    maxCallsPerBatch: 4, maxResultCharacters: 10_000, maxTaskResultCharacters: 24_000
  };
}

function successCriteria(kind, format, project, artifacts) {
  const criteria = ['Responder integralmente ao pedido sem inventar informações.'];
  if (project) criteria.push('Usar evidências reais do projeto ativo e preservar alterações existentes que não façam parte do pedido.');
  if (kind === 'project_overview') criteria.push('Incluir inventário, tecnologias, pontos de entrada, estrutura e riscos observáveis.');
  if (['change', 'fix'].includes(kind)) {
    criteria.push('Executar pelo menos uma alteração real confirmada por ferramenta; um plano ou código apenas no chat não conclui a tarefa.');
    criteria.push('Usar busca/leitura apenas até obter contexto suficiente, adaptar-se a erros de ferramenta e verificar o resultado quando houver rotina segura disponível.');
    if (artifacts?.mode === 'multi_file') {
      criteria.push(`Confirmar a gravação de todos os artefatos do serviço em uma única operação segura (${artifacts.minimumWrites} arquivo(s) mínimo(s)).`);
    }
  }
  if (format !== 'markdown') criteria.push(`Entregar o resultado principal no formato ${format}.`);
  return criteria;
}

function stepsFor(kind, mutationIntent = 'edit', artifacts = null) {
  if (kind === 'change' && mutationIntent === 'create_project') {
    return [
      `Preparar os artefatos do serviço${artifacts?.requiredExtensions?.length ? ` (${artifacts.requiredExtensions.join(', ')})` : ''}`,
      'Gravar todos os arquivos em uma operação atômica',
      'Reler e confirmar cada arquivo no disco'
    ].map((label, index) => ({ id: `step-${index + 1}`, label, status: index === 0 ? 'in_progress' : 'pending' }));
  }
  if (kind === 'change' && mutationIntent === 'create_file') {
    return ['Gerar o conteúdo necessário', 'Gravar o arquivo solicitado', 'Confirmar a gravação'].map((label, index) => ({
      id: `step-${index + 1}`, label, status: index === 0 ? 'in_progress' : 'pending'
    }));
  }
  if (kind === 'change' && mutationIntent === 'create_directory') {
    return ['Criar a pasta solicitada', 'Confirmar a criação'].map((label, index) => ({
      id: `step-${index + 1}`, label, status: index === 0 ? 'in_progress' : 'pending'
    }));
  }
  const steps = {
    project_overview: ['Inventariar o projeto localmente', 'Identificar arquitetura e pontos de entrada', 'Gerar relatório verificável'],
    diagnose: ['Localizar evidências', 'Determinar causa provável', 'Relatar diagnóstico e validação'],
    analysis: ['Recuperar contexto relevante', 'Analisar evidências', 'Sintetizar conclusão'],
    change: ['Localizar o menor conjunto de código relevante', 'Aplicar as alterações reais solicitadas', 'Verificar o resultado e concluir'],
    fix: ['Reproduzir/localizar a causa', 'Aplicar correção real e mínima', 'Executar verificação de regressão e concluir'],
    answer: ['Compreender o pedido', 'Responder objetivamente']
  }[kind];
  return steps.map((label, index) => ({ id: `step-${index + 1}`, label, status: index === 0 ? 'in_progress' : 'pending' }));
}

function requestPolicy(kind, complexity, mutationIntent = 'edit', artifacts = null) {
  if (kind === 'project_overview') return { limit: 0, inputTokenLimit: 0, maxRequestInputTokens: 0, reserveFinal: 0, deadlineMs: 0 };
  if (['change', 'fix'].includes(kind)) {
    if (mutationIntent === 'create_directory') {
      return { limit: 1, inputTokenLimit: 8_000, maxRequestInputTokens: 4_000, reserveFinal: 0, deadlineMs: 20_000 };
    }
    if (mutationIntent === 'create_project') {
      const minimumWrites = Math.max(1, Number(artifacts?.minimumWrites || 1));
      return {
        limit: 3,
        inputTokenLimit: Math.max(48_000, minimumWrites * 16_000),
        maxRequestInputTokens: 16_000,
        reserveFinal: 0,
        deadlineMs: 120_000
      };
    }
    if (mutationIntent === 'create_file') {
      return complexity === 'high'
        ? { limit: 2, inputTokenLimit: 48_000, maxRequestInputTokens: 16_000, reserveFinal: 0, deadlineMs: 90_000 }
        : { limit: 1, inputTokenLimit: 16_000, maxRequestInputTokens: 12_000, reserveFinal: 0, deadlineMs: 45_000 };
    }

    const limit = complexity === 'high' ? 14 : 6;
    const inputTokenLimit = complexity === 'high' ? 144_000 : 72_000;
    const maxRequestInputTokens = complexity === 'high' ? 16_000 : 14_000;
    const deadlineMs = complexity === 'high' ? 240_000 : 180_000;
    return { limit, inputTokenLimit, maxRequestInputTokens, reserveFinal: 1, deadlineMs };
  }
  if (['analysis', 'diagnose'].includes(kind)) {
    return { limit: 3, inputTokenLimit: 30_000, maxRequestInputTokens: 14_000, reserveFinal: 1, deadlineMs: 90_000 };
  }
  return { limit: 4, inputTokenLimit: 36_000, maxRequestInputTokens: 12_000, reserveFinal: 1, deadlineMs: 90_000 };
}

export function createTaskContract(query, options = {}) {
  const text = normalize(query);
  const project = options.project || null;
  const kind = taskKind(text, Boolean(project));
  const format = outputFormat(text);
  const complexity = complexityFor(kind, query, project);
  const mutationIntent = ['change', 'fix'].includes(kind) ? projectMutationIntent(text) : 'edit';
  const artifacts = artifactPlanFor(query, mutationIntent);
  const toolPolicy = toolPolicyFor(kind, text, complexity, mutationIntent, artifacts);

  return {
    id: crypto.randomUUID(),
    version: 4,
    createdAt: new Date().toISOString(),
    objective: String(query || '').trim(),
    kind,
    complexity,
    readOnly: !['change', 'fix'].includes(kind),
    outputFormat: format,
    project: project ? { id: project.id, name: project.name, fileCount: project.fileCount, writable: project.writable } : null,
    artifacts,
    requestBudget: requestPolicy(kind, complexity, mutationIntent, artifacts),
    toolPolicy,
    successCriteria: successCriteria(kind, format, project, artifacts),
    steps: stepsFor(kind, mutationIntent, artifacts)
  };
}

export function publicTaskContract(contract) {
  if (!contract) return null;
  return structuredClone(contract);
}
