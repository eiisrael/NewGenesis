// Genesis — Impact Analysis Engine
// Wrapper em torno da análise já existente no SupremeMind (`getImpact`)
// que converte pontuação bruta em relatórios legíveis para o usuário.

import { safeError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/3 — Rótulos traduzidos e plano de mitigação por nível de risco.
// ─────────────────────────────────────────────────────────────────────────────

const RISK_LEVELS = {
  CRITICAL: { color: '#ff5167', needApproval: true, mustTest: true,
              note: 'Mudança sensível — exige revisão e aprovação.' },
  HIGH:     { color: '#ffa44b', needApproval: true, mustTest: true,
              note: 'Pode quebrar funcionalidades importantes — revisar antes.' },
  MODERATE: { color: '#ffb86b', needApproval: false, mustTest: true,
              note: 'Mudança ampla — recomenda-se teste manual.' },
  LOW:      { color: '#59f0c8', needApproval: false, mustTest: false,
              note: 'Mudança pontual e bem isolada — risco mínimo.' }
};

const RISK_RECOMMENDATIONS = {
  CRITICAL: [
    'Aprovar com Guardian antes de aplicar.',
    'Executar smoke test do módulo relacionado.',
    'Notificar o usuário sobre o impacto esperado.'+
    '',
    'Salvar backup dos arquivos afetados antes de modificar.'
  ].filter(Boolean),
  HIGH: [
    'Solicitar aprovação do usuário.',
    'Conferir diff de entradas e saídas das funções impactadas.'
  ],
  MODERATE: [
    'Executar suíte de testes do projeto (`npm run check`).'
  ],
  LOW: []
};

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2/3 — Formata a saída do SupremeMind em um relatório de impacto.
// ─────────────────────────────────────────────────────────────────────────────

export function humanizeImpact(impact) {
  if (!impact || impact.error) {
    return {
      ok: false,
      title: 'Impacto não pode ser avaliado',
      message: impact?.error || 'Arquivo ou caminho não indexado.',
      recommendation: 'Execute o indexador do SupremeMind antes: `POST /api/suprememind/index`.',
      score: 0, risk: 'UNKNOWN', level: null
    };
  }
  const level = RISK_LEVELS[impact.risk] || RISK_LEVELS.MODERATE;
  const recos = RISK_RECOMMENDATIONS[impact.risk] || [];
  const topImpacted = (impact.impacted || [])
    .slice(0, 10)
    .map(item => ({
      path: item.path,
      depth: item.depth,
      weight: Number(item.weight?.toFixed?.(2)) || 0,
      type: item.type,
      via: item.via
    }));
  return {
    ok: true,
    title: `Alteração afeta ${impact.indirect + 1} arquivos`,
    risk: impact.risk,
    color: level.color,
    score: impact.score,
    direct: impact.direct,
    indirect: impact.indirect,
    note: level.note,
    needApproval: level.needApproval,
    mustTest: level.mustTest,
    recommendation: recos,
    impacted: topImpacted,
    summary: buildSummary(impact)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3/3 — Resumo textual em PT-BR.
// ─────────────────────────────────────────────────────────────────────────────

function buildSummary(impact) {
  const dirs = (impact.impacted || []).filter(i => i.depth === 1);
  const pieces = [];
  pieces.push(`Arquivo alvo: ${impact.target || '(não definido)'}.`);
  pieces.push(`Risco calculado: ${impact.risk} (score ${impact.score}).`);
  if (dirs.length) {
    pieces.push(`Arquivos diretamente dependentes: ${dirs.map(d => d.path).slice(0, 8).join(', ')}${dirs.length > 8 ? ` (+${dirs.length - 8})` : ''}.`);
  }
  if (impact.indirect > 0) {
    pieces.push(`Arquivos indiretamente afetados: ${impact.indirect}.`);
  }
  return pieces.join(' ');
}

// Casca defensiva: se o SupremeMind falhar em qualquer ponto, o relatório
// continua sendo útil. Use sempre este wrapper nas chamadas externas.
export async function safeAnalyze(supremeMind, targetPath, depth = 3) {
  try {
    if (!supremeMind?.isIndexed()) {
      return humanizeImpact({ error: 'SupremeMind não está indexado — rode POST /api/suprememind/index primeiro.' });
    }
    const raw = await supremeMind.getImpact(targetPath, depth);
    return humanizeImpact(raw);
  } catch (error) {
    return { ...humanizeImpact({ error: safeError(error).message }), ok: false };
  }
}
