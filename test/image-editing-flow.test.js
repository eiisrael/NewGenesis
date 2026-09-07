import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AttachmentStore } from '../src/attachments.js';
import { classifyImageRequest, parseImageGenerationRequest } from '../src/core/image-request.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible-provider.js';
import { AIHordeImageProvider } from '../src/providers/ai-horde-image-provider.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function tempStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-image-edit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new AttachmentStore(root).init();
}

test('imagem anexada com pedido de edição vira geração por referência sem alterar a mensagem canônica', async t => {
  const store = await tempStore(t);
  const [image] = await store.saveMany('conversation-1', [{ name: 'foto.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL }]);
  const conversation = {
    id: 'conversation-1',
    messages: [{ id: 'u1', role: 'user', content: 'Remova o fundo e deixe branco', attachments: [image], meta: {} }]
  };
  const hydrated = await store.hydrateConversation(conversation);
  const latest = hydrated.messages[0];
  const parsed = parseImageGenerationRequest(latest.content);
  assert.equal(parsed.operation, 'edit');
  assert.equal(parsed.prompt, 'Remova o fundo e deixe branco');
  assert.equal(parsed.references.length, 1);
  assert.equal(latest.attachments.length, 0);
  assert.equal(conversation.messages[0].content, 'Remova o fundo e deixe branco');
  assert.equal(conversation.messages[0].attachments.length, 1);
});

test('continuação curta reutiliza a última imagem gerada pelo assistente', async t => {
  const store = await tempStore(t);
  const [image] = await store.saveMany('conversation-2', [{ name: 'genesis.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL }]);
  const hydrated = await store.hydrateConversation({
    id: 'conversation-2',
    messages: [
      { id: 'a1', role: 'assistant', content: 'Imagem criada.', attachments: [image] },
      { id: 'u2', role: 'user', content: 'Agora deixe mais realista e mude o fundo', attachments: [] }
    ]
  });
  const parsed = parseImageGenerationRequest(hydrated.messages[1].content);
  assert.equal(parsed.operation, 'edit');
  assert.equal(parsed.references.length, 1);
  assert.match(parsed.prompt, /mais realista/i);
});

test('análise de imagem não é confundida com edição', () => {
  assert.equal(classifyImageRequest('Analise esta imagem e descreva o que aparece', { currentImages: 1 }), null);
  assert.equal(classifyImageRequest('Crie uma imagem de uma cidade futurista'), 'create');
  assert.equal(classifyImageRequest('Troque a cor da roupa para azul', { currentImages: 1 }), 'edit');
});

test('OpenRouter envia input_references somente para modelo free compatível', async t => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/images/models')) {
      return new Response(JSON.stringify({ data: [{
        id: 'example/image-free:free', name: 'Image Free',
        architecture: { output_modalities: ['image'] },
        supported_parameters: {
          input_references: { type: 'range', min: 0, max: 2 },
          output_format: { type: 'enum', values: ['png'] },
          aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
          resolution: { type: 'enum', values: ['1K'] }
        }
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      model: 'example/image-free:free', provider: 'free-test',
      data: [{ b64_json: 'AA==', media_type: 'image/png' }],
      usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    id: 'openrouter', name: 'OpenRouter', kind: 'remote', freeLabel: 'FREE', configured: true,
    apiKey: 'sk-or-test', baseUrl: 'https://openrouter.ai/api/v1', models: ['openrouter/free'],
    selectionMode: 'automatic', selectedModel: 'openrouter/free',
    discoveryTimeoutMs: 5000, requestTimeoutMs: 5000
  });
  const marker = `Crie uma imagem editada.\n[[GENESIS_IMAGE_REQUEST_V1]]${JSON.stringify({ operation: 'edit', prompt: 'Troque apenas o fundo para branco', references: [PNG_DATA_URL] })}[[/GENESIS_IMAGE_REQUEST_V1]]`;
  const result = await provider.generateImage({ prompt: marker });
  const body = calls.find(call => call.url.endsWith('/images'))?.body;
  assert.equal(result.imageOperation, 'edit');
  assert.equal(body.prompt, 'Troque apenas o fundo para branco');
  assert.equal(body.input_references.length, 1);
  assert.equal(body.input_references[0].image_url.url, PNG_DATA_URL);
  assert.equal(body.resolution, '1K');
});

test('AI Horde usa img2img, prompt negativo e preset de alta qualidade no fallback de edição', async () => {
  const calls = [];
  const provider = new AIHordeImageProvider({
    pollIntervalMs: 1,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
      if (String(url).includes('/status/models')) return new Response(JSON.stringify([{ name: 'AlbedoBase XL', count: 2, eta: 1 }]), { status: 200 });
      if (String(url).endsWith('/generate/async')) return new Response(JSON.stringify({ id: 'request-1234' }), { status: 200 });
      if (String(url).includes('/generate/check/')) return new Response(JSON.stringify({ done: true, is_possible: true }), { status: 200 });
      return new Response(JSON.stringify({ generations: [{ state: 'ok', censored: false, model: 'AlbedoBase XL', img: PNG_DATA_URL }] }), { status: 200 });
    }
  });
  const marker = `Crie uma imagem editada.\n[[GENESIS_IMAGE_REQUEST_V1]]${JSON.stringify({ operation: 'edit', prompt: 'Mude o fundo para azul e deixe realista', references: [PNG_DATA_URL] })}[[/GENESIS_IMAGE_REQUEST_V1]]`;
  const result = await provider.generateImage({ prompt: marker });
  const queued = calls.find(call => call.url.endsWith('/generate/async')).body;
  assert.equal(queued.source_processing, 'img2img');
  assert.ok(queued.source_image.length > 20);
  assert.equal(queued.params.denoising_strength, 0.58);
  assert.equal(queued.params.sampler_name, 'k_dpmpp_2m');
  assert.equal(queued.params.karras, true);
  assert.ok(queued.params.width >= 512);
  assert.ok(queued.params.height >= 512);
  assert.match(queued.prompt, /###/);
  assert.match(queued.prompt, /cartoon/i);
  assert.equal(result.imageOperation, 'edit');
});
