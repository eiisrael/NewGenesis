const IMAGE_REQUEST_START = '[[GENESIS_IMAGE_REQUEST_V1]]';
const IMAGE_REQUEST_END = '[[/GENESIS_IMAGE_REQUEST_V1]]';
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]*={0,2}$/;

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanPrompt(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function validReference(value) {
  const dataUrl = String(value || '').trim();
  if (!IMAGE_DATA_URL.test(dataUrl)) return '';
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (encoded.length > 12 * 1024 * 1024) return '';
  return dataUrl;
}

export function classifyImageRequest(query, { currentImages = 0, recentImages = 0 } = {}) {
  const text = fold(query);
  const hasCurrentReference = Number(currentImages || 0) > 0;
  const hasReference = hasCurrentReference || Number(recentImages || 0) > 0;
  const create = /\b(crie|criar|gere|gerar|faca|produza|desenhe|monte|create|generate|draw|make)\b/.test(text);
  const image = /\b(imagem|foto|fotografia|ilustracao|arte|logo|logomarca|banner|icone|capa|wallpaper|picture|photo|image|illustration)\b/.test(text);
  const edit = /\b(edite|editar|altere|alterar|mude|mudar|troque|trocar|substitua|substituir|remova|remover|apague|apagar|adicione|adicionar|transforme|transformar|melhore|melhorar|retoque|retocar|restaure|restaurar|recorte|recortar|amplie|ampliar|aumente|aumentar|redimensione|redimensionar|upscale|enhance|edit|change|replace|remove|add|transform|retouch|restore|resize)\b/.test(text);
  const visualContinuation = /\b(fundo|background|cor|cores|estilo|style|realista|realistic|anime|desenho|cartoon|luz|iluminacao|roupa|objeto|personagem|rosto|enquadramento|nitidez)\b/.test(text);
  const refersToImage = /\b(essa|esta|nessa|nesta|mesma|dessa|desta)\s+(imagem|foto|arte|ilustracao)|\b(mesm[oa] (personagem|pessoa|rosto|cachorro|gato)|a partir d[ae]|referencia|outra versao|variacao)\b/.test(text);
  const unrelated = /\b(codigo|funcao|script|documento|assunto|bluetooth|arquivo|planilha|email)\b/.test(text)
    || /\b(meu|minha|esse|essa|este|esta)\s+(texto|mensagem|resposta)\b/.test(text);
  const modification = /\b(deixe|torne|agora|mais|menos|make|more|less)\b/.test(text);
  const newImage = /\b(nova imagem|outra imagem|do zero|sem referencia|new image|from scratch)\b/.test(text);
  const analysisOnly = /\b(analise|analisar|descreva|descrever|identifique|identificar|o que tem|explique|explain|analyze|describe|identify)\b/.test(text)
    && !edit && !create;

  if (analysisOnly) return null;
  if (create && image && (newImage || (!hasCurrentReference && !refersToImage))) return 'create';
  if (hasReference && !unrelated && (edit || (create && refersToImage) || (modification && (refersToImage || visualContinuation)))) return 'edit';
  if (hasCurrentReference && create && image) return 'edit';
  if (create && image) return 'create';
  return null;
}

function imageContext(value) {
  if (!value || typeof value !== 'object') return null;
  const originalPrompt = cleanPrompt(value.originalPrompt).slice(0, 1000);
  const style = ['photorealistic', 'anime', '3d', 'graphic-design', 'illustration', 'general'].includes(value.style) ? value.style : '';
  const aspectRatio = /^(?:1:1|16:9|9:16|4:3|3:4|3:2|2:3|4:5|5:4)$/.test(String(value.aspectRatio)) ? value.aspectRatio : '';
  return originalPrompt || style || aspectRatio ? { originalPrompt, style, aspectRatio } : null;
}

export function embedImageEditRequest(prompt, references = [], context = null) {
  const originalPrompt = cleanPrompt(prompt);
  const safeReferences = references.map(validReference).filter(Boolean).slice(0, 5);
  if (!originalPrompt || !safeReferences.length) return String(prompt || '');
  const sourceContext = imageContext(context);
  const payload = JSON.stringify({ operation: 'edit', prompt: originalPrompt, references: safeReferences, ...(sourceContext ? { sourceContext } : {}) });
  return `Crie uma imagem editada usando a referência fornecida e siga exatamente o pedido do usuário. ${originalPrompt}\n${IMAGE_REQUEST_START}${payload}${IMAGE_REQUEST_END}`;
}

export function parseImageGenerationRequest(value) {
  const text = String(value || '').trim();
  const start = text.indexOf(IMAGE_REQUEST_START);
  const end = text.indexOf(IMAGE_REQUEST_END, start + IMAGE_REQUEST_START.length);
  if (start < 0 || end < 0) {
    return { operation: 'create', prompt: cleanPrompt(text), references: [] };
  }
  const raw = text.slice(start + IMAGE_REQUEST_START.length, end);
  try {
    const payload = JSON.parse(raw);
    const references = Array.isArray(payload?.references)
      ? payload.references.map(validReference).filter(Boolean).slice(0, 5)
      : [];
    const prompt = cleanPrompt(payload?.prompt || text.slice(0, start));
    if (payload?.operation === 'edit' && prompt && references.length) {
      const sourceContext = imageContext(payload.sourceContext);
      return { operation: 'edit', prompt, references, ...(sourceContext ? { sourceContext } : {}) };
    }
  } catch { /* marcador inválido nunca vira referência remota */ }
  return { operation: 'create', prompt: cleanPrompt(text.slice(0, start)), references: [] };
}
