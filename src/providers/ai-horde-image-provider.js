import { ProviderError } from '../core/errors.js';
import { parseImageGenerationRequest } from '../core/image-request.js';
import { estimateRequestTokens } from '../core/context-engine.js';
import { InferenceBudget, createUsageLedger, recordUsage, finalUsage } from '../core/request-budget.js';
import {
  fallbackImagePlan,
  hordePrompt,
  imageDimensionsForPlan,
  scoreCommunityImageModel
} from '../core/image-intelligence.js';

const ANONYMOUS_KEY = '0000000000';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function combinedSignal(externalSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs));
  if (!externalSignal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([externalSignal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new ProviderError('Solicitação interrompida pelo usuário.', {
        providerId: 'aihorde-image', category: 'cancelled', code: 'request_cancelled', retryable: false
      }));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(finish, milliseconds);
  });
}

function safeMessage(payload, fallback) {
  return String(payload?.message || payload?.error || fallback).slice(0, 300);
}

function requestError(status, payload) {
  const options = { providerId: 'aihorde-image', status };
  if (status === 401 || status === 403) {
    return new ProviderError('A rede comunitária recusou a autenticação anônima.', {
      ...options, category: 'authentication', code: 'community_image_authentication', retryable: false
    });
  }
  if (status === 429) {
    return new ProviderError('A fila gratuita de imagens atingiu o limite temporário.', {
      ...options, category: 'quota', code: 'community_image_rate_limit'
    });
  }
  if (status >= 500) {
    return new ProviderError('A rede comunitária de imagens está temporariamente indisponível.', {
      ...options, category: 'availability', code: 'community_image_unavailable'
    });
  }
  return new ProviderError(safeMessage(payload, 'A rede comunitária recusou este pedido de imagem.'), {
    ...options, category: 'request', code: 'community_image_invalid_request', retryable: false
  });
}

