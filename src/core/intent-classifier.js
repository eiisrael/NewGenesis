// Genesis — Intent Classifier
// Classifica a intenção do usuário para otimizar orçamento de contexto.
// Reusa: estimateTokens, terms (de context-engine.js)

import { estimateTokens } from './context-engine.js';

const INTENT_PATTERNS = {
  CODE: [
    /\b(crie|criar|implemente|implementar|adicione|adicionar|escreva|escrever|codifique|codificar|program|code|function|class|const|let|var|import|export|async|await)\b/i,
    /\b(react|vue|angular|node|express|typescript|javascript|python|rust|go|java|c#|\.js|\.ts|\.py|\.json|\.html|\.css)\b/i,
    /\b(algorithm|algoritmo|data structure|estrutura de dados|complexity|complexidade|big-o|O\(n\))\b/i
  ],
  DEBUG: [
    /\b(depurar|debug|erro|error|bug|falha|crash|exception|stack trace|traceback|não funciona|broken|fix|corrigir|consertar)\b/i,
    /\b(log|console|print|assert|test|teste|unit test|integration test)\b/i
  ],
  ARCHITECTURE: [
    /\b(arquitetura|architecture|design|pattern|padrão|scalability|escalabilidade|modular|modularidade|microservices|monolito|clean architecture|domain-driven|ddd|hexagonal|onion)\b/i,
    /\b(refatorar|refactor|reestruturar|restructure|decouple|desacoplar|solid|dry|kiss|yagni)\b/i
  ],
  DOCUMENTATION: [
    /\b(documentação|documentation|readme|docstring|comment|comentário|swagger|openapi|api docs|manual|guia|tutorial)\b/i,
    /\b(como usar|how to|exemplo|example|usage|uso|getting started)\b/i
  ],
  RESEARCH: [
    /\b(pesquise|pesquisa|research|investigue|analise|analyze|compare|comparar|benchmark|avalie|evaluate|pros and cons|vantagens e desvantagens)\b/i,
    /\b(best practice|melhor prática|state of the art|estado da arte|latest|mais recente|trending|tendência)\b/i
  ],
  REFACTOR: [
    /\b(refatore|refatorar|refactor|melhorar|improve|otimizar|optimize|clean up|limpar|código limpo|clean code|legacy|legado|technical debt|dívida técnica)\b/i
  ],
  ANALYSIS: [
    /\b(analise|analisar|análise|analysis|examine|examinar|inspecione|inspect|review|revisão|auditoria|audit|avaliação|assessment)\b/i
  ],
  EXPLANATION: [
    /\b(explique|explicar|explique como|como funciona|how does|what is|o que é|defina|define|conceito|concept|meaning|significado)\b/i
  ],
  BUG: [
    /\b(bug|issue|problema|problem|incidente|regression|regressão|quebrou|broke|stopped working|parou de funcionar)\b/i
  ],
  PERFORMANCE: [
    /\b(performance|desempenho|otimização|optimization|latency|latência|throughput|vazamento|memory leak|bottleneck|gargalo|profiling|profile)\b/i
  ],
  DEPENDENCY: [
    /\b(dependência|dependency|package|pacote|npm|yarn|pnpm|import|require|library|biblioteca|framework|version|versão|upgrade|atualizar|update)\b/i
  ],
  MEMORY: [
    /\b(memória|memory|heap|stack|garbage collection|gc|allocation|alocação|leak|vazamento|ram|cpu)\b/i
  ],
  SUPREMEMIND: [
    /\b(supreme|suprememind|index|indexar|indexar projeto|search|buscar|símbolo|symbol|grafo|graph|impacto|impact|órbita|orbit|memória projeto|project memory)\b/i
  ]
};

const INTENT_BUDGETS = {
  CHAT: { system: 1.0, history: 1.0, supremeMind: 0.3, project: 0.2, memory: 0.5, ledger: 0.5, query: 1.0 },
  CODE: { system: 1.0, history: 0.7, supremeMind: 0.8, project: 1.0, memory: 0.6, ledger: 0.4, query: 1.0 },
  DEBUG: { system: 1.0, history: 0.9, supremeMind: 0.6, project: 0.9, memory: 0.7, ledger: 0.6, query: 1.0 },
  ARCHITECTURE: { system: 1.0, history: 0.5, supremeMind: 1.0, project: 1.0, memory: 0.8, ledger: 0.5, query: 1.0 },
  DOCUMENTATION: { system: 1.0, history: 0.3, supremeMind: 0.7, project: 0.8, memory: 0.5, ledger: 0.3, query: 1.0 },
  RESEARCH: { system: 1.0, history: 0.4, supremeMind: 0.9, project: 0.7, memory: 0.6, ledger: 0.4, query: 1.0 },
  REFACTOR: { system: 1.0, history: 0.6, supremeMind: 1.0, project: 1.0, memory: 0.7, ledger: 0.5, query: 1.0 },
  ANALYSIS: { system: 1.0, history: 0.6, supremeMind: 1.0, project: 0.9, memory: 0.7, ledger: 0.5, query: 1.0 },
  EXPLANATION: { system: 1.0, history: 0.4, supremeMind: 0.5, project: 0.5, memory: 0.5, ledger: 0.3, query: 1.0 },
  BUG: { system: 1.0, history: 0.8, supremeMind: 0.7, project: 0.9, memory: 0.6, ledger: 0.6, query: 1.0 },
  PERFORMANCE: { system: 1.0, history: 0.5, supremeMind: 0.8, project: 0.8, memory: 0.6, ledger: 0.4, query: 1.0 },
  DEPENDENCY: { system: 1.0, history: 0.3, supremeMind: 0.6, project: 0.7, memory: 0.4, ledger: 0.3, query: 1.0 },
  MEMORY: { system: 1.0, history: 0.4, supremeMind: 0.5, project: 0.5, memory: 0.5, ledger: 0.3, query: 1.0 },
  SUPREMEMIND: { system: 1.0, history: 0.2, supremeMind: 1.0, project: 0.6, memory: 0.3, ledger: 0.2, query: 1.0 }
};

function terms(value) {
  const STOP_WORDS = new Set('a ao aos as com como da das de do dos e em entre essa esse esta este eu isso isto já mais mas me meu minha na nas no nos o os ou para pela pelo por porque que se sem ser seu sua um uma você the and are for from have into not of on or that this to was will with'.split(' '));
  return new Set(String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9_]{3,}/g)
    ?.filter(term => !STOP_WORDS.has(term)) || []);
}

