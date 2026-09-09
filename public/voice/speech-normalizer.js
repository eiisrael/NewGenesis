const CODE_NOTICE = 'Há um bloco de código na resposta.';
const TABLE_NOTICE = 'Há uma tabela na resposta.';

export function normalizeVoiceTranscript(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/\bvoca(?:\s+a)?(?=\s+gostaria\b)/giu, 'você');
  const [first = '', ...rest] = text.split(/\s+/);
  const firstAscii = first.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/gi, '').toLowerCase();
  // Whisper occasionally joins "Olá, Gênesis" into a single phonetic token
  // (for example "Volacionesis"). Correct only this narrow greeting shape so
  // arbitrary dictated content remains untouched.
  if (/^v?ola[a-z]{0,4}nesis$/.test(firstAscii)) text = ['Olá, Gênesis', ...rest].join(' ').trim();
  text = text.replace(/^olá[, ]+g[eê]nesis\b/iu, 'Olá, Gênesis');
  text = text.replace(/^Olá, Gênesis[, ]+(?:do|tudo) bem[.!?]*$/iu, 'Olá, Gênesis, tudo bem?');
  const continuation = text.match(/^continui([.!?…]*)$/iu);
  if (!continuation) return text;
  return `Continue${continuation[1] || '.'}`;
}

export function normalizeSpokenText(value, { maxLength = 16000 } = {}) {
  let text = String(value || '').replace(/\r\n?/g, '\n');
  // Fences são filtrados por linha para distinguir blocos markdown de crases
  // inline. Se o streaming ainda não trouxe o fechamento, apenas a cauda do bloco
  // fica silenciosa; a prosa anterior e posterior a fences completos é preservada.
  text = stripFencedCode(text);
  text = text.replace(/(?:^|\n)(?:\|[^\n]+\|\n)(?:\|?\s*:?-{3,}[^\n]*\n)(?:\|[^\n]+\|(?:\n|$))+/gm, `\n${TABLE_NOTICE}\n`);
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, label) => label ? `Imagem: ${label}.` : 'Há uma imagem na resposta.');
  text = text.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, 'um link');
  text = stripRawTechnicalLines(text);
  text = text.replace(/\bpt[-_]BR\b/gi, 'português do Brasil');
  text = text.replace(/\b(?:versão\s+v?|v)(\d+)\.(\d+)\.(\d+)\b/gi, (_, major, minor, patch) => `versão ${major} ponto ${minor} ponto ${patch}`);
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
  const limit = Number.isFinite(Number(maxChunk)) ? Math.max(1, Math.floor(Number(maxChunk))) : 260;
  const boundaries = [];
  const pattern = /[.!?…]+(?:["'”’)]*)\s+|\n{2,}/g;
  let match;
  while ((match = pattern.exec(input))) {
    // A title, initial or list marker is not a completed thought. Keeping its
    // continuation also prevents artificial pauses in streamed speech.
    if (match[0].startsWith('.') && isAbbreviation(input.slice(0, match.index + 1))) continue;
    boundaries.push(match.index + match[0].length);
  }
  let consumed = boundaries.at(-1) || 0;
  if (flush) {
    consumed = input.length;
    if (boundaries.at(-1) !== consumed) boundaries.push(consumed);
  }
  if (!consumed) return { chunks: [], rest: input };

  const rest = input.slice(consumed);
  const chunks = [];
  let current = '';
  let start = 0;
  for (const end of boundaries) {
    const sentence = input.slice(start, end);
    start = end;
    const cleaned = sentence.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    for (const part of splitForSpeech(cleaned, limit)) {
      const combined = `${current} ${part}`.trim();
      if (combined.length > limit && current) {
        chunks.push(current);
        current = part;
      } else current = combined;
    }
  }
  if (current) chunks.push(current);
  return { chunks, rest };
}

function stripFencedCode(value) {
  const output = [];
  let inFence = false;
  for (const line of String(value || '').split('\n')) {
    const marker = line.match(/^\s*```/);
    if (marker) {
      if (!inFence) output.push(CODE_NOTICE);
      inFence = !inFence;
      continue;
    }
    if (!inFence) output.push(line);
  }
  return output.join('\n');
}

function stripRawTechnicalLines(value) {
  const lines = String(value || '').split('\n');
  const output = [];
  let technicalRun = false;
  let blockComment = false;
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (blockComment) {
      if (!technicalRun) output.push(CODE_NOTICE);
      technicalRun = true;
      if (trimmed.includes('*/')) blockComment = false;
      continue;
    }
    if (/^\/\*/.test(trimmed)) {
      if (!technicalRun) output.push(CODE_NOTICE);
      technicalRun = true;
      blockComment = !trimmed.includes('*/');
      continue;
    }
    if (looksLikeTechnicalLine(line)) {
      if (!technicalRun) output.push(CODE_NOTICE);
      technicalRun = true;
      continue;
    }
    technicalRun = false;
    output.push(line);
  }
  return output.join('\n');
}

function looksLikeTechnicalLine(value) {
  const line = String(value || '').trim();
  if (!line) return false;
  if (/^\/\//.test(line) || /^#!\//.test(line)) return true;
  if (/^\s*[{}\[\],]+\s*$/.test(line)) return true;
  if (/^\s*["']?(?:tool|command|arguments|result|path|content)["']?\s*:/i.test(line)) return true;
  if (/^\s*\{?.*["'](?:tool|command|arguments)["']\s*:/i.test(line)) return true;
  if (/<\/?[a-z][^>]*>/i.test(line)) return true;
  if (/\b(?:document|window|navigator|console)\.[a-z_$][\w$]*\b/i.test(line)) return true;
  if (/\b(?:querySelector|addEventListener|classList|textContent|innerHTML|createElement)\s*\(/i.test(line)) return true;
  if (/^\s*(?:const|let|var|function|class|import|export|async\s+function|return\b|if\s*\(|for\s*\(|while\s*\()/i.test(line)) return true;
  if (/=>|\{\s*$|;\s*$/.test(line) && /[=(){};]|\.[a-z_$][\w$]*\s*\(/i.test(line)) return true;
  if (/^\s*[.#][a-z0-9_-]+[^\n{]*\{/i.test(line)) return true;
  if (/^\s*[a-z-]+\s*:\s*[^;]+;\s*$/i.test(line)) return true;
  return false;
}

function isAbbreviation(value) {
  return /\b(?:sr|sra|srta|dr|dra|prof|profa|av|art|pág|págs|fig|aprox|tel)\.$/iu.test(value)
    || /\b(?:[\p{L}]\.){2,}$/u.test(value)
    || /\b[\p{Lu}]\.$/u.test(value)
    || /(?:^|\n)\s*\d+\.$/u.test(value);
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
    const splitAt = candidates.find(index => index >= Math.floor(maxChunk * 0.55) && index < maxChunk);
    const end = splitAt == null ? maxChunk : splitAt + (rest[splitAt] === ' ' ? 0 : 1);
    result.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) result.push(rest);
  return result;
}
