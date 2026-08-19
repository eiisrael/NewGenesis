import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const PERMISSION_MODES = Object.freeze({
  ask: {
    id: 'ask',
    label: 'Solicitar Permissão',
    description: 'O Gênesis pede aprovação antes de alterar arquivos ou executar verificações.'
  },
  full: {
    id: 'full',
    label: 'Permissão Completa',
    description: 'O Gênesis pode editar automaticamente, sempre limitado à pasta do projeto ativo.'
  }
});

function normalizeMode(value) {
  return value === 'full' ? 'full' : 'ask';
}

export class PermissionStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'permissions.json');
    this.mode = 'ask';
    this.writeQueue = Promise.resolve();
  }

  async init() {
    try {
      const payload = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.mode = normalizeMode(payload?.mode);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this;
  }

  publicState() {
    return {
      mode: this.mode,
      options: Object.values(PERMISSION_MODES),
      scope: 'Somente a pasta do projeto ativo'
    };
  }

  async setMode(value) {
    this.mode = normalizeMode(value);
    await this.persist();
    return this.publicState();
  }

  persist() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify({ schemaVersion: 1, mode: this.mode }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    return this.writeQueue;
  }
}

function cancelledError() {
  return Object.assign(new Error('Solicitação interrompida pelo usuário.'), {
    code: 'request_cancelled',
    category: 'cancelled'
  });
}

export class ApprovalManager {
  constructor({ timeoutMs = 5 * 60 * 1000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  request({ conversationId, operation, signal }) {
    if (signal?.aborted) throw cancelledError();
    const id = crypto.randomUUID();
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const cleanup = () => {
      const item = this.pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      signal?.removeEventListener('abort', item.abort);
      this.pending.delete(id);
    };
    const abort = () => {
      cleanup();
      settle.reject(cancelledError());
    };
    const timer = setTimeout(() => {
      cleanup();
      settle.resolve('deny');
    }, this.timeoutMs);
    this.pending.set(id, { id, conversationId, operation, timer, abort, signal, ...settle });
    signal?.addEventListener('abort', abort, { once: true });
    return { id, promise };
  }

  decide(id, decision) {
    const item = this.pending.get(String(id || ''));
    if (!item) return null;
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.abort);
    this.pending.delete(item.id);
    item.resolve(decision === 'approve' ? 'approve' : 'deny');
    return { id: item.id, conversationId: item.conversationId, decision: decision === 'approve' ? 'approve' : 'deny' };
  }

  cancelConversation(conversationId) {
    for (const item of [...this.pending.values()]) {
      if (item.conversationId !== conversationId) continue;
      clearTimeout(item.timer);
      item.signal?.removeEventListener('abort', item.abort);
      this.pending.delete(item.id);
      item.reject(cancelledError());
    }
  }
}
