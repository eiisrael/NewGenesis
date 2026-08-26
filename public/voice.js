const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const synthesis = window.speechSynthesis || null;
const composer = document.querySelector('#composerForm');
const input = document.querySelector('#messageInput');
const tools = document.querySelector('.composer-tools');
const messageList = document.querySelector('#messageList');

const STORAGE_KEY = 'genesis:voice';
const state = {
  recognition: null,
  listening: false,
  baseline: '',
  finalTranscript: '',
  interimTranscript: '',
  autoSpeak: false,
  autoSend: true,
  voiceURI: '',
  rate: 1,
  speakingToken: 0,
  wasBusy: false
};

const labels = {
  'pt-BR': {
    microphone: 'Conversar por voz', stopMicrophone: 'Parar microfone', voice: 'Opções de voz',
    listening: 'Ouvindo…', unsupportedRecognition: 'Entrada por voz não está disponível neste navegador.',
    unsupportedSpeech: 'Leitura em voz alta não está disponível neste navegador.',
    autoSpeak: 'Ler respostas automaticamente', autoSend: 'Enviar ao terminar de falar',
    voiceLabel: 'Voz do Genesis', rate: 'Velocidade', privacy: 'O áudio do microfone é processado pelo recurso de reconhecimento do navegador. Dependendo do navegador, esse reconhecimento pode usar um serviço online.',
    listen: 'Ouvir', stop: 'Parar voz', defaultVoice: 'Voz padrão do sistema', noVoices: 'Nenhuma voz disponível',
    permission: 'Não foi possível acessar o microfone. Verifique a permissão do navegador.',
    noSpeech: 'Não consegui detectar fala. Tente novamente.', title: 'VOZ', speechReady: 'Voz do Genesis ativa'
  },
  'en-US': {
    microphone: 'Talk by voice', stopMicrophone: 'Stop microphone', voice: 'Voice options',
    listening: 'Listening…', unsupportedRecognition: 'Voice input is not available in this browser.',
    unsupportedSpeech: 'Text-to-speech is not available in this browser.',
    autoSpeak: 'Read responses automatically', autoSend: 'Send when I stop speaking',
    voiceLabel: 'Genesis voice', rate: 'Speed', privacy: 'Microphone audio is processed by the browser speech-recognition feature. Depending on the browser, recognition may use an online service.',
    listen: 'Listen', stop: 'Stop voice', defaultVoice: 'System default voice', noVoices: 'No voices available',
    permission: 'Microphone access failed. Check the browser permission.',
    noSpeech: 'No speech was detected. Try again.', title: 'VOICE', speechReady: 'Genesis voice enabled'
  }
};

function lang() {
  return document.documentElement.lang === 'en-US' ? 'en-US' : 'pt-BR';
}

function t(key) {
  return labels[lang()][key] || labels['pt-BR'][key] || key;
}

function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.autoSpeak = saved.autoSpeak === true;
    state.autoSend = saved.autoSend !== false;
    state.voiceURI = String(saved.voiceURI || '');
    const rate = Number(saved.rate);
    state.rate = Number.isFinite(rate) ? Math.min(1.6, Math.max(0.7, rate)) : 1;
  } catch { /* preferências padrão */ }
}

function savePreferences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    autoSpeak: state.autoSpeak,
    autoSend: state.autoSend,
    voiceURI: state.voiceURI,
    rate: state.rate
  }));
}

function iconMicrophone() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></svg>';
}

function iconSpeaker() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h4l5 4V6l-5 4H5Z"/><path d="M17 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/></svg>';
}

