import fs from 'node:fs/promises';
import path from 'node:path';

const now = () => new Date().toISOString();

function emptyState(enabled = true) {
  return {
    schemaVersion: 1,
    enabled,
    messagesObserved: 0,
    signals: { concise: 0, detailed: 0, professional: 0, validation: 0, freeOnly: 0, windows: 0, code: 0 },
    updatedAt: null
  };
}

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export class UserMemoryStore {
  constructor(dataDir, supremeMind = null) {
    this.file = path.join(dataDir, 'user-memory.json');
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
    this.supremeMind = supremeMind;
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed?.schemaVersion === 1) this.state = { ...emptyState(parsed.enabled !== false), ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this;
  }

  persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    return this.writeQueue;
  }

  async observe(value) {
    if (!this.state.enabled) return;
    const text = normalized(value).slice(0, 20000);
    if (!text) return;
    const patterns = {
      concise: /\b(curto|resumido|direto|objetivo|sem enrolacao)\b/,
      detailed: /\b(detalhado|detalhe|explique|aprofund|completo)\b/,
      professional: /\b(profissional|preciso|cauteloso|funcional)\b/,
      validation: /\b(teste|testes|valide|verifique|sem erros|sem crash)\b/,
      freeOnly: /\b(gratis|gratuito|free|sem custo)\b/,
      windows: /\b(windows|powershell|desktop)\b/,
      code: /\b(codigo|projeto|git|github|api|backend|frontend|node|javascript|css|html)\b/
    };
    for (const [signal, pattern] of Object.entries(patterns)) {
      if (pattern.test(text)) this.state.signals[signal] = Math.min(99, Number(this.state.signals[signal] || 0) + 1);
    }
    this.state.messagesObserved += 1;
    this.state.updatedAt = now();
    await this.persist();
  }

  summary() {
    if (!this.state.enabled) return [];
    const signals = this.state.signals;
    const items = [];
    if (signals.professional >= 2) items.push('Tom profissional, preciso e cauteloso');
    if (signals.concise > signals.detailed && signals.concise >= 2) items.push('Respostas diretas e compactas');
    if (signals.detailed >= signals.concise && signals.detailed >= 2) items.push('Explicações completas quando úteis');
    if (signals.validation >= 2) items.push('Validar mudanças e evitar regressões');
    if (signals.freeOnly >= 2) items.push('Priorizar soluções gratuitas');
    if (signals.windows >= 2) items.push('Ambiente principal Windows');
    if (signals.code >= 2) items.push('Foco recorrente em desenvolvimento de software');
    return items.slice(0, 6);
  }

  async context(query = '') {
    const summary = this.summary();
    let parts = [];
    if (summary.length) {
      parts.push(`PREFERÊNCIAS ADAPTATIVAS LOCAIS — inferências não sensíveis; aplique somente quando forem relevantes e nunca invente fatos sobre o usuário:\n- ${summary.join('\n- ')}`);
    }
    
    // Incluir memórias do SupremeMind se disponível
    const smMemories = await this.getSupremeMindMemories(query, 3);
    if (smMemories.length > 0) {
      const memText = smMemories.map(m => `- [${m.title}] ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''} (arquivos: ${m.files?.join(', ') || 'nenhum'})`).join('\n');
      parts.push(`MEMÓRIAS DE PROJETO (SupremeMind) — decisões e descobertas registradas:\n${memText}`);
    }
    
    return parts.join('\n\n');
  }

  async getSupremeMindMemories(query = '', limit = 5) {
    if (!this.supremeMind) return [];
    try {
      const sm = this.supremeMind;
      if (!sm.isIndexed()) {
        try {
          await sm.loadIndex();
        } catch {
          return [];
        }
      }
      return await sm.listMemories(query, limit);
    } catch {
      return [];
    }
  }

  publicState() {
    return {
      enabled: this.state.enabled,
      messagesObserved: this.state.messagesObserved,
      summary: this.summary(),
      updatedAt: this.state.updatedAt
    };
  }

  async setEnabled(enabled) {
    this.state.enabled = enabled === true;
    this.state.updatedAt = now();
    await this.persist();
    return this.publicState();
  }

  async clear() {
    const enabled = this.state.enabled;
    this.state = emptyState(enabled);
    await this.persist();
    return this.publicState();
  }
}
