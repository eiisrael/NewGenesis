import test from 'node:test';
import assert from 'node:assert/strict';
import { AIHordeImageProvider } from '../src/providers/ai-horde-image-provider.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64');

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('gera imagem remota anônima com preset de qualidade sem ativar rota paga ou baixar modelo', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/status/models')) return response([{ name: 'stable_diffusion', count: 8, eta: 20 }]);
    if (url.endsWith('/generate/async')) return response({ id: 'request-12345678' }, 202);
    if (url.includes('/generate/check/')) return response({ done: true, faulted: false, is_possible: true });
    return response({ generations: [{ state: 'ok', censored: false, model: 'Stable Cascade', img: PNG }] });
  };
  const provider = new AIHordeImageProvider({ fetchImpl, pollIntervalMs: 1, generationTimeoutMs: 1000 });
  const result = await provider.generateImage({ prompt: 'Crie uma árvore futurista.' });
  const submittedCall = calls.find(call => call.url.endsWith('/generate/async'));
  const submitted = JSON.parse(submittedCall.options.body);

  assert.equal(submittedCall.options.headers.apikey, '0000000000');
  assert.equal(submitted.params.width, 768);
  assert.equal(submitted.params.height, 768);
  assert.equal(submitted.params.steps, 26);
  assert.equal(submitted.params.sampler_name, 'k_dpmpp_2m');
  assert.equal(submitted.params.karras, true);
  assert.equal(submitted.nsfw, false);
  assert.equal(submitted.trusted_workers, false);
  assert.equal(submitted.validated_backends, true);
  assert.equal(submitted.allow_downgrade, true);
  assert.deepEqual(submitted.models, ['stable_diffusion']);
  assert.equal(submitted.r2, false);
  assert.equal(result.generatedImages[0].mimeType, 'image/png');
  assert.equal(result.resolvedModel, 'Stable Cascade');
});

test('rejeita conteúdo que não seja uma imagem raster válida', async () => {
  const fetchImpl = async url => {
    if (url.includes('/status/models')) return response([{ name: 'stable_diffusion', count: 8, eta: 20 }]);
    if (url.endsWith('/generate/async')) return response({ id: 'request-12345678' }, 202);
    if (url.includes('/generate/check/')) return response({ done: true, faulted: false, is_possible: true });
    return response({ generations: [{ state: 'ok', censored: false, model: 'Teste', img: Buffer.from('<html>').toString('base64') }] });
  };
  const provider = new AIHordeImageProvider({ fetchImpl, pollIntervalMs: 1, generationTimeoutMs: 1000 });
  await assert.rejects(() => provider.generateImage({ prompt: 'Crie uma imagem.' }), error => error.code === 'community_image_invalid_response');
});

test('STOP cancela também a tarefa remota em andamento', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/status/models')) return response([{ name: 'stable_diffusion', count: 8, eta: 20 }]);
    if (url.endsWith('/generate/async')) return response({ id: 'request-12345678' }, 202);
    if (options.method === 'DELETE') return response({ message: 'cancelled' });
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  };
  const provider = new AIHordeImageProvider({ fetchImpl, pollIntervalMs: 1, generationTimeoutMs: 5000 });
  const controller = new AbortController();
  const pending = provider.generateImage({ prompt: 'Crie uma imagem.', signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();

  await assert.rejects(pending, error => error.code === 'request_cancelled');
  assert.ok(calls.some(call => call.options.method === 'DELETE'));
});
