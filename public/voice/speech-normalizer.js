const CODE_NOTICE = 'Há um bloco de código na resposta.';
const TABLE_NOTICE = 'Há uma tabela na resposta.';

export function normalizeSpokenText(value, { maxLength = 16000 } = {}) {
  let text = String(value || '').replace(/\r\n?/g, '\n');
  text = text.replace(/```[\s\S]*?```/g, `\n${CODE_NOTICE}\n`);
  text = text.replace(/(?:^|\n)(?:\|[^\n]+\|\n)(?:\|?\s*:?-{3,}[^\n]*\n)(?:\|[^\n]+\|(?:\n|$))+/gm, `\n${TABLE_NOTICE}\n`);
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, label) => label ? `Imagem: ${label}.` : 'Há uma imagem na resposta.');
  text = text.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, 'um link');
  text = text.replace(/\bpt[-_]BR\b/gi, 'português do Brasil');
  text = text.replace(/\bv?(\d+)\.(\d+)\.(\d+)\b/g, (_, major, minor, patch) => `versão ${major} ponto ${minor} ponto ${patch}`);
  text = text.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_, day, month, year) => spokenDate(day, month, year));
  text = text.replace(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g, (_, hour, minute, second) => spokenTime(hour, minute, second));
  text = text.replace(/(-?\d+(?:[.,]\d+)?)\s*°\s*C\b/gi, '$1 graus Celsius');
  text = text.replace(/(-?\d+(?:[.,]\d+)?)\s*%/g, '$1 por cento');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '\n');
  text = text.replace(/^\s*[-*+]\s+/gm, 'Item: ');
  text = text.replace(/^\s*\d+[.)]\s+/gm, match => `${match.trim()} `);
  text = text.replace(/[*_~`]+/g, '');
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
  text = text.replace(/(^|\s)([A-ZÀ-Ý]{2,6})(?=\s|[.,;:!?]|$)/g, (_, prefix, acronym) => `${prefix}${acronym.split('').join(' ')}`);
  text = text.replace(new RegExp(`(?:${escapeRegex(CODE_NOTICE)}\\s*){2,}`, 'g'), `${CODE_NOTICE} `);
  text = text.replace(new RegExp(`(?:${escapeRegex(TABLE_NOTICE)}\\s*){2,}`, 'g'), `${TABLE_NOTICE} `);
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, Math.max(0, maxLength));
}

export function takeStableSentences(value, { flush = false, maxChunk = 260 } = {}) {
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
    for (const part of splitForSpeech(cleaned, maxChunk)) {
      const combined = `${current} ${part}`.trim();
      if (combined.length > maxChunk && current) {
        chunks.push(current);
        current = part;
      } else current = combined;
    }
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

function spokenDate(day, month, year) {
  const names = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const index = Number(month) - 1;
  if (!names[index] || Number(day) < 1 || Number(day) > 31) return `${day}/${month}/${year}`;
  return `${Number(day)} de ${names[index]} de ${year}`;
}

function spokenTime(hour, minute, second) {
  const h = Number(hour);
  const m = Number(minute);
  const s = second == null ? null : Number(second);
  if (h > 23 || m > 59 || (s != null && s > 59)) return [hour, minute, second].filter(value => value != null).join(':');
  let result = `${h} ${h === 1 ? 'hora' : 'horas'}`;
  if (m) result += ` e ${m} ${m === 1 ? 'minuto' : 'minutos'}`;
  if (s) result += ` e ${s} ${s === 1 ? 'segundo' : 'segundos'}`;
  return result;
}

function splitForSpeech(value, maxChunk) {
  if (value.length <= maxChunk) return [value];
  const result = [];
  let rest = value;
  while (rest.length > maxChunk) {
    const window = rest.slice(0, maxChunk + 1);
    const candidates = [window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(', '), window.lastIndexOf(' ')];
    const splitAt = candidates.find(index => index >= Math.floor(maxChunk * 0.55)) ?? maxChunk;
    result.push(rest.slice(0, splitAt + (rest[splitAt] === ' ' ? 0 : 1)).trim());
    rest = rest.slice(splitAt + 1).trim();
  }
  if (rest) result.push(rest);
  return result;
}
