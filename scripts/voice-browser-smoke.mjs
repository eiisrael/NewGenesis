import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function exists(target) {
  return target ? fs.access(target).then(() => true).catch(() => false) : false;
}

async function browserExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        process.env.CHROME_PATH,
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates.filter(Boolean)) if (await exists(candidate)) return candidate;
  throw new Error('Chrome, Chromium ou Edge não encontrado. Defina CHROME_PATH para executar o smoke test de voz.');
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Browser não abriu a porta de depuração em ${timeoutMs}ms.`);
}

async function connectCdp(url) {
  if (typeof WebSocket !== 'function') throw new Error('O smoke test de navegador requer Node.js 22 ou superior.');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result || {});
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  return {
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
    },
    close() { socket.close(); }
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
}

async function waitForExpression(cdp, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`A interface não atingiu o estado esperado: ${expression}`);
}

async function withBrowser(executable, url, initScript, assertions) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-browser-'));
  const browser = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  let cdp = null;
  try {
    const activePort = (await waitForFile(path.join(profile, 'DevToolsActivePort'))).trim().split(/\r?\n/)[0];
    const targets = await (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    assert.ok(page?.webSocketDebuggerUrl, 'uma página CDP deve estar disponível');
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    const errors = [];
    cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
    cdp.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') errors.push('console.error'); });
    cdp.on('Log.entryAdded', event => {
      if (event.entry?.level === 'error') errors.push(`${event.entry.text}${event.entry.url ? ` (${event.entry.url})` : ''}`);
    });
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Log.enable');
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
    await cdp.call('Page.navigate', { url });
    await waitForExpression(cdp, `document.readyState === 'complete' && Boolean(document.querySelector('#genesisVoiceControl'))`);
    await assertions(cdp);
    assert.deepEqual(errors, [], `console/JS sem erros: ${errors.join(' | ')}`);
    await Promise.race([
      cdp.call('Browser.close').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1_000))
    ]);
    cdp.close();
    cdp = null;
  } finally {
    cdp?.close();
    const exited = new Promise(resolve => browser.once('exit', () => resolve(true)));
    if (browser.exitCode === null) browser.kill();
    const closed = browser.exitCode !== null || await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), 3_000))]);
    if (!closed && browser.exitCode === null) {
      browser.kill('SIGKILL');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

const supportedVoice = `
  class FakeRecognition {
    constructor() { window.__genesisRecognition = this; (window.__genesisRecognitions ||= []).push(this); }
    start() { queueMicrotask(() => this.onstart?.()); }
    stop() { queueMicrotask(() => this.onend?.()); }
    abort() { queueMicrotask(() => this.onend?.()); }
  }
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    resume() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 1 }); }
    createBufferSource() {
      const source = {
        playbackRate: { value: 1 }, connect() {}, disconnect() {},
        start() { window.__genesisSource = source; },
        stop() { window.__genesisCancelCount = (window.__genesisCancelCount || 0) + 1; queueMicrotask(() => source.onended?.()); }
      };
      return source;
    }
  }
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeRecognition });
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
  document.addEventListener('genesis:voice-submit', event => {
    (window.__genesisVoiceSubmissions ||= []).push(event.detail);
    event.stopImmediatePropagation();
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (pathname === '/api/voice/status') return Promise.resolve(new Response(JSON.stringify({
      available: true, localOnly: true, stt: { whisper: { available: false, profiles: {} } },
      tts: { kokoro: { available: true, voices: ['pf_dora', 'pm_alex', 'pm_santa'] }, piper: { available: false }, chatterbox: { available: false } }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    if (pathname === '/api/voice/synthesize') {
      window.__genesisTtsRequests = (window.__genesisTtsRequests || 0) + 1;
      if (window.__genesisTtsRequests <= 2) return Promise.resolve({
        ok: false,
        status: 429,
        json: async () => ({ error: { code: 'voice_tts_busy', message: 'O sintetizador local já está gerando outra fala.' } })
      });
      return Promise.resolve(new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    }
    return originalFetch(input, init);
  };
`;

const unsupportedVoice = `
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
`;

if (process.argv[1] === path.resolve(import.meta.filename)) {
  const executable = await browserExecutable();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-browser-root-'));
  const previousPort = process.env.GENESIS_PORT;
  const previousHost = process.env.GENESIS_HOST;
  let runtime;
  try {
    await fs.cp(path.join(projectRoot, 'public'), path.join(root, 'public'), { recursive: true });
    process.env.GENESIS_PORT = String(await freePort());
    process.env.GENESIS_HOST = '127.0.0.1';
    runtime = await startServer(root);
    const url = `http://${runtime.config.host}:${runtime.config.port}`;
    const response = await fetch(url);
    assert.match(response.headers.get('content-security-policy') || '', /style-src 'self'/);
    assert.doesNotMatch(response.headers.get('content-security-policy') || '', /unsafe-inline/);
    assert.match(response.headers.get('permissions-policy') || '', /microphone=\(self\)/);

    await withBrowser(executable, url, supportedVoice, async cdp => {
      const result = await evaluate(cdp, `(async () => {
        const mic = document.querySelector('#voiceMicButton');
        const options = document.querySelector('#voiceOptionsButton');
        const autoSend = document.querySelector('#voiceAutoSend');
        autoSend.checked = false;
        autoSend.dispatchEvent(new Event('change', { bubbles: true }));
        options.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const listening = mic.classList.contains('listening') && mic.getAttribute('aria-pressed') === 'true';
        const indicatorVisible = !document.querySelector('#voiceTurnIndicator').hidden;
        const indicatorState = document.querySelector('#voiceTurnIndicator').dataset.state;
        const indicatorText = document.querySelector('#voiceTurnLabel').textContent;
        const transcript = [{ transcript: 'teste de voz' }]; transcript.isFinal = true;
        window.__genesisRecognition.onresult({ resultIndex: 0, results: [transcript] });
        window.__genesisRecognition.onend();
        await new Promise(resolve => setTimeout(resolve, 0));
        return {
          listening,
          indicatorVisible,
          indicatorState,
          indicatorText,
          transcript: document.querySelector('#messageInput').value,
          styled: getComputedStyle(mic).width === '36px',
          noInlineVoiceStyle: !document.querySelector('style[data-genesis-voice]'),
          popoverOpen: document.querySelector('#voicePopover').hidden === false,
          micLabel: Boolean(mic.getAttribute('aria-label')),
          optionsExpanded: options.getAttribute('aria-expanded') === 'true'
        };
      })()`);
      assert.deepEqual(result, {
        listening: true, indicatorVisible: true, indicatorState: 'LISTENING', indicatorText: 'Gênesis está ouvindo…',
        transcript: 'teste de voz', styled: true, noInlineVoiceStyle: true,
        popoverOpen: true, micLabel: true, optionsExpanded: true
      });

      const conversation = await evaluate(cdp, `(async () => {
        const wait = () => new Promise(resolve => setTimeout(resolve, 0));
        const mode = document.querySelector('#voiceConversationMode');
        mode.checked = true;
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        await wait();
        const firstState = window.__genesisVoice.controller.machine.current;
        let recognition = window.__genesisRecognition;
        recognition.onspeechstart?.();
        const first = [{ transcript: 'explique o SupremeMind' }]; first.isFinal = true;
        recognition.onresult({ resultIndex: 0, results: [first] });
        recognition.onend();
        await wait();
        const thinkingState = window.__genesisVoice.controller.machine.current;
        document.dispatchEvent(new CustomEvent('genesis:chat-start'));
        document.dispatchEvent(new CustomEvent('genesis:chat-delta', { detail: { content: 'O SupremeMind preserva o contexto. ' } }));
        for (let attempt = 0; attempt < 500 && !window.__genesisSource; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!window.__genesisSource) throw new Error('O TTS simulado não iniciou a reprodução.');
        const speakingState = window.__genesisVoice.controller.machine.current;
        document.dispatchEvent(new CustomEvent('genesis:chat-end'));
        window.__genesisSource.onended();
        await wait(); await wait();
        const resumedState = window.__genesisVoice.controller.machine.current;

        window.__genesisSource = undefined;
        document.dispatchEvent(new CustomEvent('genesis:chat-start'));
        document.dispatchEvent(new CustomEvent('genesis:chat-delta', { detail: { content: 'Genesis está falando esta resposta. ' } }));
        for (let attempt = 0; attempt < 500 && !window.__genesisSource; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!window.__genesisSource) throw new Error('O segundo TTS simulado não iniciou a reprodução.');
        recognition = window.__genesisRecognition;
        const cancelBefore = window.__genesisCancelCount || 0;
        recognition.onspeechstart?.();
        const interruptedState = window.__genesisVoice.controller.machine.current;
        const second = [{ transcript: 'nova pergunta agora' }]; second.isFinal = true;
        recognition.onresult({ resultIndex: 0, results: [second] });
        recognition.onend();
        await wait();
        mode.checked = false;
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          firstState, thinkingState, speakingState, resumedState, interruptedState,
          submissions: window.__genesisVoiceSubmissions?.length || 0,
          submittedInputMode: window.__genesisVoiceSubmissions?.[0]?.inputMetadata?.inputMode,
          ttsRetries: window.__genesisVoice.controller.diagnostics().metrics.filter(metric => metric.name === 'voice.tts_retry').length,
          ttsCancelled: (window.__genesisCancelCount || 0) > cancelBefore,
          finalComposer: document.querySelector('#messageInput').value,
          finalState: window.__genesisVoice.controller.machine.current
        };
      })()`);
      assert.deepEqual(conversation, {
        firstState: 'LISTENING', thinkingState: 'THINKING', speakingState: 'SPEAKING', resumedState: 'LISTENING',
        interruptedState: 'SPEECH_DETECTED', submissions: 2, submittedInputMode: 'voice', ttsRetries: 2, ttsCancelled: true,
        finalComposer: 'nova pergunta agora', finalState: 'IDLE'
      });

    });

    await withBrowser(executable, url, unsupportedVoice, async cdp => {
      const result = await evaluate(cdp, `(async () => {
        const input = document.querySelector('#messageInput');
        input.value = 'composer textual funcional';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const mic = document.querySelector('#voiceMicButton');
        mic.click();
        for (let attempt = 0; attempt < 100 && !document.querySelector('.message.assistant'); attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return {
          micDisabled: mic.disabled,
          micAvailable: mic.dataset.available,
          speechDisabled: document.querySelector('#voiceAutoSpeak').disabled,
          inputEnabled: !input.disabled,
          textPreserved: input.value,
          sendEnabled: !document.querySelector('#sendButton').disabled,
          micLabel: Boolean(mic.getAttribute('aria-label')),
          indicatorState: document.querySelector('#voiceTurnIndicator').dataset.state,
          notice: document.querySelector('.message.assistant .message-content')?.textContent || ''
        };
      })()`);
      assert.deepEqual(result, {
        micDisabled: false, micAvailable: 'false', speechDisabled: true, inputEnabled: true,
        textPreserved: 'composer textual funcional', sendEnabled: true, micLabel: true,
        indicatorState: 'ERROR',
        notice: 'Não estou conseguindo ouvir você porque não há um mecanismo de reconhecimento de voz disponível. Verifique o microfone e instale ou habilite uma opção de reconhecimento de voz.'
      });
    });
    console.log('voice browser smoke: ok (conversation + barge-in + degraded)');
  } finally {
    if (runtime) await runtime.shutdown();
    if (previousPort === undefined) delete process.env.GENESIS_PORT; else process.env.GENESIS_PORT = previousPort;
    if (previousHost === undefined) delete process.env.GENESIS_HOST; else process.env.GENESIS_HOST = previousHost;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
