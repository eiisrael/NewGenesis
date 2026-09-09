export const VOICE_STORAGE_KEY = 'genesis:voice:v2';

export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  conversationMode: false,
  autoSpeak: false,
  autoSend: true,
  preferLocal: false,
  sttEngine: 'auto',
  ttsEngine: 'auto',
  quality: 'rapid',
  adaptiveQuality: true,
  preset: 'natural',
  ttsVoice: 'pf_dora',
  rate: 1,
  vadThreshold: 0.009,
  vadSilenceMs: 650
});

const enums = Object.freeze({
  sttEngine: ['auto', 'local', 'browser'],
  ttsEngine: ['auto', 'system', 'kokoro', 'piper', 'chatterbox'],
  quality: ['rapid', 'balanced', 'accurate'],
  preset: ['natural', 'calm', 'expressive']
});

export function sanitizeVoiceSettings(value = {}) {
  const result = { ...DEFAULT_VOICE_SETTINGS };
  for (const key of ['conversationMode', 'autoSpeak', 'autoSend', 'preferLocal', 'adaptiveQuality']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const [key, choices] of Object.entries(enums)) {
    if (choices.includes(value[key])) result[key] = value[key];
  }
  result.ttsVoice = ['pf_dora', 'pm_alex', 'pm_santa'].includes(value.ttsVoice) ? value.ttsVoice : DEFAULT_VOICE_SETTINGS.ttsVoice;
  result.rate = clamp(value.rate, 0.7, 1.6, 1);
  const storedVadThreshold = Number(value.vadThreshold);
  // 0.018 era o padrão da versão anterior e ficou persistido no localStorage.
  // Migrá-lo evita que usuários existentes continuem presos ao limiar antigo mesmo
  // depois da correção do VAD. Valores realmente personalizados são preservados.
  result.vadThreshold = Number.isFinite(storedVadThreshold) && Math.abs(storedVadThreshold - 0.018) < 0.000001
    ? DEFAULT_VOICE_SETTINGS.vadThreshold
    : clamp(value.vadThreshold, 0.006, 0.08, DEFAULT_VOICE_SETTINGS.vadThreshold);
  result.vadSilenceMs = clamp(value.vadSilenceMs, 300, 1600, DEFAULT_VOICE_SETTINGS.vadSilenceMs);
  return result;
}

export function readVoiceSettings(storage = globalThis.localStorage) {
  try {
    const current = storage?.getItem(VOICE_STORAGE_KEY);
    if (current) return sanitizeVoiceSettings(JSON.parse(current));
    const legacy = JSON.parse(storage?.getItem('genesis:voice') || '{}');
    return sanitizeVoiceSettings({ ...legacy, conversationMode: false });
  }
  catch { return { ...DEFAULT_VOICE_SETTINGS }; }
}

export function writeVoiceSettings(settings, storage = globalThis.localStorage) {
  const safe = sanitizeVoiceSettings(settings);
  storage?.setItem(VOICE_STORAGE_KEY, JSON.stringify(safe));
  return safe;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
