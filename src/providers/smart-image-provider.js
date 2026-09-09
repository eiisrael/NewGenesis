import { ProviderError } from '../core/errors.js';
import { isFreeOpenRouterModel } from '../core/policy.js';
import { parseImageGenerationRequest } from '../core/image-request.js';
import { estimateTokens, estimateRequestTokens } from '../core/context-engine.js';
import { InferenceBudget, createUsageLedger, recordUsage, finalUsage } from '../core/request-budget.js';
import {
  fallbackImagePlan,
  imageCriticMessages,
  imageMemoryStyle,
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

function assertActive(state) {
  if (state.signal?.aborted) throw new ProviderError('Solicitação interrompida pelo usuário.', {
    providerId: 'genesis-image', category: 'cancelled', code: 'request_cancelled', retryable: false
  });
  if (state.deadlineAt && Date.now() >= state.deadlineAt) throw new ProviderError('O tempo disponível para gerar a imagem foi atingido.', {
    providerId: 'genesis-image', category: 'timeout', code: 'task_deadline_exceeded', retryable: false
  });
}

function imageInputTokens(plan) {
  return estimateRequestTokens([{ role: 'user', content: [
    { type: 'text', text: `${plan.prompt} ${plan.negativePrompt}` },
    ...(plan.references || []).map(url => ({ type: 'image_url', image_url: { url } }))
  ] }]);
}

function recordResult(state, requestNumber, result, { failed = false } = {}) {
  if (!requestNumber || state.ledger.records.some(record => record.requestNumber === requestNumber)) return;
  const usage = result?.usage || {};
  if (failed && !Object.values(usage).some(value => typeof value === 'number' && value > 0)) return;
  const entry = state.budget.entries.find(item => item.number === requestNumber);
  recordUsage(state.ledger, usage, {
    inputTokens: entry?.estimatedInputTokens || 0,
    outputTokens: failed ? 0 : estimateTokens(result?.content || '')
  }, { requestNumber, providerId: entry?.providerId, model: result?.resolvedModel || entry?.model });
}

function optionalStepAllowed(state, estimatedTokens, reserve = 0) {
  return state.budget.remaining > reserve && (state.budget.remainingInputTokens === null
    || state.budget.remainingInputTokens >= estimatedTokens + reserve * Math.max(1200, state.generationInputTokens || 0));
}

function mustStop(error, state) {
  return state.signal?.aborted || ['request_cancelled', 'task_deadline_exceeded', 'request_budget_exhausted', 'input_token_budget_exhausted'].includes(error?.code);
}

function safeImage(image, index, operation) {
  const base64 = String(image?.b64_json || '').trim();
  const declaredMimeType = String(image?.media_type || '').toLowerCase();
  if (!base64 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64) || base64.length > 12 * 1024 * 1024) return null;
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024
    || buffer.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) return null;
  let mimeType = '';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mimeType = 'image/png';
  else if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) mimeType = 'image/jpeg';
  else if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp';
  else if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif';
  if (!mimeType || (declaredMimeType && declaredMimeType !== mimeType)) return null;
  const extension = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mimeType] || 'png';
  return {
    name: `genesis-${operation === 'edit' ? 'edit' : 'image'}-${Date.now()}-${index + 1}.${extension}`,
    mimeType,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
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
    this.handlesRequestBudget = true;
    this.imageCatalog = null;
    this.imageCatalogAt = 0;
  }

  markSuccess() { /* o provedor textual mantém sua própria saúde; a rota visual é composta */ }

  async textCandidates(requirements, signal) {
    if (!this.openRouter?.configured || typeof this.openRouter.resolveCandidates !== 'function') return [];
    try {
      const candidates = await this.openRouter.resolveCandidates('reasoning', requirements, {
        signal,
        taskProfile: {
          intent: 'ANALYSIS', image: requirements.image === true, tools: false,
          longContext: false, kind: 'answer', complexity: 'normal', outputFormat: 'json', readOnly: true
        }
      });
      return (candidates || []).filter(candidate => isFreeOpenRouterModel(candidate.model || candidate.id));
    } catch (error) {
      if (signal?.aborted || error?.code === 'request_cancelled') throw error;
      return [];
    }
  }

  async textStep(messages, kind, state, reserve = 0) {
    if (!optionalStepAllowed(state, estimateRequestTokens(messages), reserve)) return null;
    const candidate = (await this.textCandidates(kind === 'image_review' ? { image: true } : {}, state.signal))[0];
    if (!candidate) return null;
    assertActive(state);
    const before = state.budget.used;
    if (!this.openRouter.handlesRequestBudget) state.budget.consume({
      providerId: this.openRouter.id || 'openrouter', model: candidate.model, kind,
      estimatedInputTokens: estimateRequestTokens(messages)
    });
    try {
      const result = await this.openRouter.generate({
        candidate, messages, maxOutputTokens: kind === 'image_review' ? 500 : 700,
        temperature: kind === 'image_review' ? 0 : 0.15,
        sessionId: `genesis-${kind}-${Date.now()}`, signal: state.signal,
        requestBudget: this.openRouter.handlesRequestBudget ? state.budget : null,
        requestKind: kind,
        deadlineAt: Math.min(state.deadlineAt || Infinity, Date.now() + 24000)
      });
      if (state.budget.used > before) recordResult(state, state.budget.used, result);
      return result;
    } catch (error) {
      if (state.budget.used > before) recordResult(state, state.budget.used, error, { failed: true });
      if (mustStop(error, state)) throw error;
      return null;
    }
  }

  async plan(request, state) {
    const fallback = fallbackImagePlan(request);
    state.generationInputTokens = imageInputTokens(fallback);
    const complex = request.operation === 'edit' || request.prompt.length > 240 || fallback.mustInclude.length > 1;
    state.reviewNeeded = complex || ['photorealistic', 'graphic-design'].includes(fallback.style);
    if (state.mode === 'fast' || (!complex && state.mode !== 'reasoning')) return fallback;
    const result = await this.textStep(imagePlannerMessages(request), 'image_plan', state, 1);
    return result ? parseImagePlanResponse(result.content, request) : fallback;
  }

  async review(image, plan, state) {
    if (!image?.dataUrl || state.mode === 'fast' || (!state.reviewNeeded && state.mode !== 'reasoning')) return null;
    try {
      const result = await this.textStep(imageCriticMessages(plan, image.dataUrl), 'image_review', state);
      const review = result ? parseImageCriticResponse(result.content) : null;
      return review ? { ...review, model: result.resolvedModel || result.model } : null;
    } catch (error) {
      if (state.signal?.aborted || error?.code === 'request_cancelled') throw error;
      return null;
    }
  }

  async openRouterImageModels(signal, deadlineAt = null) {
    if (!this.openRouter?.configured || typeof this.openRouter.requestJson !== 'function') return [];
    if (this.imageCatalog && Date.now() - this.imageCatalogAt < 5 * 60 * 1000) return [...this.imageCatalog];
    try {
      const { payload } = await this.openRouter.requestJson(`${this.openRouter.baseUrl}/images/models`, {
        headers: this.openRouter.headers(), signal
      }, Math.max(1, Math.min(10000, this.openRouter.discoveryTimeoutMs || 10000, (deadlineAt || Infinity) - Date.now())));
      const models = (Array.isArray(payload?.data) ? payload.data : [])
        .filter(model => isFreeOpenRouterModel(model.id))
        .filter(model => model.architecture?.output_modalities?.includes('image'))
        .filter(model => !String(model.id || '').toLowerCase().includes('vector'))
        .map(model => ({
          id: model.id,
          name: model.name || model.id,
          description: String(model.description || ''),
          supportedParameters: model.supported_parameters || {}
        }));
      this.imageCatalog = models;
      this.imageCatalogAt = Date.now();
      return [...models];
    } catch (error) {
      if (signal?.aborted || error?.code === 'request_cancelled') throw error;
      return [];
    }
  }

  async generateWithOpenRouter(plan, signal, onAttempt, state, attemptState) {
    let models = await this.openRouterImageModels(signal, state.deadlineAt);
    if (plan.references?.length) models = models.filter(model => capability(model, 'input_references'));
    models.sort((a, b) => scoreImageModel(b, plan) - scoreImageModel(a, plan));
    const attempts = [];
    let currentPlan = plan;
    let best = null;
    for (const model of models.slice(0, 3)) {
      if (!state.budget.remaining) break;
      if (best && !signal?.aborted && ((state.deadlineAt && Date.now() >= state.deadlineAt)
        || (state.budget.remainingInputTokens !== null && state.budget.remainingInputTokens < imageInputTokens(currentPlan)))) break;
      assertActive(state);
      const requestNumber = state.budget.consume({
        providerId: this.openRouter.id || 'openrouter', model: model.id, kind: 'image_generation',
        estimatedInputTokens: imageInputTokens(currentPlan)
      });
      attemptState.count += 1;
      onAttempt({ id: model.id, name: model.name }, attemptState.count);
      const started = Date.now();
      try {
        const { payload } = await this.openRouter.requestJson(`${this.openRouter.baseUrl}/images`, {
          method: 'POST', headers: this.openRouter.headers(), body: JSON.stringify(openRouterImageBody(model, currentPlan)), signal
        }, Math.min(this.requestTimeoutMs, 120000, (state.deadlineAt || Infinity) - Date.now()));
        recordResult(state, requestNumber, { usage: payload?.usage, resolvedModel: payload?.model });
        const images = (Array.isArray(payload?.data) ? payload.data : [])
          .map((item, index) => safeImage(item, index, currentPlan.operation))
          .filter(Boolean);
        if (!images.length) throw new ProviderError('O modelo gratuito não retornou uma imagem raster válida.', {
          providerId: this.id, category: 'availability', code: 'empty_image_response'
        });
        const review = await this.review(images[0], currentPlan, state);
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
          usage: finalUsage(state.ledger, state.budget)
        };
        if (!best || Number(review?.score ?? 101) > Number(best.qualityReview?.score ?? 0)) best = candidateResult;
        if (!review || review.pass) return candidateResult;
        if (currentPlan.retryBudget > 0) currentPlan = refineImagePlan(currentPlan, review);
      } catch (error) {
        recordResult(state, requestNumber, error, { failed: true });
        if (mustStop(error, state)) {
          if (best && !signal?.aborted) return best;
          throw error;
        }
        attempts.push({ model: model.id, message: String(error?.message || 'Falha na geração.').slice(0, 300) });
      }
    }
    return best;
  }

  async generateWithCommunity(plan, originalPrompt, signal, onAttempt, state, attemptState) {
    if (!this.community?.generateImage) return null;
    let currentPlan = plan;
    let best = null;
    for (let round = 0; round < 2; round += 1) {
      if (!state.budget.remaining) break;
      if (best && !signal?.aborted && ((state.deadlineAt && Date.now() >= state.deadlineAt)
        || (state.budget.remainingInputTokens !== null && state.budget.remainingInputTokens < imageInputTokens(currentPlan)))) break;
      assertActive(state);
      attemptState.count += 1;
      const outerAttempt = attemptState.count;
      const before = state.budget.used;
      if (!this.community.handlesRequestBudget) state.budget.consume({
        providerId: this.community.id || 'aihorde-image', model: 'community-auto', kind: 'image_generation',
        estimatedInputTokens: imageInputTokens(currentPlan)
      });
      let result;
      try {
        result = await this.community.generateImage({
          prompt: originalPrompt,
          plan: currentPlan,
          signal, requestBudget: state.budget, usageLedger: state.ledger, deadlineAt: state.deadlineAt,
          onAttempt: model => onAttempt(model, outerAttempt)
        });
        if (!this.community.handlesRequestBudget && state.budget.used > before) recordResult(state, state.budget.used, result);
      } catch (error) {
        if (!this.community.handlesRequestBudget && state.budget.used > before) recordResult(state, state.budget.used, error, { failed: true });
        if (best && !signal?.aborted) return best;
        throw error;
      }
      const review = await this.review(result.generatedImages?.[0], currentPlan, state);
      const candidateResult = {
        ...result,
        content: qualityContent(currentPlan, review, round > 0),
        imagePlan: currentPlan,
        qualityReview: review,
        usage: finalUsage(state.ledger, state.budget)
      };
      if (!best || Number(review?.score ?? 101) > Number(best.qualityReview?.score ?? 0)) best = candidateResult;
      if (!review || review.pass) return candidateResult;
      if (currentPlan.retryBudget <= 0) break;
      currentPlan = refineImagePlan(currentPlan, review);
    }
    return best;
  }

  async generateImage({ prompt, signal, onAttempt = () => {}, requestBudget = null, usageLedger = null, mode = 'balanced', deadlineAt = null, userMemoryContext = '' }) {
    const request = { ...parseImageGenerationRequest(prompt), preferredStyle: imageMemoryStyle(userMemoryContext) };
    if (!String(request.prompt || '').trim()) {
      throw new ProviderError('Descreva a imagem que o Gênesis deve criar.', {
        providerId: this.id, category: 'request', code: 'empty_image_prompt', retryable: false
      });
    }
    const state = {
      budget: requestBudget || new InferenceBudget({ limit: mode === 'fast' ? 2 : mode === 'reasoning' ? 6 : 4 }),
      ledger: usageLedger || createUsageLedger(), mode, signal, deadlineAt
    };
    const attemptState = { count: 0 };
    const failures = [];
    let best = null;
    const finish = result => ({ ...result, attempts: [...(result.attempts || []), ...failures], usage: finalUsage(state.ledger, state.budget) });
    try {
      assertActive(state);
      const plan = await this.plan(request, state);

      if (this.openRouter?.configured) {
        try {
          const result = await this.generateWithOpenRouter(plan, signal, onAttempt, state, attemptState);
          if (result?.qualityReview?.pass || (result && !result.qualityReview)) return finish(result);
          best = result;
          if (result) failures.push({ provider: 'OpenRouter Images', message: 'A validação visual pediu refinamento adicional.' });
        } catch (error) {
          if (mustStop(error, state)) throw error;
          failures.push({ provider: 'OpenRouter Images', message: String(error?.message || 'Falha na rota principal.').slice(0, 300) });
        }
      }

      try {
        const result = await this.generateWithCommunity(plan, prompt, signal, onAttempt, state, attemptState);
        if (result) {
          return finish(best && Number(best.qualityReview?.score || 0) > Number(result.qualityReview?.score ?? 101) ? best : result);
        }
      } catch (error) {
        if (mustStop(error, state) && (!best || signal?.aborted)) throw error;
        failures.push({ provider: 'AI Horde', message: String(error?.message || 'Falha na rede comunitária.').slice(0, 300) });
      }

      if (best) return finish(best);
      if (!state.budget.remaining) state.budget.consume({ providerId: this.id, kind: 'image_generation' });

      const error = new ProviderError('Nenhuma rota gratuita conseguiu produzir uma imagem válida depois do planejamento e dos fallbacks do Genesis Visual Intelligence.', {
        providerId: this.id, category: 'availability', code: 'smart_image_routes_exhausted'
      });
      error.attempts = failures;
      throw error;
    } catch (error) {
      error.usage = finalUsage(state.ledger, state.budget);
      error.attempts ||= failures;
      throw error;
    }
  }
}
