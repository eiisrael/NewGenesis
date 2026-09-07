import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackImagePlan,
  hordePrompt,
  imageDimensionsForPlan,
  parseImageCriticResponse,
  parseImagePlanResponse,
  refineImagePlan,
  scoreCommunityImageModel,
  scoreImageModel
} from '../src/core/image-intelligence.js';
import { SmartImageProvider } from '../src/providers/smart-image-provider.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_BASE64 = PNG_DATA_URL.split(',')[1];

test('planner local preserva acessórios obrigatórios e reforça fotorealismo', () => {
  const plan = fallbackImagePlan({ operation: 'create', prompt: 'Faça uma imagem de um cachorro realista com chupeta' });
  assert.equal(plan.style, 'photorealistic');
  assert.equal(plan.aspectRatio, '1:1');
  assert.ok(plan.mustInclude.some(item => /chupeta/i.test(item)));
  assert.match(plan.prompt, /original user request exactly/i);
  assert.match(plan.negativePrompt, /cartoon/i);
  assert.deepEqual(imageDimensionsForPlan(plan), { width: 768, height: 768 });
});

test('resposta do Visual Planner nunca elimina o pedido original', () => {
  const request = { operation: 'create', prompt: 'Faça uma imagem de um cachorro realista com chupeta' };
  const plan = parseImagePlanResponse(`\`\`\`json\n${JSON.stringify({
    prompt: 'Photorealistic puppy wearing a baby pacifier, detailed fur, studio light',
    negativePrompt: 'cartoon, toy, blur',
    mustInclude: ['puppy', 'baby pacifier visibly in the mouth'],
    style: 'photorealistic',
    aspectRatio: '1:1'
  })}\n\`\`\``, request);
  assert.match(plan.prompt, /baby pacifier/i);
  assert.match(plan.prompt, /cachorro realista com chupeta/i);
  assert.ok(plan.mustInclude.some(item => /pacifier/i.test(item)));
});

test('critic exige cobertura total e refinamento torna falha explícita no próximo prompt', () => {
  const review = parseImageCriticResponse(JSON.stringify({
    pass: false,
    score: 62,
    missing: ['baby pacifier clearly visible in the puppy mouth'],
    issues: ['object near mouth looks like a muzzle'],
    promptAdjustment: 'Show a recognizable round baby pacifier with shield and handle'
  }));
  assert.equal(review.pass, false);
  const base = fallbackImagePlan({ operation: 'create', prompt: 'cachorro realista com chupeta' });
  const refined = refineImagePlan(base, review);
  assert.match(refined.prompt, /CRITICAL MISSING REQUIREMENTS/i);
  assert.match(refined.prompt, /round baby pacifier/i);
  assert.ok(refined.mustInclude.some(item => /pacifier/i.test(item)));
});

