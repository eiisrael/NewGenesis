import { ProviderError } from '../core/errors.js';
import { isFreeOpenRouterModel } from '../core/policy.js';
import { parseImageGenerationRequest } from '../core/image-request.js';
import {
  fallbackImagePlan,
  imageCriticMessages,
  imagePlannerMessages,
  parseImageCriticResponse,
  parseImagePlanResponse,
  refineImagePlan,
  scoreImageModel
} from '../core/image-intelligence.js';

function capability(model, name) {
  const source = model?.supportedParameters || model?.supported_parameters;
  if (Array.isArray(source)) return source.includes(name) ? { type: 'boolean' } : null;
  if (!source || typeof source !== 'object') return null;
  return Object.hasOwn(source, name) ? source[name] ?? { type: 'boolean' } : null;
}

function enumValue(value, preferred = []) {
  const values = Array.isArray(value?.values) ? value.values.map(String) : [];
  return preferred.find(item => values.includes(item)) || null;
}

function usageOf(value = {}) {
  return {
    inputTokens: Number(value.inputTokens ?? value.prompt_tokens ?? 0),
    outputTokens: Number(value.outputTokens ?? value.completion_tokens ?? 0),
    totalTokens: Number(value.totalTokens ?? value.total_tokens ?? 0)
  };
}

function addUsage(target, value = {}) {
  const usage = usageOf(value);
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  return target;
}

function safeImage(image, index, operation) {
  const base64 = String(image?.b64_json || '').trim();
  const mimeType = String(image?.media_type || 'image/png').toLowerCase();
  if (!base64 || !/^image\/(?:png|jpeg|webp|gif)$/.test(mimeType)) return null;
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(base64) || base64.length > 16 * 1024 * 1024) return null;
  const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mimeType] || 'png';
  return {
    name: `genesis-${operation === 'edit' ? 'edit' : 'image'}-${Date.now()}-${index + 1}.${extension}`,
    mimeType,
    dataUrl: `data:${mimeType};base64,${base64}`
  };
}

function openRouterImageBody(model, plan) {
  const body = { model: model.id, n: 1 };
  const negativeSupported = capability(model, 'negative_prompt');
  body.prompt = negativeSupported
    ? plan.prompt
    : `${plan.prompt} Avoid these defects and contradictions: ${plan.negativePrompt}.`;
  if (negativeSupported) body.negative_prompt = plan.negativePrompt;

  const resolution = enumValue(capability(model, 'resolution'), ['2K', '2048', '1K', '1024', '1024x1024', '512']);
  if (resolution) body.resolution = resolution;
  const aspect = capability(model, 'aspect_ratio');
  const aspectValues = Array.isArray(aspect?.values) ? aspect.values.map(String) : [];
  if (aspectValues.includes(plan.aspectRatio)) body.aspect_ratio = plan.aspectRatio;
  else if (aspectValues.includes('auto')) body.aspect_ratio = 'auto';
  const quality = enumValue(capability(model, 'quality'), ['high', 'medium', 'auto']);
  if (quality) body.quality = quality;
  const outputFormat = enumValue(capability(model, 'output_format'), ['png', 'webp', 'jpeg']);
  if (outputFormat) body.output_format = outputFormat;

  if (plan.references?.length) {
    const inputReferences = capability(model, 'input_references');
    const maxReferences = Math.max(1, Math.min(5, Number(inputReferences?.max || 1)));
    body.input_references = plan.references.slice(0, maxReferences).map(url => ({
      type: 'image_url', image_url: { url }
    }));
  }
  return body;
}

function qualityContent(plan, review, retried) {
  const operation = plan.operation === 'edit' ? 'editada' : 'criada';
  if (review?.pass) {
    return `Imagem ${operation} pelo Gênesis e validada visualmente contra o pedido${retried ? ' após refinamento automático' : ''}.`;
  }
  return `Imagem ${operation} pelo Gênesis com o melhor resultado disponível nas rotas gratuitas${retried ? ' após refinamento automático' : ''}.`;
}

export class SmartImageProvider {
  constructor({ openRouter = null, community = null, requestTimeoutMs = 120000 } = {}) {
    this.id = 'genesis-image';
    this.name = 'Genesis Visual Intelligence';
    this.openRouter = openRouter;
    this.community = community;
    this.requestTimeoutMs = Math.max(30000, Number(requestTimeoutMs || 120000));
    this.configured = true;
  }

