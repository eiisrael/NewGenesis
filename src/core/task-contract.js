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
const ENGLISH_ACTION = /(?:fix|create|update|change|implement|remove|delete|move|rename|edit|write|improve|optimize|refactor|organize|simplify|modernize|migrate)/;
const ACTION_VERB = new RegExp(`(?:${PORTUGUESE_ACTION.source}|${ENGLISH_ACTION.source})`);
const ACTION_LEAD = new RegExp(`^(?:por favor[, ]+)?(?:${ACTION_VERB.source})\\b|\\b(?:quero|preciso|pode|poderia|deve|vamos|favor|need you to|want you to|can you|could you|please)\\s+(?:${ACTION_VERB.source})\\b`);
const FOLLOW_UP_ACTION = new RegExp(`(?:[.!?;,]\\s*|\\b(?:e|depois|entao|tambem)\\s+)(?:por favor\\s+)?(?:faca\\s+)?(?:${PORTUGUESE_IMPERATIVE.source}|${PORTUGUESE_ACTION.source}\\b)|\\b(?:and|then|also)\\s+(?:please\\s+)?${ENGLISH_ACTION.source}\\b`);
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

function toolPolicyFor(kind, text, complexity = 'low') {
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
    const mutationIntent = projectMutationIntent(text);

    // Criações explícitas não precisam pesquisar um conteúdo que ainda não existe.
    // Expor uma única ferramenta também torna a execução determinística e econômica.
    if (mutationIntent === 'create_file') {
      return {
        strategy: 'direct_mutation',
        mutationIntent,
        allowed: ['write_project_file'],
        maxBatches: 0,
        maxExplorationBatches: 0,
        maxMutationAttempts: 2,
        maxCallsPerBatch: 1,
        maxResultCharacters: 12_000,
        maxTaskResultCharacters: 24_000,
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
      ...PROJECT_MUTATION_TOOL_NAMES.filter(name => name !== 'delete_project_path'),
      ...PROJECT_VERIFICATION_TOOL_NAMES
    ];
    if (requestsDeletion(text)) allowed.push('delete_project_path');
    const explorationBatches = complexity === 'high' ? 4 : complexity === 'medium' ? 3 : 2;
    return {
      // Nome preservado por compatibilidade com integrações antigas; o comportamento
      // agora é agentic, sequencial, search-first e com escrita obrigatória.
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

function successCriteria(kind, format, project) {
  const criteria = ['Responder integralmente ao pedido sem inventar informações.'];
  if (project) criteria.push('Usar evidências reais do projeto ativo e preservar alterações existentes que não façam parte do pedido.');
  if (kind === 'project_overview') criteria.push('Incluir inventário, tecnologias, pontos de entrada, estrutura e riscos observáveis.');
  if (['change', 'fix'].includes(kind)) {
    criteria.push('Executar pelo menos uma alteração real confirmada por ferramenta; um plano ou código apenas no chat não conclui a tarefa.');
    criteria.push('Usar busca/leitura apenas até obter contexto suficiente, adaptar-se a erros de ferramenta e verificar o resultado quando houver rotina segura disponível.');
  }
  if (format !== 'markdown') criteria.push(`Entregar o resultado principal no formato ${format}.`);
  return criteria;
}

function stepsFor(kind, mutationIntent = 'edit') {
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

function requestPolicy(kind, complexity, mutationIntent = 'edit') {
  if (kind === 'project_overview') return { limit: 0, inputTokenLimit: 0, maxRequestInputTokens: 0, reserveFinal: 0, deadlineMs: 0 };
  if (['change', 'fix'].includes(kind)) {
    if (mutationIntent === 'create_directory') {
      return { limit: 2, inputTokenLimit: 12_000, maxRequestInputTokens: 6_000, reserveFinal: 0, deadlineMs: 30_000 };
    }
    if (mutationIntent === 'create_file' && complexity !== 'high') {
      return { limit: 3, inputTokenLimit: 36_000, maxRequestInputTokens: 10_000, reserveFinal: 1, deadlineMs: 60_000 };
    }

    // Edições comuns precisam ser econômicas: busca -> contexto mínimo -> escrita ->
    // verificação -> síntese. Só tarefas realmente amplas ganham orçamento de 14.
    const limit = complexity === 'high' ? 14 : 6;
    const inputTokenLimit = complexity === 'high' ? 144_000 : 72_000;
    const maxRequestInputTokens = complexity === 'high' ? 16_000 : 14_000;
    const deadlineMs = complexity === 'high' ? 240_000 : 180_000;
    // O orquestrador ignora esta reserva enquanto nenhuma mutação aconteceu; depois
    // da escrita, uma chamada fica protegida para a síntese final.
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
  const toolPolicy = toolPolicyFor(kind, text, complexity);
  const mutationIntent = toolPolicy.mutationIntent || 'edit';

  return {
    id: crypto.randomUUID(),
    version: 3,
    createdAt: new Date().toISOString(),
    objective: String(query || '').trim(),
    kind,
    complexity,
    readOnly: !['change', 'fix'].includes(kind),
    outputFormat: format,
    project: project ? { id: project.id, name: project.name, fileCount: project.fileCount, writable: project.writable } : null,
    requestBudget: requestPolicy(kind, complexity, mutationIntent),
    toolPolicy,
    successCriteria: successCriteria(kind, format, project),
    steps: stepsFor(kind, mutationIntent)
  };
}

export function publicTaskContract(contract) {
  if (!contract) return null;
  return structuredClone(contract);
}