test('roteamento visual prioriza capacidades e especialização de estilo', () => {
  const plan = fallbackImagePlan({ operation: 'create', prompt: 'foto realista de um cachorro' });
  const realistic = {
    id: 'example/realvis-flux:free', name: 'RealVis Flux', description: 'photorealistic image model',
    supportedParameters: {
      resolution: { type: 'enum', values: ['1K', '2K'] },
      aspect_ratio: { type: 'enum', values: ['1:1'] },
      negative_prompt: { type: 'boolean' }
    }
  };
  const anime = { id: 'example/anime:free', name: 'Anime model', supportedParameters: {} };
  assert.ok(scoreImageModel(realistic, plan) > scoreImageModel(anime, plan));
  assert.ok(scoreCommunityImageModel({ name: 'AlbedoBase XL', count: 3, eta: 2 }, plan)
    > scoreCommunityImageModel({ name: 'Anime Pony', count: 10, eta: 1 }, plan));
  assert.match(hordePrompt(plan), /###/);
});

test('Genesis Visual Intelligence usa planner, modelo free por capacidade e validação visual', async () => {
  const calls = [];
  const openRouter = {
    configured: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    discoveryTimeoutMs: 5000,
    headers: () => ({ authorization: 'Bearer test', 'content-type': 'application/json' }),
    resolveCandidates: async () => [{ model: 'example/vision-free:free' }],
    generate: async ({ messages }) => {
      if (/Visual Planner/.test(messages[0].content)) {
        return {
          content: JSON.stringify({
            prompt: 'Photorealistic close-up of a puppy with a recognizable baby pacifier visibly held in its mouth, natural fur, realistic studio photography',
            negativePrompt: 'cartoon, toy, muzzle, blur, watermark',
            mustInclude: ['puppy', 'baby pacifier visibly in mouth'],
            style: 'photorealistic', aspectRatio: '1:1'
          }),
          resolvedModel: 'example/planner-free:free',
          usage: { inputTokens: 30, outputTokens: 40, totalTokens: 70 }
        };
      }
      return {
        content: JSON.stringify({ pass: true, score: 94, missing: [], issues: [], promptAdjustment: '' }),
        resolvedModel: 'example/vision-free:free',
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
      };
    },
    requestJson: async (url, options = {}) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/images/models')) {
        return { payload: { data: [{
          id: 'example/realvis-flux:free', name: 'RealVis Flux', description: 'photorealistic',
          architecture: { output_modalities: ['image'] },
          supported_parameters: {
            negative_prompt: { type: 'boolean' },
            resolution: { type: 'enum', values: ['1K', '2K'] },
            aspect_ratio: { type: 'enum', values: ['1:1'] },
            quality: { type: 'enum', values: ['high'] },
            output_format: { type: 'enum', values: ['png'] }
          }
        }] } };
      }
      return {
        payload: {
          model: 'example/realvis-flux:free', provider: 'free-test',
          data: [{ b64_json: PNG_BASE64, media_type: 'image/png' }],
          usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 }
        }
      };
    }
  };
  const community = { generateImage: async () => { throw new Error('fallback não deveria ser usado'); } };
  const provider = new SmartImageProvider({ openRouter, community, requestTimeoutMs: 5000 });
  const result = await provider.generateImage({ prompt: 'Faça uma imagem de um cachorro realista com chupeta' });
  const body = calls.find(call => call.url.endsWith('/images'))?.body;
  assert.equal(result.qualityReview.pass, true);
  assert.equal(result.resolvedModel, 'example/realvis-flux:free');
  assert.match(body.prompt, /baby pacifier/i);
  assert.match(body.negative_prompt, /muzzle/i);
  assert.equal(body.resolution, '2K');
  assert.match(result.content, /validada visualmente/i);
});

test('Genesis Visual Intelligence regenera automaticamente quando o crítico detecta requisito ausente', async () => {
  let communityCalls = 0;
  let criticCalls = 0;
  const openRouter = {
    configured: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    discoveryTimeoutMs: 5000,
    headers: () => ({}),
    resolveCandidates: async () => [{ model: 'vision/free:free' }],
    generate: async ({ messages }) => {
      if (/Visual Planner/.test(messages[0].content)) {
        return {
          content: JSON.stringify({
            prompt: 'Photorealistic puppy with baby pacifier in mouth',
            negativePrompt: 'cartoon, muzzle, blur', mustInclude: ['puppy', 'baby pacifier'],
            style: 'photorealistic', aspectRatio: '1:1'
          }), usage: {}
        };
      }
      criticCalls += 1;
      return {
        content: criticCalls === 1
          ? JSON.stringify({ pass: false, score: 55, missing: ['baby pacifier visibly in mouth'], issues: [], promptAdjustment: 'Make the pacifier unmistakable, with shield and handle' })
          : JSON.stringify({ pass: true, score: 91, missing: [], issues: [], promptAdjustment: '' }),
        usage: {}
      };
    },
    requestJson: async url => url.endsWith('/images/models') ? { payload: { data: [] } } : { payload: {} }
  };
  const community = {
    generateImage: async ({ plan }) => {
      communityCalls += 1;
      if (communityCalls === 2) assert.match(plan.prompt, /CRITICAL MISSING REQUIREMENTS/i);
      return {
        content: 'Imagem criada.', generatedImages: [{ name: 'x.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL }],
        imageOperation: 'create', model: 'community-model', resolvedModel: 'community-model',
        resolvedProvider: 'AI Horde', latencyMs: 1, finishReason: 'stop', attempts: [], usage: {}
      };
    }
  };
  const provider = new SmartImageProvider({ openRouter, community, requestTimeoutMs: 5000 });
  const result = await provider.generateImage({ prompt: 'Faça uma imagem de um cachorro realista com chupeta' });
  assert.equal(communityCalls, 2);
  assert.equal(criticCalls, 2);
  assert.equal(result.qualityReview.pass, true);
  assert.match(result.content, /refinamento automático/i);
});