function buildControls() {
  if (!composer || !input || !tools || document.querySelector('#genesisVoiceControl')) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'genesis-voice-control';
  wrapper.id = 'genesisVoiceControl';
  wrapper.innerHTML = `
    <button class="genesis-voice-button" id="voiceMicButton" type="button" aria-pressed="false">${iconMicrophone()}</button>
    <button class="genesis-voice-button" id="voiceOptionsButton" type="button" aria-expanded="false">${iconSpeaker()}</button>
    <div class="genesis-voice-popover" id="voicePopover" hidden>
      <div class="genesis-voice-heading"><strong data-voice-label="title"></strong><span data-voice-status></span></div>
      <label class="genesis-voice-option"><span data-voice-label="autoSpeak"></span><input id="voiceAutoSpeak" type="checkbox"></label>
      <label class="genesis-voice-option"><span data-voice-label="autoSend"></span><input id="voiceAutoSend" type="checkbox"></label>
      <label class="genesis-voice-field"><span data-voice-label="voiceLabel"></span><select id="voiceSelect"></select></label>
      <label class="genesis-voice-field"><span><span data-voice-label="rate"></span>: <strong id="voiceRateValue"></strong></span><input id="voiceRate" type="range" min="0.7" max="1.6" step="0.1"></label>
      <div class="genesis-voice-status" id="voiceStatus"></div>
      <div class="genesis-voice-note" data-voice-label="privacy"></div>
    </div>`;
  const tokenHint = tools.querySelector('#tokenHint');
  tools.insertBefore(wrapper, tokenHint || null);
  updateLabels();

  const mic = document.querySelector('#voiceMicButton');
  const options = document.querySelector('#voiceOptionsButton');
  const popover = document.querySelector('#voicePopover');
  const autoSpeak = document.querySelector('#voiceAutoSpeak');
  const autoSend = document.querySelector('#voiceAutoSend');
  const select = document.querySelector('#voiceSelect');
  const rate = document.querySelector('#voiceRate');

  autoSpeak.checked = state.autoSpeak;
  autoSend.checked = state.autoSend;
  rate.value = String(state.rate);
  document.querySelector('#voiceRateValue').textContent = `${state.rate.toFixed(1)}×`;

  mic.addEventListener('click', toggleListening);
  options.addEventListener('click', event => {
    event.stopPropagation();
    popover.hidden = !popover.hidden;
    options.setAttribute('aria-expanded', String(!popover.hidden));
    populateVoices();
  });
  autoSpeak.addEventListener('change', () => { state.autoSpeak = autoSpeak.checked; savePreferences(); });
  autoSend.addEventListener('change', () => { state.autoSend = autoSend.checked; savePreferences(); });
  select.addEventListener('change', () => { state.voiceURI = select.value; savePreferences(); });
  rate.addEventListener('input', () => {
    state.rate = Number(rate.value) || 1;
    document.querySelector('#voiceRateValue').textContent = `${state.rate.toFixed(1)}×`;
    savePreferences();
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#genesisVoiceControl')) {
      popover.hidden = true;
      options.setAttribute('aria-expanded', 'false');
    }
  });
  updateAvailability();
}

function updateLabels() {
  document.querySelectorAll('[data-voice-label]').forEach(element => {
    element.textContent = t(element.dataset.voiceLabel);
  });
  const mic = document.querySelector('#voiceMicButton');
  const options = document.querySelector('#voiceOptionsButton');
  if (mic) {
    mic.title = state.listening ? t('stopMicrophone') : t('microphone');
    mic.setAttribute('aria-label', mic.title);
  }
  if (options) {
    options.title = t('voice');
    options.setAttribute('aria-label', t('voice'));
  }
}

function updateAvailability() {
  const mic = document.querySelector('#voiceMicButton');
  const autoSpeak = document.querySelector('#voiceAutoSpeak');
  const voiceSelect = document.querySelector('#voiceSelect');
  const status = document.querySelector('#voiceStatus');
  if (mic) mic.disabled = !Recognition || composer?.getAttribute('aria-busy') === 'true';
  if (autoSpeak) autoSpeak.disabled = !synthesis;
  if (voiceSelect) voiceSelect.disabled = !synthesis;
  if (status) status.textContent = !Recognition
    ? t('unsupportedRecognition')
    : !synthesis ? t('unsupportedSpeech') : '';
}

