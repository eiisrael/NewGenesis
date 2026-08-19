// Genesis — Auto-Documentation Sync
// Mantém o GENESIS_KNOWLEDGE_BASE.md em sincronia com o estado real do
// projeto sem sobrescrever o trabalho manual. Atualiza só as seções
// "automaticamente verificáveis": contagem de arquivos, testes,
// estatísticas de telemetria, módulos novos no src/core/.

import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { analyzeProjectPerformance } from './perf-analyzer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/5 — Helpers de I/O.
// ─────────────────────────────────────────────────────────────────────────────

async function listSrcModules(root) {
  const src = join(root, 'src');
  const out = [];
  if (!existsSync(src)) return out;
  const stack = [src];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.js')) {
        const full = join(dir, e.name);
        const st = await stat(full).catch(() => null);
        if (st) out.push({ path: full, rel: relative(root, full).replace(/\\/g, '/'), size: st.size });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2/5 — Métricas coletadas. Apenas dados verificáveis.
// ─────────────────────────────────────────────────────────────────────────────

async function collectVitals(root) {
  const modules = await listSrcModules(root);
  const stats = { fileCount: modules.length, totalBytes: modules.reduce((a, m) => a + m.size, 0) };
  const perf = await analyzeProjectPerformance({ dataDir: join(root, '.genesis') }).catch(() => null);
  return { modules, stats, perf };
}

async function readKb(root) {
  const path = join(root, 'GENESIS_KNOWLEDGE_BASE.md');
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3/5 — Renderização de seções auto-atualizadas.
// ─────────────────────────────────────────────────────────────────────────────

function moduleTable(modules) {
  const lines = [];
  lines.push('| Módulo | Caminho relativo | Bytes |');
  lines.push('|---|---|---|');
  // Ordena por caminho para saída estável
  const sorted = [...modules].sort((a, b) => a.rel.localeCompare(b.rel));
  for (const m of sorted) lines.push(`| \`${m.rel.split('/').pop().replace(/\.js$/, '')}\` | \`${m.rel}\` | ${m.size.toLocaleString('pt-BR')} |`);
  return lines.join('\n');
}

function perfBlock(perf) {
  if (!perf) return '_Sem dados de telemetria._';
  return [
    `- Eventos totais: ${perf.events.total}`,
    `- Taxa de erro: ${(perf.events.errorRate * 100).toFixed(2)}%`,
    `- Fallbacks: ${perf.events.fallbacks} | recuperações: ${perf.events.recoveries}`,
    `- Heap JS atual: RSS=${perf.memory.rss} MB · heap=${perf.memory.heapUsed}/${perf.memory.heapTotal} MB`
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 4/5 — Atualização in-place das seções automáticas.
// Marcamos com marcadores únicos (<!-- GENESIS:SECTION:id -->) que
// garantem que não pisamos o trabalho manual do autor.
// ─────────────────────────────────────────────────────────────────────────────

const MARKERS = {
  modules: ['<!-- GENESIS:SECTION:modules:start -->', '<!-- GENESIS:SECTION:modules:end -->'],
  perf:    ['<!-- GENESIS:SECTION:perf:start -->', '<!-- GENESIS:SECTION:perf:end -->'],
  stats:   ['<!-- GENESIS:SECTION:stats:start -->', '<!-- GENESIS:SECTION:stats:end -->']
};

function replaceSection(text, key, newContent) {
  const [start, end] = MARKERS[key];
  const startIdx = text.indexOf(start);
  const endIdx = text.indexOf(end);
  if (startIdx < 0 || endIdx < 0) return text; // não toca se marcador ausente
  const before = text.slice(0, startIdx + start.length);
  const after = text.slice(endIdx);
  return `${before}\n${newContent}\n${after}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 5/5 — Função de sync. Idempotente — pode ser chamada após cada release.
// ─────────────────────────────────────────────────────────────────────────────

export async function syncKnowledgeBase(root) {
  const original = await readKb(root);
  if (!original) return { updated: false, reason: 'GENESIS_KNOWLEDGE_BASE.md não existe ainda.' };
  const { modules, stats, perf } = await collectVitals(root);
  const sectionModules = moduleTable(modules);
  const sectionPerf = perfBlock(perf);
  const sectionStats = `- fileCount total de \`.js\`: **${stats.fileCount}**\n- bytes acumulados: **${stats.totalBytes.toLocaleString('pt-BR')}**`;
  let updated = original;
  updated = replaceSection(updated, 'modules', sectionModules);
  updated = replaceSection(updated, 'perf', sectionPerf);
  updated = replaceSection(updated, 'stats', sectionStats);
  const changed = updated !== original;
  if (changed) await writeFile(join(root, 'GENESIS_KNOWLEDGE_BASE.md'), updated);
  return { updated: changed, changed };
}
