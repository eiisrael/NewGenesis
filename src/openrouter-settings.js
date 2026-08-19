import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertFreeOpenRouterModels } from './core/policy.js';

const DEFAULTS = Object.freeze({ schemaVersion: 1, selectionMode: 'automatic', selectedModel: 'openrouter/free' });

export function validateOpenRouterKey(value) {
  const key = String(value || '').trim();
  if (key.length < 20 || key.length > 512 || !key.startsWith('sk-or-') || /\s/.test(key)) {
    const error = new Error('Informe uma chave OpenRouter válida iniciada por sk-or-.');
    error.status = 400;
    error.code = 'invalid_openrouter_key';
    throw error;
  }
  return key;
}

async function atomicWrite(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o600 });
  await fs.rename(temp, file);
}

export class OpenRouterSettings {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.environmentKey = String(options.environmentKey || '').trim();
    this.preferencesFile = path.join(dataDir, 'openrouter-settings.json');
    this.vaultFile = path.join(dataDir, 'openrouter.vault');
    this.masterKeyFile = path.join(dataDir, '.vault-key');
    this.preferences = { ...DEFAULTS };
    this.key = '';
    this.persisted = false;
    this.source = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.preferencesFile, 'utf8'));
      if (parsed?.schemaVersion === 1) {
        this.preferences.selectionMode = parsed.selectionMode === 'manual' ? 'manual' : 'automatic';
        if (parsed.selectedModel) {
          assertFreeOpenRouterModels([parsed.selectedModel]);
          this.preferences.selectedModel = parsed.selectedModel;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.preferences = { ...DEFAULTS };
    }

    try {
      const encrypted = JSON.parse(await fs.readFile(this.vaultFile, 'utf8'));
      this.key = validateOpenRouterKey(await this.decrypt(encrypted));
      this.persisted = true;
      this.source = 'vault';
    } catch (error) {
      if (error.code !== 'ENOENT') await fs.rm(this.vaultFile, { force: true });
      if (this.environmentKey) {
        this.key = validateOpenRouterKey(this.environmentKey);
        this.source = 'environment';
      }
    }
    await this.persistPreferences();
    return this;
  }

  async masterKey() {
    try {
      const value = Buffer.from((await fs.readFile(this.masterKeyFile, 'utf8')).trim(), 'base64');
      if (value.length === 32) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const value = crypto.randomBytes(32);
    try {
      await fs.writeFile(this.masterKeyFile, `${value.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
      return value;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return Buffer.from((await fs.readFile(this.masterKeyFile, 'utf8')).trim(), 'base64');
    }
  }

  async encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', await this.masterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    };
  }

  async decrypt(payload) {
    if (payload?.version !== 1 || payload?.algorithm !== 'aes-256-gcm') throw new Error('Cofre local incompatível.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', await this.masterKey(), Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }

  async persistPreferences() {
    await atomicWrite(this.preferencesFile, `${JSON.stringify(this.preferences, null, 2)}\n`);
  }

  async setKey(value, { persist = false } = {}) {
    const key = validateOpenRouterKey(value);
    this.key = key;
    this.persisted = Boolean(persist);
    this.source = persist ? 'vault' : 'session';
    if (persist) {
      await atomicWrite(this.vaultFile, `${JSON.stringify(await this.encrypt(key), null, 2)}\n`);
    } else {
      await fs.rm(this.vaultFile, { force: true });
    }
  }

  async setPersistence(persist) {
    if (!this.key) {
      const error = new Error('Conecte uma chave antes de alterar a permanência.');
      error.status = 400;
      error.code = 'openrouter_not_configured';
      throw error;
    }
    await this.setKey(this.key, { persist });
  }

  async clearKey() {
    this.key = '';
    this.persisted = false;
    this.source = null;
    await fs.rm(this.vaultFile, { force: true });
  }

  async setSelection(selectionMode, selectedModel) {
    const mode = selectionMode === 'manual' ? 'manual' : 'automatic';
    const model = mode === 'manual' ? String(selectedModel || '').trim() : 'openrouter/free';
    assertFreeOpenRouterModels([model]);
    this.preferences = { schemaVersion: 1, selectionMode: mode, selectedModel: model };
    await this.persistPreferences();
  }

  publicState(account = null) {
    return {
      configured: Boolean(this.key),
      persisted: this.persisted,
      source: this.source,
      selectionMode: this.preferences.selectionMode,
      selectedModel: this.preferences.selectedModel,
      account: account ? {
        label: account.label || null,
        isFreeTier: account.isFreeTier === true,
        limit: Number.isFinite(account.limit) ? account.limit : null,
        limitRemaining: Number.isFinite(account.limitRemaining) ? account.limitRemaining : null,
        expiresAt: account.expiresAt || null
      } : null
    };
  }
}
