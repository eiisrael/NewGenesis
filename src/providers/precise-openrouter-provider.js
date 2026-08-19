import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { ResilientOpenRouterProvider } from './resilient-openrouter-provider.js';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

function taskFingerprint(messages) {
  const dialogue = messages.filter(message => ['user', 'assistant'].includes(message.role));
  const latestUserIndex = dialogue.map(message => message.role).lastIndexOf('user');
  const latestUser = latestUserIndex >= 0 ? textContent(dialogue[latestUserIndex].content) : '';
  const previous = latestUserIndex > 0 ? textContent(dialogue[latestUserIndex - 1].content) : '';
  return `${latestUser.slice(0, 4000)}\nPREVIOUS:${previous.slice(-2000)}`;
}

function wait(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error('Solicitação interrompida pelo usuário.'), {
        code: 'request_cancelled', category: 'cancelled'
      }));
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export class PreciseOpenRouterProvider extends ResilientOpenRouterProvider {
  constructor(options) {
    super(options);
    this.activeTaskFingerprints = new Map();
  }

  setApiKey(value) {
    super.setApiKey(value);
    this.activeTaskFingerprints?.clear();
  }

  markSuccess(value = {}) {
    if (value.model) return super.markSuccess(value);
    return OpenAICompatibleProvider.prototype.markSuccess.call(this, value);
  }

  sessionState(sessionId, messages = []) {
    const state = ResilientOpenRouterProvider.prototype.sessionState.call(this, sessionId, messages);
    const key = String(sessionId || 'default');
    const fingerprint = this.activeTaskFingerprints.get(key);
    if (fingerprint && state.taskFingerprint !== fingerprint) {
      state.taskFingerprint = fingerprint;
      state.completed.clear();
      state.journal = [];
      state.mutations = 0;
      state.updatedAt = Date.now();
    }
    return state;
  }

  async requestWithRetry(input, attempts) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await OpenAICompatibleProvider.prototype.generate.call(this, input);
      } catch (error) {
        if (input.signal?.aborted || error?.code === 'request_cancelled') throw error;
        lastError = error;
        const category = error?.category || 'unknown';
        const retryableCategory = ['timeout', 'availability', 'unknown'].includes(category)
          || (category === 'quota' && input.candidate.model === 'openrouter/free');
        if (error?.retryable === false || !retryableCategory || attempt === attempts - 1) break;
        await wait(attempt === 0 ? 300 : 800, input.signal);
      }
    }
    throw lastError;
  }

  async generate(input) {
    const key = String(input.sessionId || 'default');
    this.activeTaskFingerprints.set(key, taskFingerprint(input.messages));
    try {
      return await super.generate(input);
    } finally {
      this.activeTaskFingerprints.delete(key);
    }
  }
}