export function classifyIntent(query, context = {}) {
  const queryTerms = terms(query);
  if (!queryTerms.size) return { intent: 'CHAT', confidence: 0.5, budget: INTENT_BUDGETS.CHAT };

  const scores = {};
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(query)) score += 2;
    }
    // Boost por termos no query
    for (const term of queryTerms) {
      for (const pattern of patterns) {
        if (pattern.test(term)) score += 1;
      }
    }
    scores[intent] = score;
  }

  // Contexto adicional (anexos, projeto, etc.)
  if (context.hasCodeAttachments) scores.CODE = (scores.CODE || 0) + 3;
  if (context.hasErrorLogs) scores.DEBUG = (scores.DEBUG || 0) + 3;
  if (context.isProjectIndexed) {
    scores.ARCHITECTURE = (scores.ARCHITECTURE || 0) + 1;
    scores.REFACTOR = (scores.REFACTOR || 0) + 1;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = sorted[0];
  const secondScore = sorted[1]?.[1] || 0;

  const confidence = topScore > 0
    ? Math.min(0.95, 0.5 + (topScore - secondScore) * 0.1)
    : 0.5;

  return {
    intent: topScore > 0 ? topIntent : 'CHAT',
    confidence,
    budget: INTENT_BUDGETS[topScore > 0 ? topIntent : 'CHAT'],
    allScores: scores
  };
}

export function getIntentBudget(intent) {
  return INTENT_BUDGETS[intent] || INTENT_BUDGETS.CHAT;
}
