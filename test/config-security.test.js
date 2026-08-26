import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfig, GENESIS_VERSION, isLoopbackHost } from '../src/config.js';

test('versão canônica vem do package.json', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(GENESIS_VERSION, packageJson.version);
  assert.equal(createConfig().version, packageJson.version);
});

test('bind aceita somente loopback e recusa exposição de LAN ou todas as interfaces', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-config-security-'));
  const previousHost = process.env.GENESIS_HOST;
  t.after(async () => {
    if (previousHost === undefined) delete process.env.GENESIS_HOST;
    else process.env.GENESIS_HOST = previousHost;
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const host of ['127.0.0.1', '127.0.0.2', '::1', 'localhost']) assert.equal(isLoopbackHost(host), true);
  for (const host of ['0.0.0.0', '192.168.1.20', 'genesis.example']) {
    process.env.GENESIS_HOST = host;
    assert.throws(() => createConfig(root), error => error.code === 'unsafe_remote_bind');
  }
});
