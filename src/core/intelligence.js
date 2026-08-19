// Genesis — Architecture Intelligence (Árbitro)
// FACHADA única para todos os engines de inteligência arquitetural.
// Este módulo centraliza o uso e reusa imports dos engines anteriores.

export * as hierarchicalMemory from './hierarchical-memory.js';
export * as contextCompressor from './context-compressor.js';
export * as impactAnalyzer from './impact-analyzer.js';
export * as planner from './planner.js';
export * as codeQuality from './code-quality.js';
export * as selfReview from './self-review.js';
export * as perfAnalyzer from './perf-analyzer.js';
export * as autoDocs from './auto-docs.js';

// ─────────────────────────────────────────────────────────────────────────────
// Index exports públicos — outros módulos devem preferir estes reexports a
// acessar diretamente os arquivos individuais.
// ─────────────────────────────────────────────────────────────────────────────

import * as HM from './hierarchical-memory.js';
import * as CC from './context-compressor.js';
import * as IA from './impact-analyzer.js';
import * as PL from './planner.js';
import * as CQ from './code-quality.js';
import * as SR from './self-review.js';
import * as PA from './perf-analyzer.js';
import * as AD from './auto-docs.js';

// ─────────────────────────────────────────────────────────────────────────────
// Função orquestradora única — usada por qualquer motor que queira ver
// a arquitetura num único ponto.
// ─────────────────────────────────────────────────────────────────────────────

export async function quickArchitecturalAudit({ projectRoot, supremeMind, telemetry, task }) {
  const checks = {
    kb: HM.getKnowledgeBaseText()
      ? { present: true, length: HM.getKnowledgeBaseText().length }
      : { present: false },
    perf: telemetry ? await PA.analyzeProjectPerformance({ dataDir: telemetry.dataDir }) : null,
    duplicateCount: 0,
    plan: task ? PL.planTask(task) : null
  };
  if (projectRoot) {
    const files = await CQ.detectDuplicates([]);
    checks.duplicateCount = files.length;
    // Imediatamente dispara o sync do KB (idempotente)
    await AD.syncKnowledgeBase(projectRoot);
    if (supremeMind && supremeMind.isIndexed() && task) {
      const plan = checks.plan;
      const target = plan?.steps?.find(s => /Ler arquivos/i.test(s.label))?.goal
        ?.match(/\b[\w/]+\.(?:js|ts|md)\b/)?.[0];
      if (target) {
        const impact = await IA.safeAnalyze(supremeMind, target, 2);
        checks.impacted = impact;
      }
    }
  }
  return checks;
}
