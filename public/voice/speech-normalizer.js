const CODE_NOTICE = 'Há um bloco de código na resposta.';
const TABLE_NOTICE = 'Há uma tabela na resposta.';

export function normalizeSpokenText(value, { maxLength = 16000 } = {}) {
  let text = String(value || '').replace(/\r\n?/g, '\n');
  text = text.replace(/```[\s\S]*?```/g, `\n${CODE_NOTICE}\n`);
  text = text.replace(/(?:^|\n)(?:\|[^\n]+\|\n)(?:\|?\s*:?-{3,}[^\n]*\n)(?:\|[^\n]+\|(?:\n|$))+/gm, `\n${TABLE_NOTICE}\n`);
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, label) => label ? `Imagem: ${label}.` : 'Há uma imagem na resposta.');
  text = text.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, 'um link');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '\n');
  text = text.replace(/^\s*[-*+]\s+/gm, '• ');
  text = text.replace(/^\s*\d+[.)]\s+/gm, match => `${match.trim()} `);
  text = text.replace(/[*_~`]+/g, '');
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
  text = text.replace(/(^|\s)([A-ZÀ-Ý]{2,6})(?=\s|[.,;:!?]|$)/g, (_, prefix, acronym) => `${prefix}${acronym.split('').join(' ')}`);
  text = text.replace(new RegExp(`(?:${escapeRegex(CODE_NOTICE)}\\s*){2,}`, 'g'), `${CODE_NOTICE} `);
  text = text.replace(new RegExp(`(?:${escapeRegex(TABLE_NOTICE)}\\s*){2,}`, 'g'), `${TABLE_NOTICE} `);
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, Math.max(0, maxLength));
}

export function takeStableSentences(value, { flush = false, maxChunk = 420 } = {}) {
  const input = String(value || '');
  const boundaries = [];
  const pattern = /[.!?…]+(?:["'”’)]*)\s+|\n{2,}/g;
  let match;
  while ((match = pattern.exec(input))) boundaries.push(match.index + match[0].length);
  let consumed = boundaries.at(-1) || 0;
  if (flush) consumed = input.length;
  if (!consumed) return { chunks: [], rest: input };

  const stable = input.slice(0, consumed).trim();
  const rest = input.slice(consumed);
  const sentences = stable.match(/[^.!?…]+[.!?…]+["'”’)]*|[^.!?…]+$/g) || [];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const cleaned = sentence.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const combined = `${current} ${cleaned}`.trim();
    if (combined.length > maxChunk && current) {
      chunks.push(current);
      current = cleaned;
    } else current = combined;
  }
  if (current) chunks.push(current);
  return { chunks, rest };
}

export function similarityToPlayback(transcript, spokenText) {
  const words = value => new Set(normalizeSpokenText(value).toLocaleLowerCase('pt-BR').split(/\s+/).filter(word => word.length > 2));
  const heard = words(transcript);
  const spoken = words(spokenText);
  if (!heard.size || !spoken.size) return 0;
  let shared = 0;
  for (const word of heard) if (spoken.has(word)) shared += 1;
  return shared / heard.size;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
