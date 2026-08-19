import {
  classifyIntent as classifyContextIntent,
  getIntentBudget as getContextIntentBudget
} from './context-engine.js';

// Compatibilidade para módulos antigos: a classificação oficial vive no
// Context Engine. Manter uma segunda tabela de regex fazia a mesma mensagem
// receber intenções diferentes em partes distintas do Genesis.
export function classifyIntent(query, context = {}) {
  const intent = classifyContextIntent(query);
  const confidence = context?.hasCodeAttachments || context?.hasErrorLogs || context?.isProjectIndexed
    ? 0.85
    : 0.75;
  return {
    intent,
    confidence,
    budget: getContextIntentBudget(intent),
    allScores: { [intent]: 1 }
  };
}

export function getIntentBudget(intent) {
  return getContextIntentBudget(intent);
}
