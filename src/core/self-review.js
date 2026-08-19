// Genesis — Self Review Engine
// Revisa automaticamente cada patch/alteração antes da entrega.
// COMPOSIÇÃO (não reinventa): recebe um diff lógico e combina:
//   - planner.renderPlan (plano da tarefa)
//   - impact-analyzer.safeAnalyze (impacto real via SupremeMind)
//   - code-quality (duplicações / funções longas)
//   - context-compressor (otimização de tokens)
//   - hierarchical-memory (consistência entre camadas)

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/3 — Helpers para análise sintática superficial do patch.
// ─────────────────────────────────────────────────────────────────────────────

function readPatchStats(patch) {
  if (!patch || typeof patch !== 'string') return { files: [], added: 0, removed: 0 };
  const files = new Set();
  let added = 0, removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('*** ')) continue;
    if (line.startsWith('--- ')) continue;
    const diffLine = line.match(/^(\+\+\+|---|@@|\+|-) ?(.*)$/);
    if (diffLine) {
      const sign = diffLine[1];
      if (sign === '+') added += 1;
      else if (sign === '-') removed += 1;
      if (line.startsWith('+++') || line.startsWith('---')) {
        if (!line.startsWith('+++') === !line.startsWith('---')) {
          const fn = line.replace(/^(\+\+\+|---) /, '').trim();
          if (fn) files.add(fn);
        }
      }
    }
  }
  return { files: [...files], added, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2/3 — Reuso dos outros engines para decidir se o patch passa/falha.
// ─────────────────────────────────────────────────────────────────────────────

export async function review({ patch, task, plan, impact, duplicates, longFns,
                              projectRoot, supremeMind }) {
  const findings = [];
  const stats = readPatchStats(patch || '');

  // Coerência arquitetural
  if (stats.files.length > 8) {
    findings.push({ severity: 'warning', message: `Patch toca ${stats.files.length} arquivos — recomenda-se separar.` });
  }
  if (stats.added + stats.removed > 200) {
    findings.push({ severity: 'warning', message: 'Patch grande (>200 linha sumadas). Avaliar dividir em commits menores.' });
  }

  // Aproveitar o impacto (se fornecido via análise anterior)
  const impactInfo = impact || (supremeMind && supremeMind.isIndexed() && plan?.steps?.length
    ? await impactAnalysisForFirstRelevantFile(supremeMind, plan) : null);
  if (impactInfo && (impactInfo.risk === 'CRITICAL' || impactInfo.risk === 'HIGH')) {
    findings.push({
      severity: 'error',
      message: `Risco ${impactInfo.risk} detectado — alteração exige revisão manual.`,
      detail: impactInfo.summary
    });
  }

  // Duplicações
  if (duplicates && duplicates.length) {
    findings.push({
      severity: 'warning',
      message: `Detectadas ${duplicates.length} possíveis duplicações.`,
      suggestion: 'Centralize antes de integrar.'
    });
  }

  // Funções longas
  if (longFns?.length) {
    findings.push({
      severity: 'info',
      message: `Funções longas detectadas (top: ${longFns.slice(0, 3).map(f => f.name || '(anônima)').join(', ')}).`
    });
  }

  // Compatibilidade regressiva
  const regressionRisk = regressionHint(patch);
  if (regressionRisk) {
    findings.push({ severity: 'warning', message: regressionRisk });
  }

  const approved = !findings.some(f => f.severity === 'error');
  return {
    ok: true,
    approved,
    patchStats: stats,
    findings,
    recommendations: buildRecommendations(findings, stats)
  };
}

async function impactAnalysisForFirstRelevantFile(supremeMind, plan) {
  try {
    const step = plan.steps.find(s => /Ler arquivos relevantes|Identificar/i.test(s.label || ''));
    const target = step?.goal?.match(/\b[\w/]+\.(?:js|ts|md)\b/)?.[0];
    if (!target) return null;
    return await supremeMind.getImpact(target, 2);
  } catch { return null; }
}

function regressionHint(patch) {
  if (!patch) return null;
  if (/^[\+\-\s]*(?:async\s+)?(?:function|const|export)\s.*\b(?:require|import)\b.*from\s+['"][^'"]+['"]/m.test(patch)) {
    return 'Patch inclui novo import — garantir compatibilidade de caminho.';
  }
  if (/\bpublic\s+(?:class|function)\s+[A-Za-z0-9_]+/.test(patch)) {
    return 'Patch introduz símbolo público — verificar contrato.';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3/3 — Render do relatório em PT-BR.
// ─────────────────────────────────────────────────────────────────────────────

function buildRecommendations(findings, stats) {
  const recs = [];
  if (!findings.find(f => f.severity === 'error')) recs.push('Aprovar e seguir para testes.');
  if (stats.added > 0 && stats.removed === 0) recs.push('Considerar adicionar teste simultâneo para o que foi alterado.');
  if (stats.files.length) recs.push('Confirmar contexto da tarefa antes de aplicar.');
  if (findings.find(f => f.message.includes('duplicações'))) {
    recs.push('Refatore para evitar duplicação de blocos.');
  }
  return [...new Set(recs)];
}

export function renderReview(review) {
  if (!review?.ok) return 'Revisão falhou.';
  const lines = [`Revisão ${review.approved ? 'APROVADA ✅' : 'BLOQUEADA ❌'} — ${review.patchStats.files.length} arquivos · +${review.patchStats.added}/-${review.patchStats.removed} linhas`];
  for (const f of review.findings) lines.push(` • [${f.severity.toUpperCase()}] ${f.message}`);
  if (review.recommendations.length) {
    lines.push('Recomendações:');
    for (const r of review.recommendations) lines.push(` → ${r}`);
  }
  return lines.join('\n');
}
