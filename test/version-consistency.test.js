import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('runtime usa package.json como fonte canônica e assets não duplicam versão em cache keys', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const config = await import('../src/config.js');
  const server = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.equal(config.GENESIS_VERSION, packageJson.version);
  assert.doesNotMatch(server, /const\s+VERSION\s*=\s*['"]/);
  assert.doesNotMatch(html, /[?&]v=\d+\.\d+\.\d+/);
  assert.match(html, /id="genesisVersion"/);
});
