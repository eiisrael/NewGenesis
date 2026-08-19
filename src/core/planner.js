// Genesis — Intelligent Task Planner
// Divide uma tarefa complexa em etapas lógicas reutilizáveis.
// NÃO reimplementa o Orchestrator — apenas produz um plano que pode ser
// consumido por `orchestrator.respond` como mensagens estruturadas.

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/3 — Heurística de decomposição: uma tarefa vira uma sequência de
// sub-tarefas cada uma com objetivo, contexto e critério de aceitação.
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9_à-ú]{3,}/g) || [];
}

// Categorias reconhecidas a partir de palavras-chave. Cada categoria tem
// uma prioridade e templates de sub-passos correspondentes.
const PATTERNS = [
  { id: 'analyze', weight: 1, hints: /\b(analis[ae]|investig|exam[ie]|revis[ae]|audit)\b/i,
    steps: [
      { label: 'Ler arquivos relevantes', goal: 'Listar todos os arquivos envolvidos na tarefa.' },
      { label: 'Identificar dependências', goal: 'Mapear relações de chamada/import entre os arquivos.' },
      { label: 'Sintetizar achados', goal: 'Resumir diagnóstico num único parágrafo.' }
    ]},
  { id: 'refactor', weight: 2, hints: /\b(refator|reorganiz|melhor[aá]r|limp[ae]?|simplifiq?)\b/i,
    steps: [
      { label: 'Identificar duplicações', goal: 'Detectar funções ou blocos repetidos.' },
      { label: 'Plano de coalescência', goal: 'Definir onde centralizar a lógica duplicada.' },
      { label: 'Aplicar mudanças', goal: 'Editar mantendo cobertura de testes.' },
      { label: 'Verificar regressões', goal: 'Rodar `npm run check` antes de finalizar.' }
    ]},
  { id: 'add-feature', weight: 2, hints: /\b(adicionar|criar|implementar|nova feature|suport)\b/i,
    steps: [
      { label: 'Definir contrato', goal: 'Descrever API/evento gerado.' },
      { label: 'Modelar dados', goal: 'Definir estrutura de entrada/saída.' },
      { label: 'Implementar', goal: 'Codificar com reuso de módulos existentes.' },
      { label: 'Validar', goal: 'Testes manuais e automáticos.' }
    ]},
  { id: 'fix-bug', weight: 3, hints: /\b(bug|erro|falha|quebr|não funcion|não está)\b/i,
    steps: [
      { label: 'Reproduzir', goal: 'Descrever passos que levam ao problema.' },
      { label: 'Diagnosticar', goal: 'Apontar módulo/função culpada.' },
      { label: 'Corrigir', goal: 'Aplicar patch mínimo.' },
      { label: 'Validar correção', goal: 'Confirmar que bug morreu e nada quebrou.' }
    ]},
  { id: 'document', weight: 1, hints: /\b(document|coment[áa]rio|kb|knowledge base|readme)\b/i,
    steps: [
      { label: 'Mapeamento', goal: 'Decidir tópico e escopo da documentação.' },
      { label: 'Escrever', goal: 'Redigir parágrafos curtos, exemplos quando útil.' },
      { label: 'Referenciar', goal: 'Citar arquivos e funções reais.' }
    ]}
];

const DEFAULT = {
  id: 'generic',
  weight: 1,
  steps: [
    { label: 'Compreender', goal: 'Capturar objetivo em uma frase.' },
    { label: 'Executar', goal: 'Realizar o trabalho com ferramentas do Genesis.' },
    { label: 'Confirmar', goal: 'Validar com `npm run check` ou análise manual.' }
  ]
};

function matchPattern(taskText) {
  const matches = PATTERNS.filter(p => p.hints.test(taskText || ''));
  if (!matches.length) return DEFAULT;
  return matches.sort((a, b) => b.weight - a.weight)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2/3 — Decomposição final. O plano inclui dependências e uma fase
// opcional "recall" no início, para reusar análises anteriores salvas no
// memories do SupremeMind.
// ─────────────────────────────────────────────────────────────────────────────

export function planTask(taskText, options = {}) {
  const pattern = matchPattern(taskText);
  const steps = pattern.steps.map((s, index) => ({
    index: index + 1,
    label: s.label,
    goal: s.goal,
    status: 'pending',
    weight: pattern.weight
  }));
  const plan = {
    pattern: pattern.id,
    summary: String(taskText || '').slice(0, 240),
    steps,
    totalSteps: steps.length,
    expectedTokens: options.expectedTokens ?? estimateTokensForPlan(steps)
  };
  // Primeira etapa é uma checagem rápida de memórias existentes (reuso!).
  if (options.recallFirst !== false) {
    plan.steps.unshift({
      index: 0,
      label: 'Recuperar análises anteriores',
      goal: 'Consultar memórias do SupremeMind relevantes para esta tarefa.',
      status: 'pending',
      weight: 0
    });
    plan.steps.forEach((s, i) => { s.index = i; });
    plan.totalSteps = plan.steps.length;
  }
  return plan;
}

function estimateTokensForPlan(steps) {
  return steps.reduce((acc, s) => acc + estimateTokens(s.label) + estimateTokens(s.goal), 0);
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3/3 — Renderização textual (PT-BR) para apresentar ao usuário.
// ─────────────────────────────────────────────────────────────────────────────

export function renderPlan(plan) {
  if (!plan || !plan.steps?.length) return 'Plano vazio.';
  const lines = [`Plano (${plan.pattern}) — ${plan.totalSteps} etapas:`];
  for (const step of plan.steps) lines.push(`  ${step.index + 1}. ${step.label} → ${step.goal}`);
  return lines.join('\n');
}