function imagePayload(value) {
  const source = String(value || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  if (!source || !/^[a-zA-Z0-9+/]*={0,2}$/.test(source)) {
    throw new ProviderError('A rota remota não devolveu uma imagem válida.', {
      providerId: 'aihorde-image', category: 'availability', code: 'community_image_invalid_response'
    });
  }
  const buffer = Buffer.from(source, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64').replace(/=+$/, '') !== source.replace(/=+$/, '')) {
    throw new ProviderError('A imagem remota é inválida ou excede o limite de 8 MB.', {
      providerId: 'aihorde-image', category: 'availability', code: 'community_image_invalid_response'
    });
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { buffer, mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { buffer, mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { buffer, mimeType: 'image/webp', extension: 'webp' };
  }
  throw new ProviderError('A rota remota devolveu um formato de imagem não permitido.', {
    providerId: 'aihorde-image', category: 'availability', code: 'community_image_invalid_response'
  });
}

function sourceImage(value) {
  const dataUrl = String(value || '').trim();
  const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp|gif);base64,([a-zA-Z0-9+/]*={0,2})$/i);
  if (!match) return '';
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return '';
  return match[1];
}

export class AIHordeImageProvider {
  constructor(options = {}) {
    this.id = 'aihorde-image';
    this.name = 'Rede comunitária gratuita';
    this.baseUrl = String(options.baseUrl || 'https://aihorde.net/api/v2').replace(/\/$/, '');
    this.apiKey = String(options.apiKey || ANONYMOUS_KEY).trim() || ANONYMOUS_KEY;
    this.fetchImpl = options.fetchImpl || fetch;
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 20000);
    this.generationTimeoutMs = Number(options.generationTimeoutMs || 180000);
    this.pollIntervalMs = Number(options.pollIntervalMs || 1500);
    this.clientAgent = String(options.clientAgent || 'NewGenesis:https://github.com/eiisrael/NewGenesis');
    this.handlesRequestBudget = true;
    this.modelCatalog = null;
    this.modelCatalogAt = 0;
  }

  headers(json = false) {
    return {
      apikey: this.apiKey,
      'Client-Agent': this.clientAgent,
      ...(json ? { 'content-type': 'application/json' } : {})
    };
  }

  async requestJson(path, options = {}, externalSignal, deadlineAt = null) {
    if (deadlineAt && Date.now() >= deadlineAt) throw new ProviderError('O tempo disponível para gerar a imagem foi atingido.', {
      providerId: this.id, category: 'timeout', code: 'task_deadline_exceeded', retryable: false
    });
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        headers: { ...this.headers(Boolean(options.body)), ...(options.headers || {}) },
        signal: combinedSignal(externalSignal, Math.min(this.requestTimeoutMs, (deadlineAt || Infinity) - Date.now()))
      });
    } catch (error) {
      if (externalSignal?.aborted || error?.code === 'request_cancelled') {
        throw new ProviderError('Solicitação interrompida pelo usuário.', {
          providerId: this.id, category: 'cancelled', code: 'request_cancelled', retryable: false
        });
      }
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ProviderError(timedOut
        ? 'A rede comunitária excedeu o tempo de resposta.'
        : 'Não foi possível conectar à rede comunitária de imagens.', {
        providerId: this.id,
        category: timedOut ? 'timeout' : 'availability',
        code: timedOut ? 'community_image_timeout' : 'community_image_unreachable'
      });
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* resposta inválida tratada abaixo */ }
    if (!response.ok) throw requestError(response.status, payload);
    if (!payload || typeof payload !== 'object') {
      throw new ProviderError('A rede comunitária devolveu uma resposta inválida.', {
        providerId: this.id, category: 'availability', code: 'community_image_invalid_response'
      });
    }
    return payload;
  }

  async cancel(requestId) {
    if (!requestId) return;
    try {
      await this.fetchImpl(`${this.baseUrl}/generate/status/${encodeURIComponent(requestId)}`, {
        method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5000)
      });
    } catch { /* cancelamento remoto é melhor esforço */ }
  }

  async availableModels(signal, plan = {}, deadlineAt = null) {
    try {
      if (!this.modelCatalog || Date.now() - this.modelCatalogAt >= 30000) {
        const catalog = await this.requestJson('/status/models?type=image', {}, signal, deadlineAt);
        this.modelCatalog = Array.isArray(catalog) ? catalog : [];
        this.modelCatalogAt = Date.now();
      }
      const models = this.modelCatalog;
      return (Array.isArray(models) ? models : [])
        .filter(model => Number(model?.count || 0) > 0 && model?.name)
        .filter(model => !/nsfw|hentai|nude|furry/i.test(String(model.name)))
        .sort((a, b) => scoreCommunityImageModel(b, plan) - scoreCommunityImageModel(a, plan))
        .slice(0, 3)
        .map(model => String(model.name));
    } catch (error) {
      if (signal?.aborted || ['request_cancelled', 'task_deadline_exceeded'].includes(error?.code)) throw error;
      return ['stable_diffusion'];
    }
  }

  async generateImage({ prompt, plan = null, signal, onAttempt = () => {}, requestBudget = null, usageLedger = null, deadlineAt = null }) {
    const request = parseImageGenerationRequest(prompt);
    const activePlan = plan && typeof plan === 'object'
      ? { ...fallbackImagePlan(request), ...plan, references: plan.references || request.references }
      : fallbackImagePlan(request);
    const normalizedPrompt = hordePrompt(activePlan).replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!normalizedPrompt) {
      throw new ProviderError('Descreva a imagem que o Gênesis deve criar.', {
        providerId: this.id, category: 'request', code: 'empty_image_prompt', retryable: false
      });
    }
    const reference = activePlan.references?.length ? sourceImage(activePlan.references[0]) : '';
    if (activePlan.operation === 'edit' && !reference) {
      throw new ProviderError('A imagem de referência não pôde ser preparada para edição.', {
        providerId: this.id, category: 'request', code: 'community_image_invalid_reference', retryable: false
      });
    }

    const started = Date.now();
    const generationDeadline = Math.min(deadlineAt || Infinity, started + this.generationTimeoutMs);
    const budget = requestBudget || new InferenceBudget(1);
    const ledger = usageLedger || createUsageLedger();
    let requestId = null;
    let requestNumber = null;
    let estimatedInputTokens = 0;
    try {
      const models = await this.availableModels(signal, activePlan, generationDeadline);
      onAttempt({
        id: models[0] || 'community-auto',
        name: activePlan.operation === 'edit'
          ? `Modelos comunitários img2img · ${models[0] || 'automático'}`
          : `Modelo comunitário · ${models[0] || 'automático'}`
      }, 1);
      const dimensions = imageDimensionsForPlan(activePlan);
      const params = {
        n: 1,
        width: dimensions.width,
        height: dimensions.height,
        steps: activePlan.operation === 'edit' ? 28 : activePlan.style === 'photorealistic' ? 30 : 26,
        cfg_scale: activePlan.style === 'photorealistic' ? 6.5 : 7,
        sampler_name: 'k_dpmpp_2m',
        karras: true
      };
      if (activePlan.operation === 'edit') params.denoising_strength = 0.58;
      const body = {
        prompt: normalizedPrompt,
        params,
        nsfw: false,
        trusted_workers: false,
        validated_backends: true,
        slow_workers: true,
        extra_slow_workers: true,
        censor_nsfw: true,
        r2: false,
        shared: false,
        replacement_filter: true,
        allow_downgrade: true,
        models: models.length ? models : ['stable_diffusion']
      };
      if (reference) {
        body.source_image = reference;
        body.source_processing = 'img2img';
      }
      if (signal?.aborted) throw new ProviderError('Solicitação interrompida pelo usuário.', {
        providerId: this.id, category: 'cancelled', code: 'request_cancelled', retryable: false
      });
      if (Date.now() >= generationDeadline) throw new ProviderError('O tempo disponível para gerar a imagem foi atingido.', {
        providerId: this.id, category: 'timeout', code: 'task_deadline_exceeded', retryable: false
      });
      estimatedInputTokens = estimateRequestTokens([{ role: 'user', content: [
        { type: 'text', text: normalizedPrompt },
        ...(activePlan.references || []).map(url => ({ type: 'image_url', image_url: { url } }))
      ] }]);
      requestNumber = budget.consume({
        providerId: this.id, model: models[0] || 'community-auto', kind: 'image_generation', estimatedInputTokens
      });
      const queued = await this.requestJson('/generate/async', {
        method: 'POST',
        body: JSON.stringify(body)
      }, signal, generationDeadline);
      requestId = String(queued.id || '');
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
        throw new ProviderError('A fila gratuita não confirmou o pedido de imagem.', {
          providerId: this.id, category: 'availability', code: 'community_image_invalid_response'
        });
      }

      let polls = 0;
      while (Date.now() < generationDeadline) {
        const pollDelay = Math.min(10000, this.pollIntervalMs * (1 + Math.floor(polls / 4)), generationDeadline - Date.now());
        await wait(Math.max(1, pollDelay), signal);
        const progress = await this.requestJson(`/generate/check/${encodeURIComponent(requestId)}`, {}, signal, generationDeadline);
        polls += 1;
        if (progress.faulted) {
          throw new ProviderError('A tarefa de imagem falhou na rede comunitária.', {
            providerId: this.id, category: 'availability', code: 'community_image_faulted'
          });
        }
        if (progress.is_possible === false) {
          throw new ProviderError('Não há um trabalhador gratuito compatível disponível neste momento.', {
            providerId: this.id, category: 'availability', code: 'community_image_no_worker'
          });
        }
        if (!progress.done) continue;

        const status = await this.requestJson(`/generate/status/${encodeURIComponent(requestId)}`, {}, signal, generationDeadline);
        const generation = Array.isArray(status.generations) ? status.generations.find(item => item?.state === 'ok' && !item?.censored) : null;
        if (!generation?.img) {
          throw new ProviderError('A rede comunitária não devolveu uma imagem segura.', {
            providerId: this.id, category: 'availability', code: 'community_image_empty_response'
          });
        }
        const image = imagePayload(generation.img);
        const model = String(generation.model || models[0] || 'modelo comunitário');
        recordUsage(ledger, {}, { inputTokens: estimatedInputTokens }, { requestNumber, providerId: this.id, model });
        return {
          content: activePlan.operation === 'edit'
            ? 'Imagem editada pelo Gênesis usando a referência enviada e uma rota comunitária gratuita.'
            : 'Imagem criada pelo Gênesis com uma rota remota gratuita.',
          generatedImages: [{
            name: `genesis-${activePlan.operation === 'edit' ? 'edit' : 'image'}-${Date.now()}.${image.extension}`,
            mimeType: image.mimeType,
            dataUrl: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`
          }],
          imageOperation: activePlan.operation,
          imagePlan: activePlan,
          model,
          resolvedModel: model,
          resolvedProvider: this.name,
          latencyMs: Date.now() - started,
          finishReason: 'stop',
          attempts: [],
          generationMetadata: Array.isArray(generation.gen_metadata) ? generation.gen_metadata : [],
          usage: finalUsage(ledger, budget)
        };
      }
      throw new ProviderError('A fila gratuita de imagens excedeu o tempo máximo de espera.', {
        providerId: this.id, category: 'timeout', code: 'community_image_timeout'
      });
    } catch (error) {
      if (requestId) await this.cancel(requestId);
      error.usage = finalUsage(ledger, budget);
      throw error;
    }
  }
}
