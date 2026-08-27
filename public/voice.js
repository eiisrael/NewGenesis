import { AudioPlaybackController } from './voice/audio-playback.js';
import { VoiceConversationController } from './voice/conversation-controller.js';
import {
  BrowserSpeechInputEngine,
  LocalSpeechInputEngine,
  LocalTextToSpeechEngine,
  readVoiceRuntimeStatus
} from './voice/engines.js';
import { normalizeSpokenText } from './voice/speech-normalizer.js';
import { readVoiceSettings, writeVoiceSettings } from './voice/voice-settings.js';

const composer = document.querySelector('#composerForm');
const input = document.querySelector('#messageInput');
const tools = document.querySelector('.composer-tools');
const messageList = document.querySelector('#messageList');
const ui = {};
let settings = readVoiceSettings();
let composerBaseline = '';
let runtimeStatus = { available: false, stt: {}, tts: {} };

const browserInput = new BrowserSpeechInputEngine();
const localInput = new LocalSpeechInputEngine();
const kokoroTts = new LocalTextToSpeechEngine({ engine: 'kokoro' });
const chatterboxTts = new LocalTextToSpeechEngine({ engine: 'chatterbox' });
const piperTts = new LocalTextToSpeechEngine({ engine: 'piper' });
const playback = new AudioPlaybackController({ kokoro: kokoroTts, chatterbox: chatterboxTts, piper: piperTts });

const controller = new VoiceConversationController({
  settings,
  inputEngines: { browser: browserInput, local: localInput },
  playback,
  submitTranscript: (transcript, detail) => submitTranscript(transcript, detail),
  onInterim: transcript => showTranscript(transcript),
  onState: event => renderState(event),
  onLevel: level => renderMeter(level),
  onStatus: (status, detail) => renderStatus(status, detail),
  onMetric: event => recordMetric(event)
});

const copy = {
  title: 'CONVERSA POR VOZ', microphone: 'Falar uma vez', options: 'Configurações de voz',
  conversation: 'Modo conversa mãos-livres', autoSpeak: 'Ler respostas automaticamente', autoSend: 'Enviar ao terminar de falar',
  preferLocal: 'Preferir voz 100% local', stt: 'Reconhecimento', tts: 'Voz do Genesis', quality: 'Qualidade do Whisper',
  preset: 'Expressividade', voice: 'Voz pt-BR', rate: 'Velocidade', testMic: 'Testar microfone', testVoice: 'Testar voz do Genesis',
  privacyBrowser: 'O fallback de reconhecimento pode usar um serviço do fornecedor do navegador. O áudio de saída usa somente engines locais.',
  privacyLocal: 'Áudio local não é salvo nem incluído na telemetria. Arquivos temporários são apagados após cada transcrição.'
};

function iconMicrophone() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></svg>';
}

function iconSpeaker() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h4l5 4V6l-5 4H5Z"/><path d="M17 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/></svg>';
}