  markSuccess() { /* o provedor textual mantém sua própria saúde; a rota visual é composta */ }

  async textCandidates(requirements, signal) {
    if (!this.openRouter?.configured || typeof this.openRouter.resolveCandidates !== 'function') return [];
    try {
      return await this.openRouter.resolveCandidates('reasoning', requirements, {
        signal,
        taskProfile: {
          intent: 'ANALYSIS', image: requirements.image === true, tools: false,
          longContext: false, kind: 'answer', complexity: 'normal', outputFormat: 'json', readOnly: true
        }
      }) || [];
    } catch (error) {
      if (signal?.aborted || error?.code === 'request_cancelled') throw error;
      return [];
    }
  }

  async plan(request, signal, usage) {
    const fallback = fallbackImagePlan(request);
    const routes = (await this.textCandidates({}, signal)).slice(0, 2);
    for (const candidate of routes) {
      try {
        const result = await this.openRouter.generate({
          candidate,
          messages: imagePlannerMessages(request),
          maxOutputTokens: 700,
          temperature: 0.15,
          sessionId: `genesis-image-plan-${Date.now()}`,
          signal,
          requestKind: 'image_plan',
          deadlineAt: Date.now() + 20000
        });
        addUsage(usage, result.usage);
        return { plan: parseImagePlanResponse(result.content, request), model: result.resolvedModel || result.model };
      } catch (error) {
        if (signal?.aborted || error?.code === 'request_cancelled') throw error;
      }
    }
    return { plan: fallback, model: 'local-image-planner' };
  }

  async review(image, plan, signal, usage) {
    if (!image?.dataUrl || !this.openRouter?.configured) return null;
    const routes = (await this.textCandidates({ image: true }, signal)).slice(0, 2);
    for (const candidate of routes) {
      try {
        const result = await this.openRouter.generate({
          candidate,
          messages: imageCriticMessages(plan, image.dataUrl),
          maxOutputTokens: 500,
          temperature: 0,
          sessionId: `genesis-image-review-${Date.now()}`,
          signal,
          requestKind: 'image_review',
          deadlineAt: Date.now() + 24000
        });
        addUsage(usage, result.usage);
        const review = parseImageCriticResponse(result.content);
        if (review) return { ...review, model: result.resolvedModel || result.model };
      } catch (error) {
        if (signal?.aborted || error?.code === 'request_cancelled') throw error;
      }
    }
    return null;
  }

  async openRouterImageModels(signal) {
    if (!this.openRouter?.configured || typeof this.openRouter.requestJson !== 'function') return [];
    try {
      const { payload } = await this.openRouter.requestJson(`${this.openRouter.baseUrl}/images/models`, {
        headers: this.openRouter.headers(), signal
      }, Math.min(10000, this.openRouter.discoveryTimeoutMs || 10000));
      return (Array.isArray(payload?.data) ? payload.data : [])
        .filter(model => isFreeOpenRouterModel(model.id))
        .filter(model => model.architecture?.output_modalities?.includes('image'))
        .filter(model => !String(model.id || '').toLowerCase().includes('vector'))
        .map(model => ({
          id: model.id,
          name: model.name || model.id,
          description: String(model.description || ''),
          supportedParameters: model.supported_parameters || {}
        }));
    } catch (error) {
      if (signal?.aborted || error?.code === 'request_cancelled') throw error;
      return [];
    }
  }

