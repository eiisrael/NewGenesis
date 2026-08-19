// Keep this list assignment-oriented. Matching arbitrary words such as "secret"
// would corrupt prose, while these names denote credentials in configuration.
const SECRET_NAME = String.raw`(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|credentials?|private[_-]?key|connection[_-]?string|database[_-]?url|db[_-]?url|redis[_-]?url|mongo(?:db)?[_-]?(?:url|uri))`;
const PREFIXABLE_SECRET_NAME = String.raw`(?:${SECRET_NAME}|secret|auth|cookie)`;
const PREFIXED_SECRET_NAME = String.raw`(?:[a-z][a-z0-9]*[_\-.])+${PREFIXABLE_SECRET_NAME}`;
const SECRET_IDENTIFIER = String.raw`(?:${PREFIXED_SECRET_NAME}|${SECRET_NAME})`;
const SECRET_VALUE = String.raw`(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|\x60(?:\\.|[^\x60\r\n])*\x60|[^\s,;}\]\r\n]+)`;
const QUOTED_ASSIGNMENT = new RegExp(`(["'])(${SECRET_IDENTIFIER})\\1(\\s*[:=]\\s*)${SECRET_VALUE}`, 'gi');
const ASSIGNMENT = new RegExp(`\\b(${SECRET_IDENTIFIER})(\\s*[:=]\\s*)${SECRET_VALUE}`, 'gi');

export function redactSecrets(value) {
  return String(value ?? '')
    // Keep structured configuration readable after redaction.
    .replace(QUOTED_ASSIGNMENT, '$1$2$1$3"[REDACTED]"')
    .replace(ASSIGNMENT, '$1$2"[REDACTED]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-or-v1-|sk-|gsk_|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1[REDACTED]@');
}
