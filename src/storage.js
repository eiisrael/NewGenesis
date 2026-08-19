import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const now = () => new Date().toISOString();
const clone = value => structuredClone(value);

function titleFrom(content) {
  const clean = String(content || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Nova conversa';
  return clean.length > 54 ? `${clean.slice(0, 53).trim()}…` : clean;
}

function emptyState() {
  return { schemaVersion: 1, conversations: [] };
}

function storedAttachments(values) {
  if (!Array.isArray(values)) return [];
  return values.map(value => ({
    id: String(value.id || ''),
    name: String(value.name || 'arquivo'),
    mimeType: String(value.mimeType || 'application/octet-stream'),
    kind: String(value.kind || 'file'),
    size: Number(value.size || 0),
    sha256: String(value.sha256 || '')
  })).filter(value => value.id && value.sha256);
}

function measuredRequestCount(meta = {}) {
  const explicit = Number(meta.usage?.requestCount);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);
  return meta.providerId === 'genesis-local' ? 0 : 1;
}

function recomputeConversationStats(conversation) {
  const stats = {
    inputTokens: 0,
    outputTokens: 0,
    savedTokens: 0,
    providerSwitches: 0,
    requests: 0
  };
  let previousProviderId = null;
  const records = Array.isArray(conversation.usageRecords) && conversation.usageRecords.length
    ? conversation.usageRecords
    : conversation.messages.filter(message => message.role === 'assistant' && message.meta).map(message => message.meta);
  for (const record of records) {
    const providerId = record.providerId || null;
    stats.inputTokens += record.usage?.inputTokens || record.context?.estimatedTokens || 0;
    stats.outputTokens += record.usage?.outputTokens || 0;
    stats.savedTokens += record.context?.savedTokens || 0;
    stats.requests += measuredRequestCount(record);
    if (previousProviderId && providerId && previousProviderId !== providerId) stats.providerSwitches += 1;
    if (providerId) previousProviderId = providerId;
  }
  conversation.lastProviderId = previousProviderId;
  conversation.stats = stats;
}

export class GenesisStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.conversations)) {
        this.state = parsed;
        for (const conversation of this.state.conversations) {
          if (!Array.isArray(conversation.usageRecords)) {
            conversation.usageRecords = conversation.messages
              .filter(message => message.role === 'assistant' && message.meta)
              .map(message => ({ ...message.meta, id: message.id, recordedAt: message.createdAt }));
          }
          recomputeConversationStats(conversation);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this;
  }

  persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    return this.writeQueue;
  }

  listConversations() {
    return this.state.conversations
      .map(({ messages, usageRecords, ...conversation }) => ({ ...conversation, messageCount: messages.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getConversation(id) {
    const conversation = this.state.conversations.find(item => item.id === id);
    return conversation ? clone(conversation) : null;
  }

  async createConversation(options = {}) {
    const timestamp = now();
    const conversation = {
      id: crypto.randomUUID(),
      title: options.title || 'Nova conversa',
      customTitle: false,
      markerColor: 'violet',
      mode: options.mode || 'balanced',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastProviderId: null,
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        savedTokens: 0,
        providerSwitches: 0,
        requests: 0
      },
      usageRecords: [],
      messages: []
    };
    this.state.conversations.push(conversation);
    await this.persist();
    return clone(conversation);
  }

  async addMessage(conversationId, message) {
    const conversation = this.state.conversations.find(item => item.id === conversationId);
    if (!conversation) return null;
    const value = {
      id: crypto.randomUUID(),
      role: message.role,
      content: String(message.content || ''),
      createdAt: now(),
      attachments: storedAttachments(message.attachments),
      meta: message.meta || null
    };
    conversation.messages.push(value);
    conversation.updatedAt = value.createdAt;
    if (conversation.messages.length === 1 && !conversation.customTitle && conversation.title === 'Nova conversa') {
      conversation.title = titleFrom(value.content || value.attachments[0]?.name);
    }
    if (message.mode) conversation.mode = message.mode;
    await this.persist();
    return clone(value);
  }

  async editUserMessage(conversationId, messageId, message) {
    const conversation = this.state.conversations.find(item => item.id === conversationId);
    if (!conversation) return null;
    const index = conversation.messages.findIndex(item => item.id === messageId && item.role === 'user');
    if (index < 0) return null;
    const timestamp = now();
    const target = conversation.messages[index];
    const removedMessages = conversation.messages.splice(index + 1);
    target.content = String(message.content || '');
    if (message.meta) target.meta = message.meta;
    target.editedAt = timestamp;
    conversation.updatedAt = timestamp;
    if (message.mode) conversation.mode = message.mode;
    if (index === 0 && !conversation.customTitle) conversation.title = titleFrom(target.content || target.attachments[0]?.name);
    recomputeConversationStats(conversation);
    await this.persist();
    return {
      message: clone(target),
      removedAttachmentIds: removedMessages.flatMap(item => (item.attachments || []).map(attachment => attachment.id))
    };
  }

  async applyResult(conversationId, result) {
    const conversation = this.state.conversations.find(item => item.id === conversationId);
    if (!conversation) return null;
    if (!Array.isArray(conversation.usageRecords)) conversation.usageRecords = [];
    const accountingId = String(result.accountingId || result.task?.id || crypto.randomUUID());
    if (!conversation.usageRecords.some(record => record.accountingId === accountingId)) {
      conversation.usageRecords.push({
        accountingId,
        recordedAt: now(),
        providerId: result.providerId || null,
        usage: result.usage || {},
        context: { savedTokens: Number(result.context?.savedTokens || 0), estimatedTokens: Number(result.context?.estimatedTokens || 0) }
      });
    }
    recomputeConversationStats(conversation);
    await this.persist();
    return clone(conversation);
  }

  async updateConversation(conversationId, changes = {}) {
    const conversation = this.state.conversations.find(item => item.id === conversationId);
    if (!conversation) return null;
    if (typeof changes.title === 'string') {
      conversation.title = changes.title;
      conversation.customTitle = true;
    }
    if (typeof changes.markerColor === 'string') conversation.markerColor = changes.markerColor;
    conversation.updatedAt = now();
    await this.persist();
    return clone(conversation);
  }

  async deleteConversation(id) {
    const before = this.state.conversations.length;
    this.state.conversations = this.state.conversations.filter(item => item.id !== id);
    if (this.state.conversations.length === before) return false;
    await this.persist();
    return true;
  }
}
