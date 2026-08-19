// Genesis — Code Quality Engine
// Análise estática leve focada em:
//   1) duplicações (mesmo conjunto de tokens significativos);
//   2) funções grandes (acoplamento / complexidade);
//   3) padrões inconsistentes entre arquivos;
//   4) oportunidades de consolidação.

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/2 — Detecção pura de duplicação entre arquivos.
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(code) {
  return String(code || '').match(/[\wÀ-ú]{4,}/g) || [];
}

function shingles(tokens, size = 6) {
  const out = [];
  for (let i = 0; i + size <= tokens.length; i += 1) {
    out.push(tokens.slice(i, i + size).join(' '));
  }
  return out;
}

function jaccard(a, b) {
  const setA = new Set(a), setB = new Set(b);
  const inter = [...setA].filter(t => setB.has(t)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : 0;
}

export async function detectDuplicates(files, { threshold = 0.45, topN = 10 } = {}) {
  const docs = [];
  for (const file of files) {
    try {
      const text = await readFile(file, 'utf8');
      docs.push({ path: file, shingles: shingles(tokenize(text)) });
    } catch { /* arquivo ilegível: pulamos */ }
  }
  const results = [];
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const sim = jaccard(docs[i].shingles, docs[j].shingles);
      if (sim >= threshold) results.push({ a: docs[i].path, b: docs[j].path, sim });
    }
  }
  results.sort((a, b) => b.sim - a.sim);
  return results.slice(0, topN);
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecção de funções demasiado longas.
// ─────────────────────────────────────────────────────────────────────────────

const FN_PATTERNS = [
  /\bfunction\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g,
  /\b(?:async\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s+)?function\s*\([^)]*\)\s*\{/g,
  /\b(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{\s*\n/g,
  /\b(?:(?:export\s+)?(?:async\s+)?(?:public\s+|private\s+|static\s+)*function\s+([A-Za-z0-9_]+)\s*<[^>]*>\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{)/g
];

export function findLongFunctions(code, linesThreshold = 80) {
  const lines = String(code || '').split(/\r?\n/);
  const matches = [];
  for (const pattern of FN_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(code)) !== null) {
      const lineAt = code.slice(0, m.index).split(/\r?\n/).length - 1;
      // Brace-counter a partir da linha: conta profundidade de { até平衡.
      let depth = 0; let endLine = lineAt;
      for (let i = lineAt; i < lines.length; i += 1) {
        for (const ch of lines[i]) {
          if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) { endLine = i; break; }
          }
        }
        if (depth === 0) break;
      }
      const span = endLine - lineAt + 1;
      if (span >= linesThreshold) matches.push({ name: m[1], start: lineAt + 1, end: endLine + 1, lines: span });
    }
  }
  return matches.sort((a, b) => b.lines - a.lines);
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecção de inconsistências de padrão (indentação, aspas).
// ─────────────────────────────────────────────────────────────────────────────

export async function detectStyleInconsistencies(files) {
  const out = { quotes: { single: 0, double: 0, back: 0 }, indent: null };
  const samples = [];
  for (const file of files) {
    try {
      const code = await readFile(file, 'utf8');
      out.quotes.single += (code.match(/'/g) || []).length;
      out.quotes.double += (code.match(/"/g) || []).length;
      out.quotes.back += (code.match(/`/g) || []).length;
      const ind = (code.match(/^[ \t]+/gm) || []).slice(0, 20);
      samples.push({ file, ind });
    } catch { /* pula */ }
  }
  // Decide indent dominante
  let space = 0, tab = 0;
  for (const row of samples) for (const i of row.ind) {
    if (i[0] === '\t') tab += 1; else space += i.length;
  }
  out.indent = tab > space ? 'tabs' : '2 ou 4 espaços';
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecção de duplicação em arquivos locais (sintaxe leve) usando shingling.
// ─────────────────────────────────────────────────────────────────────────────

export async function scanProjectForDuplicates(projectRoot, files, { threshold = 0.5 } = {}) {
  const rels = files.map(f => relative(projectRoot, f.path));
  return detectDuplicates(rels, { threshold, topN: 50 });
}

export function summarizeDuplicatesReport(report, projectRoot) {
  if (!report.length) return 'Nenhuma duplicação significativa detectada.';
  const lines = [];
  for (const dup of report.slice(0, 8)) {
    lines.push(`• ${dup.a} ⇄ ${dup.b} (similaridade ${(dup.sim * 100).toFixed(0)}%)`);
  }
  return `Possíveis duplicações (top ${report.length}):\n${lines.join('\n')}`;
}
