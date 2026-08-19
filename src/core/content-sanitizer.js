const DATA_URI = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^,\s]*)?;base64,([a-z0-9+/_=-]{256,})/gi;
const OPAQUE_BASE64 = /(?<![a-z0-9+/_=-])([a-z0-9+/_=-]{1024,})(?![a-z0-9+/_=-])/gi;

function compactLongLine(line, limit) {
  if (line.length <= limit) return line;
  const head = Math.max(240, Math.floor(limit * 0.7));
  const tail = Math.max(120, limit - head);
  return `${line.slice(0, head)}\n[… linha de ${line.length.toLocaleString('pt-BR')} caracteres compactada …]\n${line.slice(-tail)}`;
}

export function sanitizeModelText(value, options = {}) {
  const maxLineCharacters = Math.max(800, Number(options.maxLineCharacters || 4_000));
  const maxCharacters = Number.isFinite(Number(options.maxCharacters))
    ? Math.max(500, Number(options.maxCharacters))
    : Infinity;
  let removedOpaqueCharacters = 0;
  let dataUriCount = 0;

  let text = String(value || '').replace(DATA_URI, (_match, mimeType, encoded) => {
    dataUriCount += 1;
    removedOpaqueCharacters += encoded.length;
    return `[data URI ${mimeType}; ${encoded.length.toLocaleString('pt-BR')} caracteres base64 omitidos localmente]`;
  });
  text = text.replace(OPAQUE_BASE64, match => {
    removedOpaqueCharacters += match.length;
    return `[bloco base64/opaco; ${match.length.toLocaleString('pt-BR')} caracteres omitidos localmente]`;
  });
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
    changed: removedOpaqueCharacters > 0 || truncated,
    truncated,
    dataUriCount,
    removedOpaqueCharacters
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
