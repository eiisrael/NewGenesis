import { GenesisOrchestrator } from './core/orchestrator.js';
import { PROJECT_TOOL_DEFINITIONS } from './project-tools.js';
import { ResilientOpenRouterProvider } from './providers/resilient-openrouter-provider.js';

const PROVIDER_PATCH = Symbol.for('genesis.runtimeHardening.provider');
const ORCHESTRATOR_PATCH = Symbol.for('genesis.runtimeHardening.orchestrator');

function normalized(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function latestUserText(conversation) {
  for (let index = (conversation?.messages || []).length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.role === 'user') return String(message.content || '');
  }
  return '';
}

export function shouldVerifyProjectAudit({ conversation, projectContext, toolExecutor } = {}) {
  if (typeof toolExecutor !== 'function' || Number(projectContext?.totalFiles || 0) < 1) return false;
  const text = normalized(latestUserText(conversation));
  if (!/\b(analise|analisar|examine|examinar|inspecione|inspecionar|revise|revisar|avalie|avaliar|audite|auditar|audit|review|analyze|inspect)\b/.test(text)) return false;
  if (!/\b(projeto|pasta|repositorio|repository|codebase|arquitetura|architecture|estrutura|structure|codigo|code)\b/.test(text)) return false;
  if (/\b(sem executar|nao execute|nao executar|sem rodar|nao rode|nao rodar|apenas leitura|somente leitura|read only)\b/.test(text)) return false;
  return true;
}

function transientDiscoveryFailure(error) {
  if (error?.code === 'request_cancelled') return false;
  if (['authentication', 'paid_blocked', 'quota', 'request'].includes(error?.category)) return false;
  return ['availability', 'timeout', 'unknown'].includes(error?.category || 'unknown')
    || ['provider_unreachable', 'provider_timeout'].includes(error?.code);
}

function patchFreeProviderAvailability() {
  const prototype = ResilientOpenRouterProvider.prototype;
  if (prototype[PROVIDER_PATCH]) return;
  Object.defineProperty(prototype, PROVIDER_PATCH, { value: true });

  const inheritedModels = prototype.models;
  const originalStatus = prototype.publicStatus;

  prototype.models = async function hardenedModels(options = {}) {
    const previousActiveModel = this.activeModel;
    this.activeModel = null;
    try {
      return await inheritedModels.call(this, options);
    } catch (error) {
      if (!transientDiscoveryFailure(error)) throw error;

      // A descoberta do catálogo é útil, mas não deve derrubar o roteador
      // openrouter/free. O endpoint de chat ainda pode estar disponível mesmo
      // quando /models sofreu timeout ou indisponibilidade transitória.
      this.health.state = 'degraded';
      this.health.cooldownUntil = 0;
      this.health.lastError = {
        code: error?.code || 'model_catalog_unavailable',
        category: error?.category || 'availability',
        source: 'model_discovery',
        message: String(error?.message || 'Catálogo gratuito temporariamente indisponível.').slice(0, 180)
      };
      this.health.lastCheckedAt = new Date().toISOString();
      const router = typeof this.routeState === 'function' ? this.routeState('openrouter/free') : null;
      if (router) {
        router.cooldownUntil = 0;
        if (router.lastError?.code === error?.code) router.lastError = null;
      }
      return Array.isArray(this.catalog) ? this.catalog : [];
    } finally {
      this.activeModel = previousActiveModel;
    }
  };

  prototype.publicStatus = function hardenedPublicStatus() {
    const status = originalStatus.call(this);
    return {
      ...status,
      freeRouterReady: this.configured === true && this.routeCanAttempt?.('openrouter/free') !== false,
      catalogFallbackActive: this.health.lastError?.source === 'model_discovery'
    };
  };
}

