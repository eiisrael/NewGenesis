export const VOICE_STORAGE_KEY = 'genesis:voice:v2';

export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  conversationMode: false,
  autoSpeak: false,
  autoSend: true,
  preferLocal: false,
  sttEngine: 'auto',
  ttsEngine: 'auto',
  quality: 'balanced',
  preset: 'natural',
  voiceURI: '',
  rate: 1,
  vadThreshold: 0.018,
  vadSilenceMs: 700
});

const enums = Object.freeze({
  sttEngine: ['auto', 'local', 'browser'],
  ttsEngine: ['auto', 'chatterbox', 'piper', 'browser'],
  quality: ['rapid', 'balanced', 'accurate'],
  preset: ['natural', 'calm', 'expressive']
});

export function sanitizeVoiceSettings(value = {}) {
  const result = { ...DEFAULT_VOICE_SETTINGS };
  for (const key of ['conversationMode', 'autoSpeak', 'autoSend', 'preferLocal']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const [key, choices] of Object.entries(enums)) {
    if (choices.includes(value[key])) result[key] = value[key];
  }
  result.voiceURI = String(value.voiceURI || '').slice(0, 500);
  result.rate = clamp(value.rate, 0.7, 1.6, 1);
  result.vadThreshold = clamp(value.vadThreshold, 0.006, 0.08, DEFAULT_VOICE_SETTINGS.vadThreshold);
  result.vadSilenceMs = clamp(value.vadSilenceMs, 350, 1600, DEFAULT_VOICE_SETTINGS.vadSilenceMs);
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
