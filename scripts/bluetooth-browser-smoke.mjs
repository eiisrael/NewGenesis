import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { browserExecutable, freePort, evaluate, waitForExpression, withBrowser } from './voice-browser-smoke.mjs';

const setup = `
  localStorage.setItem('genesis:configTourSkipped', '1');
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
  window.__writes = [];
  window.__remoteChatCalls = 0;
  window.__bleStarted = 0;
  window.__bleEnded = 0;
  window.__chooserCalls = 0;
  document.addEventListener('genesis:chat-start', () => window.__bleStarted++);
  document.addEventListener('genesis:chat-end', () => window.__bleEnded++);
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (/\\/messages$/.test(url.pathname) && init?.method === 'POST') window.__remoteChatCalls++;
    return originalFetch(input, init);
  };
`;
const ble = `
  const device = new EventTarget();
  device.name = 'Sensor de teste';
  let rejectRead;
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    disconnect() { this.connected = false; rejectRead?.(new DOMException('Desconectado', 'NetworkError')); device.dispatchEvent(new Event('gattserverdisconnected')); },
    async getPrimaryService() { return { async getCharacteristic(id) { return {
      properties: { write: true },
      async readValue() {
        if (window.__blockRead) return new Promise((_, reject) => { rejectRead = reject; window.__readStarted = true; });
        const bytes = id === 'battery_level' ? Uint8Array.of(81) : new TextEncoder().encode(id === 'manufacturer_name_string' ? 'Laboratório' : 'Modelo BLE');
        return new DataView(bytes.buffer);
      },
      async writeValueWithResponse(bytes) { window.__writes.push([...bytes]); }
    }; } }; }
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: {
    async requestDevice() { window.__chooserCalls++; if (window.__cancelChooser) throw new DOMException('Cancelado', 'NotFoundError'); return device; }
  } });
`;

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-bluetooth-smoke-'));
let runtime;
try {
  await fs.cp(path.resolve(import.meta.dirname, '../public'), path.join(root, 'public'), { recursive: true });
  process.env.GENESIS_HOST = '127.0.0.1';
  process.env.GENESIS_PORT = String(await freePort());
  runtime = await startServer(root);
  const url = `http://${runtime.config.host}:${runtime.config.port}`;
  const executable = await browserExecutable();
  await withBrowser(executable, url, setup + ble, async cdp => {
    await waitForExpression(cdp, `document.querySelector('#conversationCount').textContent !== '0'`);
    assert.equal(await evaluate(cdp, `document.querySelector('#bluetoothConnect').disabled`), false);
    await evaluate(cdp, `document.querySelector('#bluetoothToggle').click(); window.__cancelChooser = true; document.querySelector('#bluetoothConnect').click()`);
    await waitForExpression(cdp, `document.querySelector('#bluetoothOutput').textContent.includes('cancelada')`);
    await evaluate(cdp, `window.__cancelChooser = false; document.querySelector('#bluetoothConnect').click()`);
    await waitForExpression(cdp, `document.querySelector('#bluetoothStatus').textContent.includes('Conectado:')`);
    await evaluate(cdp, `document.querySelector('#bluetoothBattery').click()`);
    await waitForExpression(cdp, `document.querySelector('#bluetoothOutput').textContent.includes('81%')`);
    await evaluate(cdp, `document.querySelector('#bluetoothClose').click(); document.querySelector('#messageInput').value = 'Bluetooth bateria'; document.querySelector('#composerForm').requestSubmit()`);
    await waitForExpression(cdp, `window.__bleEnded === 1`);
    assert.match(await evaluate(cdp, `document.querySelector('.message.assistant .message-content').textContent`), /81%/);
    await evaluate(cdp, `document.dispatchEvent(new CustomEvent('genesis:voice-submit', { detail: { transcript: 'Bluetooth informações', inputMetadata: { inputMode: 'voice' } } }))`);
    await waitForExpression(cdp, `window.__bleEnded === 2`);
    assert.match(await evaluate(cdp, `[...document.querySelectorAll('.message.assistant .message-content')].at(-1).textContent`), /Laboratório/);
    await evaluate(cdp, `document.querySelector('#bluetoothToggle').click(); document.querySelector('#bluetoothDisconnect').click(); document.querySelector('#bluetoothActionLabel').value = 'Indicador'; document.querySelector('#bluetoothService').value = '12345678-1234-1234-1234-1234567890ab'; document.querySelector('#bluetoothCharacteristic').value = '12345678-1234-1234-1234-1234567890ac'; document.querySelector('#bluetoothWriteHex').value = '01 ff'; document.querySelector('#bluetoothSaveAction').click(); document.querySelector('#bluetoothConnect').click()`);
    await waitForExpression(cdp, `document.querySelector('#bluetoothWriteAction').disabled === false`);
    await evaluate(cdp, `document.querySelector('#bluetoothWriteAction').click()`);
    await waitForExpression(cdp, `document.querySelector('#bluetoothConfirmDialog').open`);
    assert.match(await evaluate(cdp, `document.querySelector('#bluetoothConfirmDetail').textContent`), /Bytes: 01 ff/);
    await evaluate(cdp, `document.querySelector('#bluetoothConfirmCancel').click()`);
    await waitForExpression(cdp, `document.querySelector('#bluetoothWriteAction').disabled === false`);
    assert.deepEqual(await evaluate(cdp, `window.__writes`), []);
    await evaluate(cdp, `document.querySelector('#bluetoothWriteAction').click(); document.querySelector('#bluetoothConfirmAccept').click()`);
    await waitForExpression(cdp, `window.__writes.length === 1`);
    assert.deepEqual(await evaluate(cdp, `window.__writes`), [[1, 255]]);
    await waitForExpression(cdp, `document.querySelector('#bluetoothWriteAction').disabled === false`);
    await evaluate(cdp, `document.querySelector('#bluetoothWriteAction').click(); document.querySelector('#bluetoothConfirmDialog').close()`);
    await waitForExpression(cdp, `document.querySelector('#bluetoothWriteAction').disabled === false`);
    assert.equal(await evaluate(cdp, `window.__writes.length`), 1);
    await evaluate(cdp, `document.querySelector('#bluetoothClose').click(); window.__blockRead = true; document.querySelector('#messageInput').value = 'Bluetooth bateria'; document.querySelector('#composerForm').requestSubmit()`);
    await waitForExpression(cdp, `window.__readStarted === true`);
    const blockedNavigation = await evaluate(cdp, `(() => {
      const before = document.querySelector('#conversationCount').textContent;
      const conversationId = localStorage.getItem('genesis:lastConversation');
      window.__confirmCalls = 0;
      window.confirm = () => { window.__confirmCalls++; return false; };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'O', ctrlKey: true, shiftKey: true, bubbles: true }));
      document.querySelector('[data-delete-id]').click();
      document.dispatchEvent(new CustomEvent('genesis:voice-submit', { detail: { transcript: 'Bluetooth bateria' } }));
      return { sameCount: document.querySelector('#conversationCount').textContent === before, sameConversation: localStorage.getItem('genesis:lastConversation') === conversationId, confirmations: window.__confirmCalls, starts: window.__bleStarted };
    })()`);
    assert.deepEqual(blockedNavigation, { sameCount: true, sameConversation: true, confirmations: 0, starts: 3 });
    await evaluate(cdp, `document.querySelector('#sendButton').click()`);
    await waitForExpression(cdp, `window.__bleEnded === 3 && document.querySelector('#composerForm').getAttribute('aria-busy') === 'false'`);
    assert.equal(await evaluate(cdp, `window.__remoteChatCalls`), 0);
    assert.equal(await evaluate(cdp, `window.__bleStarted`), 3);
    const conversations = await (await fetch(url + '/api/conversations')).json();
    assert.ok(conversations);
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(os.tmpdir(), 'genesis-bluetooth-smoke.png'), Buffer.from(screenshot.data, 'base64'));
    await cdp.call('Page.reload');
    await waitForExpression(cdp, `document.readyState === 'complete' && document.querySelector('#bluetoothActionStatus')?.textContent === 'Nenhuma ação configurada' && document.querySelectorAll('.message.assistant').length === 3`);
    assert.match(await evaluate(cdp, `document.querySelector('#bluetoothStatus').textContent`), /Nenhum dispositivo conectado/);
    assert.equal(await evaluate(cdp, `window.__chooserCalls`), 0);
  });
  await withBrowser(executable, url, setup + `Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: undefined });`, async cdp => {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
    await evaluate(cdp, `document.querySelector('#bluetoothToggle').click()`);
    assert.equal(await evaluate(cdp, `document.querySelector('#bluetoothConnect').disabled`), true);
    assert.match(await evaluate(cdp, `document.querySelector('#bluetoothStatus').textContent`), /indisponível/);
    assert.equal(await evaluate(cdp, `document.querySelector('#messageInput').disabled`), false);
    const panelScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(os.tmpdir(), 'genesis-bluetooth-panel-mobile.png'), Buffer.from(panelScreenshot.data, 'base64'));
    await evaluate(cdp, `document.querySelector('#bluetoothClose').click()`);
    assert.equal(await evaluate(cdp, `document.querySelector('#bluetoothDialog').open`), false);
    const clippedButtons = await evaluate(cdp, `[...document.querySelectorAll('.topbar button')].filter(button => { const rect = button.getBoundingClientRect(); return rect.width && (rect.left < 0 || rect.right > innerWidth); }).map(button => button.id)`);
    assert.deepEqual(clippedButtons, [], 'todos os controles do topo devem caber na tela de 360px');
    const headerScreenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(os.tmpdir(), 'genesis-bluetooth-header-mobile.png'), Buffer.from(headerScreenshot.data, 'base64'));
  });
  console.log('Bluetooth browser smoke PASS: BLE mock, chat/voice endpoint, zero model calls, custom approval/cancel/close, pending read stop, navigation guard, reload, unsupported, mobile360, console clean.');
} finally {
  if (runtime) await runtime.shutdown();
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('genesis-bluetooth-smoke-')) throw new Error('Invalid temp root');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

