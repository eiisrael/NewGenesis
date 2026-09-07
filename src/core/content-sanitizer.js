const DATA_URI = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^,\s]*)?;base64,([a-z0-9+/_=-]{256,})/gi;
const OPAQUE_BASE64 = /(?<![a-z0-9+/_=-])([a-z0-9+/_=-]{1024,})(?![a-z0-9+/_=-])/gi;

function compactLongLine(line, limit) {
  if (line.length <= limit) return line;
  const head = Math.max(240, Math.floor(limit * 0.7));
  const tail = Math.max(120, limit - head);
  return `${line.slice(0, head)}\n[… linha de ${line.length.toLocaleString('pt-BR')} caracteres compactada …]\n${line.slice(-tail)}`;
}

function scrubOpaqueText(value, stats) {
  let text = String(value || '').replace(DATA_URI, (_match, mimeType, encoded) => {
    stats.dataUriCount += 1;
    stats.removedOpaqueCharacters += encoded.length;
    return `[data URI ${mimeType}; ${encoded.length.toLocaleString('pt-BR')} caracteres base64 omitidos localmente]`;
  });
  text = text.replace(OPAQUE_BASE64, match => {
    stats.removedOpaqueCharacters += match.length;
    return `[bloco base64/opaco; ${match.length.toLocaleString('pt-BR')} caracteres omitidos localmente]`;
  });
  return text;
}

function scrubJsonValue(value, stats, depth = 0) {
  if (depth > 12) return '[estrutura profunda omitida localmente]';
  if (typeof value === 'string') return scrubOpaqueText(value, stats);
  if (Array.isArray(value)) return value.map(item => scrubJsonValue(item, stats, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubJsonValue(item, stats, depth + 1)]));
  }
  return value;
}

function compactJsonValue(value, { stringLimit, arrayLimit, objectLimit }, depth = 0) {
  if (depth > 10) return '[estrutura profunda compactada]';
  if (typeof value === 'string') {
    if (value.length <= stringLimit) return value;
    const marker = `[… ${value.length.toLocaleString('pt-BR')} caracteres compactados …]`;
    const available = Math.max(0, stringLimit - marker.length - 2);
    const head = Math.floor(available * 0.72);
    const tail = available - head;
    return `${value.slice(0, head)}\n${marker}\n${tail ? value.slice(-tail) : ''}`;
  }
  if (Array.isArray(value)) {
    const selected = value.slice(0, arrayLimit).map(item => compactJsonValue(item, { stringLimit, arrayLimit, objectLimit }, depth + 1));
    if (value.length > arrayLimit) selected.push(`[... ${value.length - arrayLimit} item(ns) omitido(s) ...]`);
    return selected;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const selected = entries.slice(0, objectLimit).map(([key, item]) => [key, compactJsonValue(item, { stringLimit, arrayLimit, objectLimit }, depth + 1)]);
    if (entries.length > objectLimit) selected.push(['__genesis_omitted_keys__', entries.length - objectLimit]);
    return Object.fromEntries(selected);
  }
  return value;
}

function sanitizeJsonText(source, maxCharacters, stats) {
  let parsed;
  try { parsed = JSON.parse(source); } catch { return null; }
  const scrubbed = scrubJsonValue(parsed, stats);
  const full = JSON.stringify(scrubbed);
  if (!Number.isFinite(maxCharacters) || full.length <= maxCharacters) {
    return { text: full, truncated: false, changed: full !== source || stats.removedOpaqueCharacters > 0 };
  }

  const attempts = [
    { stringLimit: Math.max(800, Math.min(6_000, Math.floor(maxCharacters * 0.55))), arrayLimit: 20, objectLimit: 60 },
    { stringLimit: Math.max(600, Math.min(3_500, Math.floor(maxCharacters * 0.38))), arrayLimit: 12, objectLimit: 40 },
    { stringLimit: Math.max(400, Math.min(2_000, Math.floor(maxCharacters * 0.25))), arrayLimit: 8, objectLimit: 28 },
    { stringLimit: Math.max(250, Math.min(1_000, Math.floor(maxCharacters * 0.16))), arrayLimit: 5, objectLimit: 20 },
    { stringLimit: 180, arrayLimit: 3, objectLimit: 14 }
  ];
  for (const limits of attempts) {
    const text = JSON.stringify(compactJsonValue(scrubbed, limits));
    if (text.length <= maxCharacters) return { text, truncated: true, changed: true };
  }

  const fallback = JSON.stringify({
    truncated: true,
    summary: 'Resultado JSON compactado pelo orçamento local do Genesis; os dados completos permanecem somente no runtime local.'
  });
  return { text: fallback.slice(0, maxCharacters), truncated: true, changed: true };
}

export function sanitizeModelText(value, options = {}) {
  const maxLineCharacters = Math.max(800, Number(options.maxLineCharacters || 4_000));
  const maxCharacters = Number.isFinite(Number(options.maxCharacters))
    ? Math.max(500, Number(options.maxCharacters))
    : Infinity;
  const stats = { removedOpaqueCharacters: 0, dataUriCount: 0 };
  const source = String(value || '');

  const json = sanitizeJsonText(source, maxCharacters, stats);
  if (json) {
    return {
      text: json.text,
      changed: json.changed,
      truncated: json.truncated,
      dataUriCount: stats.dataUriCount,
      removedOpaqueCharacters: stats.removedOpaqueCharacters
    };
  }

  let text = scrubOpaqueText(source, stats);
  text = text.split(/\r?\n/).map(line => compactLongLine(line, maxLineCharacters)).join('\n');

  let truncated = false;
  if (text.length > maxCharacters) {
    const marker = '\n\n[… conteúdo limitado pelo orçamento local do Genesis …]\n\n';
    const available = Math.max(0, maxCharacters - marker.length);
    const head = Math.floor(available * 0.72);
    const tail = available - head;
    text = `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ''}`;
    truncated = true;
  }

  return {
    text,
    changed: stats.removedOpaqueCharacters > 0 || truncated,
    truncated,
    dataUriCount: stats.dataUriCount,
    removedOpaqueCharacters: stats.removedOpaqueCharacters
  };
}

export function opaqueTokenEstimate(value) {
  const text = String(value || '');
  if (!text) return 0;
  let opaqueCharacters = 0;
  for (const match of text.matchAll(DATA_URI)) opaqueCharacters += match[2]?.length || 0;
  for (const match of text.matchAll(OPAQUE_BASE64)) opaqueCharacters += match[1]?.length || 0;
  return Math.ceil(opaqueCharacters / 1.25);
}