function populateVoices() {
  const select = document.querySelector('#voiceSelect');
  if (!select) return;
  const voices = synthesis?.getVoices?.() || [];
  const preferredLanguage = lang().toLowerCase();
  const sorted = [...voices].sort((a, b) => {
    const aPreferred = String(a.lang || '').toLowerCase().startsWith(preferredLanguage.slice(0, 2));
    const bPreferred = String(b.lang || '').toLowerCase().startsWith(preferredLanguage.slice(0, 2));
    return Number(bPreferred) - Number(aPreferred) || a.name.localeCompare(b.name);
  });
  select.innerHTML = `<option value="">${t('defaultVoice')}</option>${sorted.map(voice => `<option value="${escapeAttribute(voice.voiceURI)}">${escapeText(voice.name)} · ${escapeText(voice.lang)}</option>`).join('')}`;
  if (state.voiceURI && sorted.some(voice => voice.voiceURI === state.voiceURI)) select.value = state.voiceURI;
}

function escapeText(value) {
  const span = document.createElement('span');
  span.textContent = String(value || '');
  return span.innerHTML;
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

function chosenVoice() {
  const voices = synthesis?.getVoices?.() || [];
  if (state.voiceURI) {
    const exact = voices.find(voice => voice.voiceURI === state.voiceURI);
    if (exact) return exact;
  }
  const wanted = lang().toLowerCase();
  return voices.find(voice => String(voice.lang || '').toLowerCase() === wanted)
    || voices.find(voice => String(voice.lang || '').toLowerCase().startsWith(wanted.slice(0, 2)))
    || null;
}

function setVoiceStatus(message = '') {
  const status = document.querySelector('#voiceStatus');
  if (status) status.textContent = message;
}

function stopSpeaking() {
  state.speakingToken += 1;
  synthesis?.cancel?.();
  document.querySelector('#voiceOptionsButton')?.classList.remove('speaking');
  document.querySelectorAll('.genesis-message-speak.speaking').forEach(button => button.classList.remove('speaking'));
}

function readableText(contentElement) {
  if (!contentElement) return '';
  const clone = contentElement.cloneNode(true);
  clone.querySelectorAll('pre,.code-block').forEach(block => {
    const replacement = document.createElement('p');
    replacement.textContent = lang() === 'en-US' ? 'Code block omitted.' : 'Bloco de código omitido.';
    block.replaceWith(replacement);
  });
  clone.querySelectorAll('button,svg').forEach(element => element.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 16000);
}

function speechChunks(text) {
  const sentences = String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const next = `${current} ${sentence}`.trim();
    if (next.length > 1400 && current) {
      chunks.push(current);
      current = sentence.trim();
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

function speakElement(contentElement, button = null) {
  if (!synthesis) return setVoiceStatus(t('unsupportedSpeech'));
  const text = readableText(contentElement);
  if (!text) return;
  stopListening({ preserveText: true });
  stopSpeaking();
  const token = ++state.speakingToken;
  const voice = chosenVoice();
  const chunks = speechChunks(text);
  if (!chunks.length) return;
  const optionsButton = document.querySelector('#voiceOptionsButton');
  optionsButton?.classList.add('speaking');
  button?.classList.add('speaking');
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = voice?.lang || lang();
    utterance.rate = state.rate;
    if (voice) utterance.voice = voice;
    if (index === chunks.length - 1) utterance.onend = () => {
      if (token !== state.speakingToken) return;
      optionsButton?.classList.remove('speaking');
      button?.classList.remove('speaking');
    };
    utterance.onerror = () => {
      if (token !== state.speakingToken) return;
      optionsButton?.classList.remove('speaking');
      button?.classList.remove('speaking');
    };
    synthesis.speak(utterance);
  });
}

function stopListening({ preserveText = true } = {}) {
  if (!state.recognition) return;
  if (!preserveText && input) input.value = state.baseline;
  try { state.recognition.stop(); } catch { /* já encerrado */ }
}

function toggleListening() {
  if (state.listening) return stopListening({ preserveText: true });
  if (!Recognition) return setVoiceStatus(t('unsupportedRecognition'));
  if (composer?.getAttribute('aria-busy') === 'true') return;
  stopSpeaking();
  state.baseline = input.value.trim();
  state.finalTranscript = '';
  state.interimTranscript = '';
  const recognition = new Recognition();
  state.recognition = recognition;
  recognition.lang = lang();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    state.listening = true;
    const mic = document.querySelector('#voiceMicButton');
    mic?.classList.add('listening');
    mic?.setAttribute('aria-pressed', 'true');
    setVoiceStatus(t('listening'));
    updateLabels();
  };
  recognition.onresult = event => {
    let finalText = '';
    let interimText = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = String(event.results[index]?.[0]?.transcript || '').trim();
      if (event.results[index].isFinal) finalText += `${transcript} `;
      else interimText += `${transcript} `;
    }
    if (finalText.trim()) state.finalTranscript = `${state.finalTranscript} ${finalText}`.trim();
    state.interimTranscript = interimText.trim();
    const speech = `${state.finalTranscript} ${state.interimTranscript}`.trim();
    input.value = [state.baseline, speech].filter(Boolean).join(state.baseline && speech ? ' ' : '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  recognition.onerror = event => {
    if (event.error === 'no-speech') setVoiceStatus(t('noSpeech'));
    else if (!['aborted'].includes(event.error)) setVoiceStatus(t('permission'));
  };
  recognition.onend = () => {
    const transcript = state.finalTranscript.trim();
    state.listening = false;
    state.recognition = null;
    const mic = document.querySelector('#voiceMicButton');
    mic?.classList.remove('listening');
    mic?.setAttribute('aria-pressed', 'false');
    updateLabels();
    updateAvailability();
    if (transcript) setVoiceStatus('');
    if (transcript && state.autoSend && composer?.getAttribute('aria-busy') !== 'true') {
      queueMicrotask(() => composer.requestSubmit());
    }
  };
  try { recognition.start(); }
  catch { setVoiceStatus(t('permission')); }
}

