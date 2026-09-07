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
  const hasReference = Number(currentImages || 0) > 0 || Number(recentImages || 0) > 0;
  const create = /\b(crie|criar|gere|gerar|faca|produza|desenhe|monte|create|generate|draw|make)\b/.test(text);
  const image = /\b(imagem|foto|fotografia|ilustracao|arte|logo|logomarca|banner|icone|capa|wallpaper|picture|photo|image|illustration)\b/.test(text);
  const edit = /\b(edite|editar|altere|alterar|mude|mudar|troque|trocar|substitua|substituir|remova|remover|apague|apagar|adicione|adicionar|transforme|transformar|melhore|melhorar|retoque|retocar|restaure|restaurar|recorte|recortar|amplie|ampliar|aumente|aumentar|redimensione|redimensionar|upscale|enhance|edit|change|replace|remove|add|transform|retouch|restore|resize)\b/.test(text);
  const visualContinuation = /\b(agora|essa|esta|nesta|nessa|ela|fundo|background|cor|cores|estilo|style|realista|realistic|anime|desenho|cartoon|luz|iluminacao|roupa|objeto|personagem)\b/.test(text);
  const analysisOnly = /\b(analise|analisar|descreva|descrever|identifique|identificar|o que tem|explique|explain|analyze|describe|identify)\b/.test(text)
    && !edit && !create;

  if (analysisOnly) return null;
  if (hasReference && (edit || create || visualContinuation)) return 'edit';
  if (create && image) return 'create';
  return null;
}

export function embedImageEditRequest(prompt, references = []) {
  const originalPrompt = cleanPrompt(prompt);
  const safeReferences = references.map(validReference).filter(Boolean).slice(0, 5);
  if (!originalPrompt || !safeReferences.length) return String(prompt || '');
  const payload = JSON.stringify({ operation: 'edit', prompt: originalPrompt, references: safeReferences });
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
      return { operation: 'edit', prompt, references };
    }
  } catch { /* marcador inválido nunca vira referência remota */ }
  return { operation: 'create', prompt: cleanPrompt(text.slice(0, start)), references: [] };
}