  async generateWithOpenRouter(plan, signal, onAttempt, usage, attemptState) {
    let models = await this.openRouterImageModels(signal);
    if (plan.references?.length) models = models.filter(model => capability(model, 'input_references'));
    models.sort((a, b) => scoreImageModel(b, plan) - scoreImageModel(a, plan));
    const attempts = [];
    let currentPlan = plan;
    let best = null;
    for (const model of models.slice(0, 3)) {
      if (signal?.aborted) throw Object.assign(new Error('Solicitação interrompida pelo usuário.'), { code: 'request_cancelled', category: 'cancelled' });
      attemptState.count += 1;
      onAttempt({ id: model.id, name: model.name }, attemptState.count);
      const started = Date.now();
      try {
        const { payload } = await this.openRouter.requestJson(`${this.openRouter.baseUrl}/images`, {
          method: 'POST', headers: this.openRouter.headers(), body: JSON.stringify(openRouterImageBody(model, currentPlan)), signal
        }, Math.min(this.requestTimeoutMs, 120000));
        addUsage(usage, payload?.usage);
        const images = (Array.isArray(payload?.data) ? payload.data : [])
          .map((item, index) => safeImage(item, index, currentPlan.operation))
          .filter(Boolean);
        if (!images.length) throw new ProviderError('O modelo gratuito não retornou uma imagem raster válida.', {
          providerId: this.id, category: 'availability', code: 'empty_image_response'
        });
        const review = await this.review(images[0], currentPlan, signal, usage);
        const candidateResult = {
          content: qualityContent(currentPlan, review, currentPlan !== plan),
          generatedImages: images,
          imageOperation: currentPlan.operation,
          imagePlan: currentPlan,
          qualityReview: review,
          model: model.id,
          resolvedModel: String(payload?.model || model.id),
          resolvedProvider: payload?.provider || 'OpenRouter Images',
          latencyMs: Date.now() - started,
          finishReason: 'stop',
          attempts,
          usage: { ...usage }
        };
        if (!best || Number(review?.score ?? 101) > Number(best.qualityReview?.score ?? 0)) best = candidateResult;
        if (!review || review.pass) return candidateResult;
        if (currentPlan.retryBudget > 0) currentPlan = refineImagePlan(currentPlan, review);
      } catch (error) {
        if (signal?.aborted || error?.code === 'request_cancelled') throw error;
        attempts.push({ model: model.id, message: String(error?.message || 'Falha na geração.').slice(0, 300) });
      }
    }
    return best;
  }

  async generateWithCommunity(plan, originalPrompt, signal, onAttempt, usage, attemptState) {
    if (!this.community?.generateImage) return null;
    let currentPlan = plan;
    let best = null;
    for (let round = 0; round < 2; round += 1) {
      attemptState.count += 1;
      const outerAttempt = attemptState.count;
      const result = await this.community.generateImage({
        prompt: originalPrompt,
        plan: currentPlan,
        signal,
        onAttempt: model => onAttempt(model, outerAttempt)
      });
      addUsage(usage, result.usage);
      const review = await this.review(result.generatedImages?.[0], currentPlan, signal, usage);
      const candidateResult = {
        ...result,
        content: qualityContent(currentPlan, review, round > 0),
        imagePlan: currentPlan,
        qualityReview: review,
        usage: { ...usage }
      };
      if (!best || Number(review?.score ?? 101) > Number(best.qualityReview?.score ?? 0)) best = candidateResult;
      if (!review || review.pass) return candidateResult;
      if (currentPlan.retryBudget <= 0) break;
      currentPlan = refineImagePlan(currentPlan, review);
    }
    return best;
  }

  async generateImage({ prompt, signal, onAttempt = () => {} }) {
    const request = parseImageGenerationRequest(prompt);
    if (!String(request.prompt || '').trim()) {
      throw new ProviderError('Descreva a imagem que o Gênesis deve criar.', {
        providerId: this.id, category: 'request', code: 'empty_image_prompt', retryable: false
      });
    }
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const attemptState = { count: 0 };
    const { plan } = await this.plan(request, signal, usage);
    const failures = [];

    if (this.openRouter?.configured) {
      try {
        const result = await this.generateWithOpenRouter(plan, signal, onAttempt, usage, attemptState);
        if (result?.qualityReview?.pass || (result && !result.qualityReview)) return result;
        if (result) failures.push({ provider: 'OpenRouter Images', message: 'A validação visual pediu refinamento adicional.' });
      } catch (error) {
        if (signal?.aborted || error?.code === 'request_cancelled') throw error;
        failures.push({ provider: 'OpenRouter Images', message: String(error?.message || 'Falha na rota principal.').slice(0, 300) });
      }
    }

    try {
      const result = await this.generateWithCommunity(plan, prompt, signal, onAttempt, usage, attemptState);
      if (result) {
        result.attempts = [...(result.attempts || []), ...failures];
        return result;
      }
    } catch (error) {
      if (signal?.aborted || error?.code === 'request_cancelled') throw error;
      failures.push({ provider: 'AI Horde', message: String(error?.message || 'Falha na rede comunitária.').slice(0, 300) });
    }

    const error = new ProviderError('Nenhuma rota gratuita conseguiu produzir uma imagem válida depois do planejamento e dos fallbacks do Genesis Visual Intelligence.', {
      providerId: this.id, category: 'availability', code: 'smart_image_routes_exhausted'
    });
    error.attempts = failures;
    error.usage = usage;
    throw error;
  }
}