function decorateMessages() {
  if (!messageList) return;
  messageList.querySelectorAll('.message.assistant').forEach(article => {
    if (article.dataset.messageId === 'temp-stream') return;
    const actions = article.querySelector('.message-actions');
    const content = article.querySelector('.message-content');
    if (!actions || !content || actions.querySelector('.genesis-message-speak')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-action-button genesis-message-speak';
    button.dataset.voiceMessageId = article.dataset.messageId || '';
    button.innerHTML = `${iconSpeaker()}<span>${t('listen')}</span>`;
    button.addEventListener('click', () => {
      if (button.classList.contains('speaking')) stopSpeaking();
      else speakElement(content, button);
    });
    actions.append(button);
  });
}

function latestAssistantContent() {
  const articles = [...(messageList?.querySelectorAll('.message.assistant') || [])]
    .filter(article => article.dataset.messageId !== 'temp-stream');
  return articles.at(-1)?.querySelector('.message-content') || null;
}

function observeConversation() {
  if (!composer || !messageList) return;
  state.wasBusy = composer.getAttribute('aria-busy') === 'true';
  new MutationObserver(() => decorateMessages()).observe(messageList, { childList: true, subtree: true });
  new MutationObserver(() => {
    const busy = composer.getAttribute('aria-busy') === 'true';
    if (busy) {
      stopListening({ preserveText: true });
      if (state.autoSpeak) stopSpeaking();
    }
    if (state.wasBusy && !busy && state.autoSpeak) {
      queueMicrotask(() => {
        const content = latestAssistantContent();
        if (content) speakElement(content);
      });
    }
    state.wasBusy = busy;
    updateAvailability();
  }).observe(composer, { attributes: true, attributeFilter: ['aria-busy'] });
  new MutationObserver(() => {
    updateLabels();
    populateVoices();
    decorateMessages();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  decorateMessages();
}

function bindKeyboard() {
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      toggleListening();
    }
    if (event.key === 'Escape' && state.listening) stopListening({ preserveText: true });
  });
}

function bootstrapVoice() {
  if (!composer || !input || !tools) return;
  readPreferences();
  buildControls();
  populateVoices();
  if (synthesis) synthesis.addEventListener?.('voiceschanged', populateVoices);
  observeConversation();
  bindKeyboard();
  window.addEventListener('beforeunload', () => {
    stopListening({ preserveText: true });
    stopSpeaking();
  });
}

bootstrapVoice();
