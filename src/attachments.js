import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MIB = 1024 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.html', '.css', '.scss', '.sql',
  '.sh', '.ps1', '.bat', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.go', '.rs', '.php',
  '.rb', '.swift', '.kt', '.kts', '.toml', '.ini', '.env'
]);

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 5,
  maxFileBytes: 8 * MIB,
  maxTotalBytes: 16 * MIB,
  maxHydratedTextCharacters: 120000
});

function attachmentError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function safeSegment(value, label) {
  const segment = String(value || '');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(segment)) throw attachmentError(`${label} inválido.`, 'invalid_attachment_path');
  return segment;
}

export function sanitizeAttachmentName(value) {
  const name = String(value || 'arquivo')
    .normalize('NFKC')
    .replace(/[\\/\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return name && !['.', '..'].includes(name) ? name : 'arquivo';
}

function classifyAttachment(name, declaredMime) {
  const mime = String(declaredMime || '').toLowerCase().split(';')[0].trim();
  const extension = path.extname(name).toLowerCase();
  if (IMAGE_MIMES.has(mime)) return { kind: 'image', mimeType: mime, extension };
  if (mime === 'application/pdf' || extension === '.pdf') return { kind: 'pdf', mimeType: 'application/pdf', extension: '.pdf' };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', mimeType: 'text/plain', extension };
  throw attachmentError('Formato não suportado. Use imagens, PDF, texto ou arquivos de código.', 'attachment_type_not_supported', 415);
}

function decodeDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+);base64,([a-zA-Z0-9+/]*={0,2})$/);
  if (!match) throw attachmentError('Conteúdo do anexo inválido.', 'invalid_attachment_data');
  const encoded = match[2];
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw attachmentError('Conteúdo do anexo inválido.', 'invalid_attachment_data');
  }
  return buffer;
}

function hasMagic(buffer, expected) {
  return buffer.subarray(0, expected.length).equals(Buffer.from(expected));
}

function validateContent(kind, mimeType, buffer) {
  if (kind === 'pdf' && !hasMagic(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw attachmentError('O arquivo informado não é um PDF válido.', 'invalid_pdf');
  }
  if (kind === 'image') {
    const valid = mimeType === 'image/png'
      ? hasMagic(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : mimeType === 'image/jpeg'
        ? hasMagic(buffer, [0xff, 0xd8, 0xff])
        : mimeType === 'image/gif'
          ? ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
          : buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) throw attachmentError('A imagem não corresponde ao formato informado.', 'invalid_image');
  }
  if (kind === 'text') {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    let controls = 0;
    for (const byte of sample) if (byte < 32 && ![9, 10, 13].includes(byte)) controls += 1;
    if (sample.includes(0) || controls > Math.max(2, sample.length * 0.01)) {
      throw attachmentError('O arquivo de texto contém dados binários não suportados.', 'invalid_text_file');
    }
  }
}

export class AttachmentStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'uploads');
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    return this;
  }

  conversationDirectory(conversationId) {
    return path.join(this.root, safeSegment(conversationId, 'Conversa'));
  }

  filePath(conversationId, attachmentId) {
    return path.join(this.conversationDirectory(conversationId), safeSegment(attachmentId, 'Anexo'));
  }

  async saveMany(conversationId, payloads = []) {
    if (!Array.isArray(payloads)) throw attachmentError('Lista de anexos inválida.', 'invalid_attachments');
    if (payloads.length > ATTACHMENT_LIMITS.maxFiles) {
      throw attachmentError(`Envie no máximo ${ATTACHMENT_LIMITS.maxFiles} arquivos por mensagem.`, 'too_many_attachments', 413);
    }
    if (!payloads.length) return [];

    const directory = this.conversationDirectory(conversationId);
    await fs.mkdir(directory, { recursive: true });
    const saved = [];
    let totalBytes = 0;
    try {
      for (const payload of payloads) {
        const name = sanitizeAttachmentName(payload?.name);
        const classification = classifyAttachment(name, payload?.mimeType);
        const buffer = decodeDataUrl(payload?.dataUrl);
        if (buffer.length > ATTACHMENT_LIMITS.maxFileBytes) {
          throw attachmentError(`“${name}” excede o limite de 8 MB.`, 'attachment_too_large', 413);
        }
        totalBytes += buffer.length;
        if (totalBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
          throw attachmentError('Os anexos excedem o limite total de 16 MB.', 'attachments_too_large', 413);
        }
        validateContent(classification.kind, classification.mimeType, buffer);
        const id = crypto.randomUUID();
        await fs.writeFile(this.filePath(conversationId, id), buffer, { mode: 0o600, flag: 'wx' });
        saved.push({
          id,
          name,
          mimeType: classification.mimeType,
          kind: classification.kind,
          size: buffer.length,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex')
        });
      }
      return saved;
    } catch (error) {
      await this.removeMany(conversationId, saved.map(item => item.id));
      throw error;
    }
  }

  async read(conversationId, attachmentId) {
    return fs.readFile(this.filePath(conversationId, attachmentId));
  }

  async hydrateConversation(conversation, options = {}) {
    const hydrated = structuredClone(conversation);
    const recentMessages = Math.max(1, Number(options.recentMessages || 12));
    const start = Math.max(0, hydrated.messages.length - recentMessages);
    for (let index = start; index < hydrated.messages.length; index += 1) {
      const message = hydrated.messages[index];
      if (!Array.isArray(message.attachments) || !message.attachments.length) continue;
      message.attachments = await Promise.all(message.attachments.map(async attachment => {
        const buffer = await this.read(hydrated.id, attachment.id);
        if (crypto.createHash('sha256').update(buffer).digest('hex') !== attachment.sha256) {
          throw attachmentError('A integridade de um anexo local foi comprometida.', 'attachment_integrity_failed', 409);
        }
        if (attachment.kind === 'text') {
          const fullText = buffer.toString('utf8').replace(/^\uFEFF/, '');
          return {
            ...attachment,
            text: fullText.slice(0, ATTACHMENT_LIMITS.maxHydratedTextCharacters),
            truncated: fullText.length > ATTACHMENT_LIMITS.maxHydratedTextCharacters
          };
        }
        return { ...attachment, dataUrl: `data:${attachment.mimeType};base64,${buffer.toString('base64')}` };
      }));
    }
    return hydrated;
  }

  async removeMany(conversationId, attachmentIds = []) {
    await Promise.all(attachmentIds.map(id => fs.rm(this.filePath(conversationId, id), { force: true })));
  }

  async deleteConversation(conversationId) {
    await fs.rm(this.conversationDirectory(conversationId), { recursive: true, force: true });
  }
}
