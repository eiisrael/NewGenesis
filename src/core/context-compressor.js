// Genesis — Context Compression Engine
// Reduz tokens sem perda relevante usando três técnicas já presentes
// no ContextEngine (compactText, ledger, buildContinuityLedger).
// Esta camada adiciona:
//   1) compressão progressiva por orçamento (mantém apenas o que faz diferença);
//   2) compressão semântica (resume por sentenças-chave);
//   3) diff-resumo incremental entre mensagens consecutivas similares.

import { buildContinuityLedger, estimateTokens, estimateMessageTokens } from './context-engine.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 1/4 — Estratégias reutilizáveis.
// ─────────────────────────────────────────────────────────────────────────────

function headTail(text, max) {
  if (text.length <= max) return text;
  const head = Math.round(max * 0.72);
  const tail = max - head;
  // Preserva início (definições) e fim (conclusão) sem duplicar o meio.
  return `${text.slice(0, head)}\n\n[… conteúdo compactado pelo Genesis …]\n\n${text.slice(-tail)}`;
}

// Compactação semântica simplificada: extrai sentenças que carregam palavras
// importantes (substantivos,动词) e descarta as que só parecem "recheio". Não há
// modelo no loop — heurístico determinístico para zero latência.
const FILLER_REGEX = /\b(?:bom|okay|talvez|apenas|basicamente|na verdade|de fato|é que|isso é|pois é|claro|certo)\b/gi;
function semanticCompact(text, max) {
  if (text.length <= max) return text;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const ranked = sentences.map((s, i) => ({
    idx: i,
    text: s,
    weight: s.length - (s.match(FILLER_REGEX)?.[0]?.length || 0)
  })).sort((a, b) => b.weight - a.weight);
  // Mantém as 40 % mais densas
  const keep = new Set(ranked.slice(0, Math.max(3, Math.ceil(ranked.length * 0.4))).map(r => r.idx));
  return sentences.filter((_, i) => keep.has(i)).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 2/4 — Diferença semântica entre mensagens consecutivas.
// Quando duas mensagens seguidas têm overlap > 70 % só mantemos a mais nova.
// ─────────────────────────────────────────────────────────────────────────────

function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().match(/\w+/g) || []);
  const setB = new Set(b.toLowerCase().match(/\w+/g) || []);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter += 1;
  return inter / Math.max(setA.size, setB.size);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 3/4 — Compressão por blocos respeitando um orçamento total.
// ─────────────────────────────────────────────────────────────────────────────

export function compressConversation(messages, { budgetTokens = 1500, mode = 'mixed' } = {}) {
  const out = [];
  let used = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    const next = messages[i + 1];
    if (next && m.role === next.role) {
      const sim = jaccard(m.content, next.content);
      if (sim >= 0.7) {
        // Une mensagens duplicadas — preserva apenas a mais nova mais a
        // metainformação da anterior como referência.
        out.push({ ...next, content: `[contexto anterior mesclado] ${next.content}` });
        i += 1;
        used += estimateMessageTokens(next);
        continue;
      }
    }
    const est = estimateMessageTokens(m);
    if (used + est > budgetTokens) {
      // Compacta com head/tail + optionally semântica
      const leftover = budgetTokens - used;
      if (leftover <= 80) break;
      const charBudget = leftover * 4;
      const src = m.content || '';
      const compact = mode === 'semantic' ? semanticCompact(src, charBudget) : headTail(src, charBudget);
      out.push({ ...m, content: compact });
      used += leftover;
      continue;
    }
    out.push(m);
    used += est;
  }
  return { messages: out, usedTokens: used };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco 4/4 — Resumo contínuo (reusa CONTINUITY LEDGER do context-engine).
// ─────────────────────────────────────────────────────────────────────────────

export function compressToContinuityLedger(messages, maxTokens = 1500) {
  return buildContinuityLedger(messages, maxTokens);
}