function buildControls() {
  if (!composer || !input || !tools || document.querySelector('#genesisVoiceControl')) return false;
  const wrapper = document.createElement('div');
  wrapper.className = 'genesis-voice-control';
  wrapper.id = 'genesisVoiceControl';
  wrapper.innerHTML = `
    <button class="genesis-voice-button" id="voiceOptionsButton" type="button" aria-expanded="false">${iconSpeaker()}</button>
    <div class="genesis-voice-popover" id="voicePopover" hidden>
      <div class="genesis-voice-heading"><strong>${copy.title}</strong><span id="voiceEngineSummary"></span></div>
      <div class="genesis-voice-live" role="status" aria-live="polite"><span id="voiceStateDot"></span><strong id="voiceStateLabel">Pronto</strong><meter id="voiceMeter" min="0" max="1" value="0" aria-label="Nível do microfone"></meter></div>
      <label class="genesis-voice-option genesis-voice-primary"><span>${copy.conversation}</span><input id="voiceConversationMode" type="checkbox"></label>
      <label class="genesis-voice-option"><span>${copy.autoSpeak}</span><input id="voiceAutoSpeak" type="checkbox"></label>
      <label class="genesis-voice-option"><span>${copy.autoSend}</span><input id="voiceAutoSend" type="checkbox"></label>
      <label class="genesis-voice-option"><span>${copy.preferLocal}</span><input id="voicePreferLocal" type="checkbox"></label>
      <div class="genesis-voice-grid">
        <label class="genesis-voice-field"><span>${copy.stt}</span><select id="voiceSttEngine"><option value="auto">Automático</option><option value="local">Whisper local</option><option value="browser">Navegador</option></select></label>
        <label class="genesis-voice-field"><span>${copy.tts}</span><select id="voiceTtsEngine"><option value="auto">Automático local</option><option value="kokoro">Kokoro-82M pt-BR</option><option value="piper">Piper pt-BR</option><option value="chatterbox">Chatterbox pt-BR</option></select></label>
        <label class="genesis-voice-field"><span>${copy.quality}</span><select id="voiceQuality"><option value="rapid">Rápido</option><option value="balanced">Balanceado</option><option value="accurate">Alta precisão</option></select></label>
        <label class="genesis-voice-field"><span>${copy.preset}</span><select id="voicePreset"><option value="natural">Natural</option><option value="calm">Calmo</option><option value="expressive">Expressivo</option></select></label>
      </div>
      <label class="genesis-voice-field" id="voiceLocalVoiceField"><span>${copy.voice}</span><select id="voiceSelect"><option value="pf_dora">Dora</option><option value="pm_alex">Alex</option><option value="pm_santa">Santa</option></select></label>
      <label class="genesis-voice-field"><span>${copy.rate}: <strong id="voiceRateValue"></strong></span><input id="voiceRate" type="range" min="0.7" max="1.6" step="0.1"></label>
      <div class="genesis-voice-actions"><button id="voiceTestMic" type="button">${copy.testMic}</button><button id="voiceTestSpeech" type="button">${copy.testVoice}</button></div>
      <div class="genesis-voice-status" id="voiceStatus"></div>
      <div class="genesis-voice-note" id="voicePrivacy"></div>
    </div>`;
  tools.insertBefore(wrapper, tools.querySelector('#tokenHint') || null);
  const sendButton = document.querySelector('#sendButton');
  const submitActions = document.createElement('div');
  submitActions.className = 'composer-submit-actions';
  submitActions.innerHTML = `<button class="genesis-voice-button" id="voiceMicButton" type="button" aria-pressed="false">${iconMicrophone()}</button>`;
  sendButton.before(submitActions);
  submitActions.append(sendButton);
  const ids = ['voiceMicButton', 'voiceOptionsButton', 'voicePopover', 'voiceConversationMode', 'voiceAutoSpeak', 'voiceAutoSend', 'voicePreferLocal', 'voiceSttEngine', 'voiceTtsEngine', 'voiceQuality', 'voicePreset', 'voiceSelect', 'voiceLocalVoiceField', 'voiceRate', 'voiceRateValue', 'voiceTestMic', 'voiceTestSpeech', 'voiceStateLabel', 'voiceStateDot', 'voiceMeter', 'voiceStatus', 'voicePrivacy', 'voiceEngineSummary'];
  for (const id of ids) ui[id] = document.querySelector(`#${id}`);
  ui.voiceMicButton.title = copy.microphone;
  ui.voiceMicButton.setAttribute('aria-label', copy.microphone);
  ui.voiceOptionsButton.title = copy.options;
  ui.voiceOptionsButton.setAttribute('aria-label', copy.options);
  return true;
}

