const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4']);

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(value, limit = 3000) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function unique(values, limit = 10) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const text = clean(value, 220);
    const key = fold(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

export function inferImageStyle(prompt) {
  const text = fold(prompt);
  if (/\b(realista|realistico|fotorealista|fotografia|foto real|photoreal|realistic|photograph|cinematic photo)\b/.test(text)) return 'photorealistic';
  if (/\b(anime|manga|ghibli)\b/.test(text)) return 'anime';
  if (/\b(3d|render|pixar|unreal|blender)\b/.test(text)) return '3d';
  if (/\b(logo|logomarca|icone|icon|marca|brand)\b/.test(text)) return 'graphic-design';
  if (/\b(aquarela|watercolor|ilustracao|illustration|desenho|drawing|pintura|painting)\b/.test(text)) return 'illustration';
  return 'general';
}

export function inferImageAspectRatio(prompt) {
  const text = fold(prompt);
  const explicit = text.match(/\b(1\s*:\s*1|16\s*:\s*9|9\s*:\s*16|4\s*:\s*3|3\s*:\s*4|3\s*:\s*2|2\s*:\s*3|4\s*:\s*5|5\s*:\s*4)\b/);
  if (explicit) return explicit[1].replace(/\s+/g, '');
  if (/\b(story|stories|reels?|tiktok|vertical|retrato|portrait)\b/.test(text)) return '9:16';
  if (/\b(banner|capa|youtube|horizontal|paisagem|landscape|widescreen)\b/.test(text)) return '16:9';
  if (/\b(logo|icone|icon|avatar|perfil|quadrad|square)\b/.test(text)) return '1:1';
  return '1:1';
}

function mandatoryHints(prompt) {
  const raw = clean(prompt, 2000);
  const hints = [raw];
  const accessory = raw.match(/\b(?:com|with|wearing|holding|segurando|usando|contendo)\s+([^,.!?;]{2,120})/i);
  if (accessory?.[1]) hints.push(accessory[1]);
  const quoted = [...raw.matchAll(/["“”']([^"“”']{1,80})["“”']/g)].map(match => `texto exato: ${match[1]}`);
  hints.push(...quoted);
  return unique(hints, 6);
}

function stylePrompt(style) {
  if (style === 'photorealistic') return 'Photorealistic professional photography, natural anatomy and proportions, realistic materials and textures, physically plausible lighting, sharp subject detail, believable depth of field.';
  if (style === 'anime') return 'High quality anime illustration, clean linework, coherent anatomy, expressive composition, polished lighting and color design.';
  if (style === '3d') return 'High quality 3D render, coherent geometry, realistic materials, polished global illumination, detailed surfaces and professional composition.';
  if (style === 'graphic-design') return 'Professional graphic design, clean geometry, strong visual hierarchy, intentional typography when requested, balanced negative space and production-ready finish.';
  if (style === 'illustration') return 'Professional illustration, coherent anatomy and perspective, refined shapes, deliberate lighting, polished composition and detailed finish.';
  return 'High quality image, coherent composition, accurate requested objects, clear visual hierarchy, detailed finish and intentional lighting.';
}

function defaultNegative(style) {
  const base = 'blurry, low resolution, low quality, bad anatomy, deformed, malformed, duplicate subject, extra limbs, missing limbs, cropped important object, unreadable text, watermark, signature, jpeg artifacts';
  if (style === 'photorealistic') return `${base}, cartoon, anime, illustration, painting, plastic toy, plush toy, doll, artificial fur, uncanny face`;
  if (style === 'graphic-design') return `${base}, clutter, random mockup, illegible typography, warped letters, accidental gradients`;
  return base;
}

export function fallbackImagePlan(request = {}) {
  const originalPrompt = clean(request.prompt, 2400);
  const style = inferImageStyle(originalPrompt);
  const aspectRatio = inferImageAspectRatio(originalPrompt);
  const mustInclude = mandatoryHints(originalPrompt);
  const operation = request.operation === 'edit' ? 'edit' : 'create';
  const preservation = operation === 'edit'
    ? 'Preserve the identity, pose, framing and all unrequested details from the reference image; change only what the user explicitly requested.'
    : 'Do not omit any concrete subject, accessory, color, count, action or relationship explicitly requested by the user.';
  return {
    operation,
    originalPrompt,
    prompt: clean(`${originalPrompt}. ${preservation} ${stylePrompt(style)} The final image must satisfy the original user request exactly.`, 3400),
    negativePrompt: defaultNegative(style),
    mustInclude,
    style,
    aspectRatio,
    quality: 'high',
    retryBudget: 2,
    references: Array.isArray(request.references) ? request.references.slice(0, 5) : []
  };
}

export function imagePlannerMessages(request = {}) {
  const fallback = fallbackImagePlan(request);
  return [
    {
      role: 'system',
      content: [
        'You are Genesis Visual Planner, the image-planning layer of the SupremeMind agent.',
        'Convert the user request into a precise English prompt for an image model.',
        'Never remove, weaken or reinterpret concrete requirements such as subjects, accessories, counts, colors, actions, written text, realism or composition.',
        'Accessories and relationships introduced by words such as "com" or "with" are mandatory, not optional.',
        'For edits, preserve the reference image identity and every detail the user did not ask to change.',
        'Return ONLY valid JSON with keys: prompt, negativePrompt, mustInclude, style, aspectRatio.',
        'mustInclude must be an array of short, independently visible requirements. aspectRatio must be one of 1:1,16:9,9:16,4:3,3:4,3:2,2:3,4:5,5:4.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({
        operation: fallback.operation,
        originalRequest: fallback.originalPrompt,
        detectedStyle: fallback.style,
        detectedAspectRatio: fallback.aspectRatio,
        localMandatoryHints: fallback.mustInclude
      })
    }
  ];
}