function verifiedAuditContract(source = {}) {
  const contract = structuredClone(source || {});
  contract.kind = 'analysis';
  contract.readOnly = true;
  contract.complexity = contract.complexity || 'medium';
  contract.toolPolicy = {
    ...(contract.toolPolicy || {}),
    strategy: 'verified_project_audit',
    allowed: ['run_project_check'],
    maxBatches: 1,
    maxExplorationBatches: 0,
    maxCallsPerBatch: 1,
    maxResultCharacters: 18_000,
    maxTaskResultCharacters: 20_000,
    verificationMode: 'required_project_check'
  };
  contract.requestBudget = {
    ...(contract.requestBudget || {}),
    limit: Math.max(2, Number(contract.requestBudget?.limit || 0)),
    inputTokenLimit: Math.max(36_000, Number(contract.requestBudget?.inputTokenLimit || 0)),
    maxRequestInputTokens: Math.max(14_000, Number(contract.requestBudget?.maxRequestInputTokens || 0)),
    reserveFinal: 1,
    deadlineMs: Math.max(180_000, Number(contract.requestBudget?.deadlineMs || 0))
  };
  contract.successCriteria = [
    ...new Set([
      ...(contract.successCriteria || []),
      'Executar run_project_check(auto) e basear a conclusão no resultado real da verificação local.',
      'Distinguir disponibilidade dos modelos gratuitos da validação local do projeto.'
    ])
  ];
  contract.steps = [
    { id: 'audit-context', label: 'Analisar o contexto real do projeto', status: 'in_progress' },
    { id: 'audit-check', label: 'Executar a verificação automatizada segura', status: 'pending' },
    { id: 'audit-report', label: 'Concluir com evidências de execução e disponibilidade', status: 'pending' }
  ];
  return contract;
}

function auditAppendix(checkEvidence, providerStatus) {
  const checkLine = checkEvidence?.ok === true
    ? `- Verificação automatizada: **confirmada** — ${checkEvidence.summary || 'run_project_check(auto) concluiu com sucesso.'}`
    : checkEvidence
      ? `- Verificação automatizada: **não confirmada** — ${checkEvidence.summary || checkEvidence.code || 'a rotina não concluiu.'}`
      : '- Verificação automatizada: **sem evidência de execução** nesta tentativa.';
  const providerLine = providerStatus
    ? `- Modelos gratuitos: estado **${providerStatus.state || 'desconhecido'}**, ${Number(providerStatus.modelCount || 0)} modelo(s) catalogado(s), roteador free ${providerStatus.freeRouterReady === false ? '**indisponível**' : '**pronto para tentativa**'}${providerStatus.catalogFallbackActive ? ' (fallback do catálogo ativo)' : ''}.`
    : '- Modelos gratuitos: estado não disponível no snapshot atual.';
  return ['## Validação prática do Genesis', '', checkLine, providerLine].join('\n');
}

function patchVerifiedSelfAudit() {
  const prototype = GenesisOrchestrator.prototype;
  if (prototype[ORCHESTRATOR_PATCH]) return;
  Object.defineProperty(prototype, ORCHESTRATOR_PATCH, { value: true });
  const originalRespond = prototype.respond;

  prototype.respond = async function hardenedRespond(input = {}) {
    if (!shouldVerifyProjectAudit(input)) return originalRespond.call(this, input);

    const checkTool = PROJECT_TOOL_DEFINITIONS.find(tool => tool?.function?.name === 'run_project_check');
    if (!checkTool) return originalRespond.call(this, input);

    const taskContract = verifiedAuditContract(input.taskContract || {});
    const result = await originalRespond.call(this, {
      ...input,
      taskContract,
      // Auditoria real não pode ser encerrada pelo perfil estático local. Ela usa
      // contexto do projeto + run_project_check e só então produz a síntese.
      localResponse: '',
      tools: [checkTool]
    });

    const evidence = result.context?.evidence || [];
    const checkEvidence = [...evidence].reverse().find(item => item?.tool === 'run_project_check') || null;
    const providerStatus = this.statuses().find(status => status.id === 'openrouter') || null;
    if (taskContract.outputFormat !== 'json') {
      result.content = `${String(result.content || '').trim()}\n\n${auditAppendix(checkEvidence, providerStatus)}`.trim();
    }
    result.task = taskContract;
    result.context = {
      ...(result.context || {}),
      task: taskContract,
      audit: {
        projectCheck: checkEvidence,
        freeModels: providerStatus
      }
    };

    if (checkEvidence?.ok !== true) {
      result.verification = {
        ...(result.verification || {}),
        status: 'partial',
        verified: false,
        summary: 'A análise foi produzida, mas a verificação automatizada do projeto não foi confirmada.'
      };
      result.context.verification = result.verification;
    }
    return result;
  };
}

patchFreeProviderAvailability();
patchVerifiedSelfAudit();