function bindControls() {
  ui.voiceMicButton.addEventListener('click', () => {
    composerBaseline = input.value.trim();
    controller.togglePushToTalk().catch(error => renderStatus('error', error));
  });
  ui.voiceOptionsButton.addEventListener('click', event => {
    event.stopPropagation();
    ui.voicePopover.hidden = !ui.voicePopover.hidden;
    ui.voiceOptionsButton.setAttribute('aria-expanded', String(!ui.voicePopover.hidden));
    updateAvailability();
  });
  ui.voiceConversationMode.addEventListener('change', () => {
    settings.conversationMode = ui.voiceConversationMode.checked;
    if (settings.conversationMode) {
      settings.autoSpeak = true;
      settings.autoSend = true;
      ui.voiceAutoSpeak.checked = true;
      ui.voiceAutoSend.checked = true;
    }
    persistSettings();
    composerBaseline = input.value.trim();
    if (settings.conversationMode) controller.startConversation().catch(error => renderStatus('error', error));
    else controller.stopConversation();
  });
  for (const [element, key] of [[ui.voiceAutoSpeak, 'autoSpeak'], [ui.voiceAutoSend, 'autoSend'], [ui.voicePreferLocal, 'preferLocal']]) {
    element.addEventListener('change', () => { settings[key] = element.checked; persistSettings(); updateAvailability(); });
  }
  for (const [element, key] of [[ui.voiceSttEngine, 'sttEngine'], [ui.voiceTtsEngine, 'ttsEngine'], [ui.voiceQuality, 'quality'], [ui.voicePreset, 'preset'], [ui.voiceSelect, 'ttsVoice']]) {
    element.addEventListener('change', () => { settings[key] = element.value; persistSettings(); updateAvailability(); });
  }
  ui.voiceRate.addEventListener('input', () => {
    settings.rate = Number(ui.voiceRate.value) || 1;
    ui.voiceRateValue.textContent = `${settings.rate.toFixed(1)}×`;
    persistSettings();
  });
  ui.voiceTestMic.addEventListener('click', () => {
    composerBaseline = input.value.trim();
    controller.togglePushToTalk().catch(error => renderStatus('error', error));
  });
  ui.voiceTestSpeech.addEventListener('click', () => controller.speakText('Bom dia. O que você gostaria de fazer hoje?'));
  document.addEventListener('click', event => {
    if (!event.target.closest('#genesisVoiceControl')) {
      ui.voicePopover.hidden = true;
      ui.voiceOptionsButton.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      composerBaseline = input.value.trim();
      controller.togglePushToTalk().catch(error => renderStatus('error', error));
    }
    if (event.key === 'Escape' && controller.machine.current !== 'IDLE') controller.stopAll('escape');
  });
}

function hydrateControls() {
  ui.voiceConversationMode.checked = settings.conversationMode;
  ui.voiceAutoSpeak.checked = settings.autoSpeak;
  ui.voiceAutoSend.checked = settings.autoSend;
  ui.voicePreferLocal.checked = settings.preferLocal;
  ui.voiceSttEngine.value = settings.sttEngine;
  ui.voiceTtsEngine.value = settings.ttsEngine;
  ui.voiceQuality.value = settings.quality;
  ui.voicePreset.value = settings.preset;
  ui.voiceSelect.value = settings.ttsVoice;
  ui.voiceRate.value = String(settings.rate);
  ui.voiceRateValue.textContent = `${settings.rate.toFixed(1)}×`;
  ui.voicePrivacy.textContent = `${copy.privacyLocal} ${copy.privacyBrowser}`;
}

function persistSettings() {
  settings = writeVoiceSettings(settings);
  controller.updateSettings(settings);
}