function parseJsonObject(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function parseImagePlanResponse(value, request = {}) {
  const fallback = fallbackImagePlan(request);
  const payload = parseJsonObject(value);
  if (!payload) return fallback;
  const plannedPrompt = clean(payload.prompt, 3000);
  const negativePrompt = clean(payload.negativePrompt, 1400) || fallback.negativePrompt;
  const mustInclude = unique([
    ...fallback.mustInclude,
    ...(Array.isArray(payload.mustInclude) ? payload.mustInclude : [])
  ], 10);
  const aspectRatio = ASPECT_RATIOS.has(String(payload.aspectRatio || '').trim())
    ? String(payload.aspectRatio).trim()
    : fallback.aspectRatio;
  const style = clean(payload.style, 60) || fallback.style;
  const prompt = clean(`${plannedPrompt || fallback.prompt} Mandatory original request: ${fallback.originalPrompt}. Do not omit: ${mustInclude.join('; ')}.`, 3600);
  return {
    ...fallback,
    prompt,
    negativePrompt,
    mustInclude,
    style,
    aspectRatio
  };
}

export function imageCriticMessages(plan, imageDataUrl) {
  return [
    {
      role: 'system',
      content: [
        'You are Genesis Visual Critic. Inspect the generated image against the original user request.',
        'Be strict about concrete visible requirements: subjects, accessories, counts, colors, actions, realism and requested text.',
        'If even one mandatory visible requirement is missing or wrong, pass must be false.',
        'Return ONLY valid JSON: {"pass":boolean,"score":0-100,"missing":string[],"issues":string[],"promptAdjustment":string}.',
        'Do not judge whether the request was a good idea; judge only visual compliance and obvious generation defects.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            originalRequest: plan.originalPrompt,
            mustInclude: plan.mustInclude,
            intendedStyle: plan.style,
            generationPrompt: plan.prompt
          })
        },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]
    }
  ];
}

export function parseImageCriticResponse(value) {
  const payload = parseJsonObject(value);
  if (!payload) return null;
  const score = Math.max(0, Math.min(100, Number(payload.score || 0)));
  const missing = unique(Array.isArray(payload.missing) ? payload.missing : [], 10);
  const issues = unique(Array.isArray(payload.issues) ? payload.issues : [], 10);
  const pass = payload.pass === true && score >= 78 && missing.length === 0;
  return {
    pass,
    score,
    missing,
    issues,
    promptAdjustment: clean(payload.promptAdjustment, 700)
  };
}

export function refineImagePlan(plan, critique = {}) {
  const missing = unique(critique.missing || [], 10);
  const issues = unique(critique.issues || [], 8);
  const correction = clean(critique.promptAdjustment, 700);
  const directives = [
    missing.length ? `CRITICAL MISSING REQUIREMENTS: ${missing.join('; ')}. These must be clearly visible and unambiguous.` : '',
    issues.length ? `CORRECT THESE DEFECTS: ${issues.join('; ')}.` : '',
    correction ? `PROMPT CORRECTION: ${correction}.` : '',
    `Original request remains mandatory: ${plan.originalPrompt}.`
  ].filter(Boolean).join(' ');
  return {
    ...plan,
    prompt: clean(`${directives} ${plan.prompt}`, 3900),
    mustInclude: unique([...plan.mustInclude, ...missing], 12),
    retryBudget: Math.max(0, Number(plan.retryBudget || 0) - 1)
  };
}

function supportedValues(model, name) {
  const source = model?.supportedParameters || model?.supported_parameters;
  if (Array.isArray(source)) return source.includes(name) ? ['supported'] : [];
  const capability = source?.[name];
  return Array.isArray(capability?.values) ? capability.values.map(String) : capability ? ['supported'] : [];
}

export function scoreImageModel(model, plan = {}) {
  const id = fold(`${model?.id || ''} ${model?.name || ''} ${model?.description || ''}`);
  let score = 0;
  const capabilityCount = ['resolution', 'aspect_ratio', 'quality', 'negative_prompt'].filter(name => supportedValues(model, name).length).length;
  score += capabilityCount * 4;
  if (supportedValues(model, 'resolution').some(value => /2k|4k|2048|4096/i.test(value))) score += 12;
  if (supportedValues(model, 'resolution').some(value => /1k|1024/i.test(value))) score += 6;
  if (plan.operation === 'edit' && supportedValues(model, 'input_references').length) score += 30;

  const adherence = [
    ['seedream', 34], ['flux', 32], ['qwen-image', 31], ['qwen image', 31], ['ideogram', 27],
    ['z-image', 26], ['recraft', 20], ['sdxl', 14]
  ];
  for (const [term, value] of adherence) if (id.includes(term)) score += value;

  if (plan.style === 'photorealistic') {
    const photo = [['photo', 28], ['realvis', 30], ['juggernaut', 28], ['albedo', 24], ['realistic', 24], ['realism', 24], ['photon', 20], ['flux', 18], ['seedream', 18]];
    for (const [term, value] of photo) if (id.includes(term)) score += value;
    if (/anime|cartoon|pony|manga/.test(id)) score -= 45;
  }
  if (plan.style === 'anime' && /anime|manga|illustrious|nai/.test(id)) score += 28;
  if (plan.style === 'graphic-design' && /recraft|ideogram|logo|design/.test(id)) score += 28;
  return score;
}

export function scoreCommunityImageModel(model, plan = {}) {
  const name = fold(model?.name || model);
  const workers = Number(model?.count || 0);
  const eta = Number(model?.eta || 0);
  let score = Math.min(28, Math.log2(Math.max(1, workers) + 1) * 7) - Math.min(18, Math.max(0, eta) / 20);
  if (plan.style === 'photorealistic') {
    const boosts = ['real', 'albedo', 'juggernaut', 'dreamshaper', 'photon', 'zavy', 'analog', 'cyber', 'epic', 'photo', 'flux'];
    for (const term of boosts) if (name.includes(term)) score += 18;
    if (/anime|manga|pony|furry|cartoon/.test(name)) score -= 60;
  }
  if (plan.style === 'anime' && /anime|manga|illustrious|pony/.test(name)) score += 30;
  if (/sdxl|xl\b|flux/.test(name)) score += 10;
  return score;
}

export function imageDimensionsForPlan(plan = {}) {
  return ({
    '16:9': { width: 896, height: 512 },
    '9:16': { width: 512, height: 896 },
    '4:3': { width: 768, height: 576 },
    '3:4': { width: 576, height: 768 },
    '3:2': { width: 768, height: 512 },
    '2:3': { width: 512, height: 768 },
    '4:5': { width: 640, height: 800 },
    '5:4': { width: 800, height: 640 },
    '1:1': { width: 768, height: 768 }
  })[plan.aspectRatio] || { width: 768, height: 768 };
}

export function hordePrompt(plan = {}) {
  const positive = clean(plan.prompt || plan.originalPrompt, 3000);
  const negative = clean(plan.negativePrompt, 1200);
  return negative ? `${positive}###${negative}` : positive;
}