function updateAvailability() {
  const browserSttAvailable = browserInput.available;
  const localSttAvailable = localInput.available;
  const anyStt = settings.preferLocal ? localSttAvailable : browserSttAvailable || localSttAvailable;
  ui.voiceMicButton.disabled = !anyStt || composer.getAttribute('aria-busy') === 'true';
  ui.voiceConversationMode.disabled = !anyStt;
  ui.voiceAutoSpeak.disabled = settings.preferLocal
    ? !(kokoroTts.available || chatterboxTts.available || piperTts.available)
    : !(kokoroTts.available || chatterboxTts.available || piperTts.available);
  for (const option of ui.voiceTtsEngine.options) {
    if (option.value === 'auto') continue;
    option.disabled = !({ kokoro: kokoroTts, piper: piperTts, chatterbox: chatterboxTts }[option.value]?.available);
  }
  ui.voiceLocalVoiceField.hidden = !kokoroTts.available || !['auto', 'kokoro'].includes(settings.ttsEngine);
  ui.voicePreset.closest('.genesis-voice-field').hidden = settings.ttsEngine !== 'chatterbox';
  const localQualityRelevant = localSttAvailable && settings.sttEngine !== 'browser';
  ui.voiceQuality.disabled = !localQualityRelevant || [...ui.voiceQuality.options].filter(option => !option.disabled).length < 2;
  ui.voiceEngineSummary.textContent = engineSummary();
  if (!anyStt) renderStatus('unavailable');
}

function engineSummary() {
  const stt = localInput.available ? 'Whisper local' : browserInput.available ? 'STT navegador' : 'sem STT';
  const tts = kokoroTts.available ? 'Kokoro' : piperTts.available ? 'Piper' : chatterboxTts.available ? 'Chatterbox' : 'sem TTS local';
  return `${stt} · ${tts}`;
}

function renderState(event) {
  const states = {
    IDLE: 'Pronto', LISTENING: 'Ouvindo…', SPEECH_DETECTED: 'Fala detectada', TRANSCRIBING: 'Entendendo…',
    THINKING: 'Genesis está pensando…', SPEAKING: 'Genesis está falando…', INTERRUPTING: 'Interrompido', ERROR: 'Erro de voz'
  };
  ui.voiceStateLabel.textContent = states[event.current] || event.current;
  ui.voiceStateDot.dataset.state = event.current;
  const listening = ['LISTENING', 'SPEECH_DETECTED', 'TRANSCRIBING'].includes(event.current);
  ui.voiceMicButton.classList.toggle('listening', listening);
  ui.voiceMicButton.setAttribute('aria-pressed', String(listening));
  ui.voiceOptionsButton.classList.toggle('speaking', event.current === 'SPEAKING');
  updateAvailability();
}

function renderStatus(status, detail) {
  const messages = {
    idle: '', listening: 'Fale normalmente. O final da frase será detectado automaticamente.',
    'speech-detected': 'Fala detectada; continue falando.', transcribing: 'Transcrevendo localmente…', thinking: 'Mensagem enviada ao chat.',
    speaking: 'A resposta está sendo reproduzida. Você pode interromper falando.', interrupted: 'Reprodução cancelada; ouvindo sua nova pergunta.',
    'no-speech': controller.machine.current === 'LISTENING'
      ? 'Nenhuma fala detectada; o microfone continua ativo por alguns segundos.'
      : 'Nenhuma fala foi detectada.',
    'tts-fallback': detail?.to ? `Engine local indisponível; alternando para ${detail.to}.` : 'Alternando para outro engine local.',
    'quality-adjusted': `Somente o perfil ${detail?.quality || 'disponível'} está instalado; as outras opções foram desativadas.`,
    unavailable: settings.preferLocal ? 'Instale o Whisper para usar o modo 100% local.' : 'Entrada por voz não está disponível neste navegador.',
    'barge-unavailable': 'Interrupção por voz indisponível neste engine.', 'chat-error': 'O chat não concluiu esta resposta.'
  };
  ui.voiceStatus.textContent = status === 'error' ? (detail?.message || 'Falha na camada de voz.') : (messages[status] || '');
}

function renderMeter(level) {
  ui.voiceMeter.value = Math.max(0, Math.min(1, Number(level) || 0));
}

function showTranscript(transcript) {
  const speech = String(transcript || '').trim();
  input.value = [composerBaseline, speech].filter(Boolean).join(composerBaseline && speech ? ' ' : '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submitTranscript(transcript, detail = {}) {
  showTranscript(transcript);
  if (composer.getAttribute('aria-busy') === 'true') return false;
  const accepted = document.dispatchEvent(new CustomEvent('genesis:voice-submit', {
    cancelable: true,
    detail: {
      transcript,
      inputMetadata: {
        inputMode: 'voice',
        sttEngine: detail.engine,
        conversationMode: settings.conversationMode === true,
        responseWillBeSpoken: settings.autoSpeak === true
      }
    }
  }));
  if (!accepted) return false;
  composerBaseline = '';
  return true;
}

function recordMetric(event) {
  fetch('/api/voice/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
    body: JSON.stringify({ name: event.name, at: event.at, detail: event.detail })
  }).catch(() => {});
  document.dispatchEvent(new CustomEvent('genesis:voice', { detail: event }));
}

function decorateMessages() {
  for (const article of messageList?.querySelectorAll('.message.assistant') || []) {
    if (article.dataset.messageId === 'temp-stream') continue;
    const actions = article.querySelector('.message-actions');
    const content = article.querySelector('.message-content');
    if (!actions || !content || actions.querySelector('.genesis-message-speak')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-action-button genesis-message-speak';
    button.innerHTML = `${iconSpeaker()}<span>Ouvir</span>`;
    button.addEventListener('click', () => controller.speakText(normalizeSpokenText(content.textContent)));
    actions.append(button);
  }
}

function bindChat() {
  document.addEventListener('genesis:chat-start', () => controller.onChatStart());
  document.addEventListener('genesis:chat-delta', event => controller.onChatDelta(event.detail?.content));
  document.addEventListener('genesis:chat-end', event => controller.onChatEnd(event.detail?.content));
  document.addEventListener('genesis:chat-error', event => controller.onChatError(event.detail?.error));
  new MutationObserver(decorateMessages).observe(messageList, { childList: true, subtree: true });
  new MutationObserver(updateAvailability).observe(composer, { attributes: true, attributeFilter: ['aria-busy'] });
  decorateMessages();
}

async function loadRuntimeStatus() {
  runtimeStatus = await readVoiceRuntimeStatus();
  localInput.setAvailable(runtimeStatus.stt?.whisper?.available === true);
  chatterboxTts.setAvailable(runtimeStatus.tts?.chatterbox?.available === true);
  piperTts.setAvailable(runtimeStatus.tts?.piper?.available === true);
  kokoroTts.setAvailable(runtimeStatus.tts?.kokoro?.available === true);
  syncWhisperProfiles();
  updateAvailability();
}

function syncWhisperProfiles() {
  const profiles = runtimeStatus.stt?.whisper?.profiles || {};
  const available = [];
  for (const option of ui.voiceQuality.options) {
    const installed = profiles[option.value]?.available === true;
    option.disabled = !installed;
    option.title = installed ? `Modelo ${option.value} instalado.` : `Modelo ${option.value} não instalado.`;
    if (installed) available.push(option.value);
  }
  if (available.length && !available.includes(settings.quality)) {
    settings.quality = available.includes('balanced') ? 'balanced' : available[0];
    ui.voiceQuality.value = settings.quality;
    persistSettings();
    renderStatus('quality-adjusted', { quality: settings.quality });
  }
}

function bootstrapVoice() {
  if (!buildControls()) return;
  settings.conversationMode = false;
  persistSettings();
  hydrateControls();
  bindControls();
  bindChat();
  updateAvailability();
  loadRuntimeStatus();
  window.addEventListener('beforeunload', () => controller.destroy());
  globalThis.__genesisVoice = { controller, runtimeStatus: () => runtimeStatus };
}

bootstrapVoice();
