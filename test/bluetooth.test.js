import test from 'node:test';
import assert from 'node:assert/strict';
import { GenesisBluetooth, normalizeBluetoothProfile, parseBluetoothCommand } from '../public/bluetooth.js';

const PROFILE = {
  label: 'Indicador',
  service: '12345678-1234-1234-1234-1234567890ab',
  characteristic: '12345678-1234-1234-1234-1234567890ac',
  writeHex: '01 ff'
};

function fixture(options = {}) {
  const writes = [];
  const requests = [];
  const device = new EventTarget();
  device.name = 'Indicador BLE';
  const characteristic = {
    properties: { write: true },
    async readValue() { return new DataView(Uint8Array.of(75).buffer); },
    async writeValueWithResponse(bytes) { writes.push([...bytes]); },
    ...options.characteristic
  };
  const service = { async getCharacteristic() { return characteristic; }, ...options.service };
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
    async getPrimaryService() { return service; },
    ...options.gatt
  };
  const bluetooth = { async requestDevice(request) { requests.push(request); return device; }, ...options.bluetooth };
  const driver = new GenesisBluetooth({ bluetooth, secureContext: true, confirmWrite: options.confirmWrite, operationTimeoutMs: options.operationTimeoutMs });
  return { driver, device, characteristic, writes, requests };
}

test('Bluetooth: ausência da API ou contexto inseguro não tenta descoberta', async () => {
  let calls = 0;
  for (const config of [{ bluetooth: {}, secureContext: true }, { bluetooth: { requestDevice() { calls += 1; } }, secureContext: false }]) {
    const driver = new GenesisBluetooth(config);
    assert.equal(driver.status().supported, false);
    await assert.rejects(driver.connect(), /indisponível/);
  }
  assert.equal(calls, 0);
});

test('Bluetooth: seletor solicita apenas serviços configurados e mantém o gesto síncrono', async () => {
  const { driver, requests } = fixture();
  driver.setProfile(PROFILE);
  const connecting = driver.connect();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].filters, ['battery_service', 'device_information', PROFILE.service].map(service => ({ services: [service] })));
  assert.equal(requests[0].acceptAllDevices, undefined);
  await connecting;
  assert.equal(driver.status().connected, true);
});

test('Bluetooth: filtro por nome inclui permissões opcionais dos serviços', async () => {
  const { driver, requests } = fixture();
  await driver.connect({ namePrefix: 'Indicador' });
  assert.deepEqual(requests[0].filters, [{ namePrefix: 'Indicador' }]);
  assert.deepEqual(requests[0].optionalServices, ['battery_service', 'device_information']);
});

test('Bluetooth: cancelamento do seletor libera estado ocupado', async () => {
  const { driver } = fixture({ bluetooth: { async requestDevice() { throw new DOMException('Cancelado', 'NotFoundError'); } } });
  await assert.rejects(driver.connect(), { name: 'NotFoundError' });
  assert.equal(driver.status().busy, false);
  assert.equal(driver.status().connected, false);
});

test('Bluetooth: desconectar durante seletor impede conexão tardia', async () => {
  let choose;
  const { driver, device } = fixture({ bluetooth: { requestDevice() { return new Promise(resolve => { choose = resolve; }); } } });
  const pending = driver.connect();
  driver.disconnect();
  choose(device);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(device.gatt.connected, false);
});

test('Bluetooth: bateria lida e queda de conexão invalida acesso posterior', async () => {
  const { driver, device } = fixture();
  await driver.connect();
  assert.equal(await driver.readBattery(), 75);
  device.gatt.disconnect();
  assert.equal(driver.status().connected, false);
  await assert.rejects(driver.readBattery(), /Conecte/);
});

test('Bluetooth: nível de bateria inválido é rejeitado', async () => {
  const { driver } = fixture({ characteristic: { async readValue() { return new DataView(Uint8Array.of(255).buffer); } } });
  await driver.connect();
  await assert.rejects(driver.readBattery(), /inválido/);
});

test('Bluetooth: dados do fabricante e modelo usam características padronizadas', async () => {
  const { driver } = fixture({ service: { async getCharacteristic(id) {
    return { async readValue() { return new DataView(new TextEncoder().encode(id === 'manufacturer_name_string' ? 'Fabricante' : 'Modelo A').buffer); } };
  } } });
  await driver.connect();
  assert.deepEqual(await driver.readInfo(), { manufacturer: 'Fabricante', model: 'Modelo A' });
});

test('Bluetooth: informações indisponíveis são reportadas sem inventar resultado', async () => {
  const { driver } = fixture({ gatt: { async getPrimaryService() { throw new DOMException('Ausente', 'NotFoundError'); } } });
  await driver.connect();
  await assert.rejects(driver.readInfo(), /não disponibilizou/);
});

test('Bluetooth: validação da ação impede UUIDs inválidos e payload excessivo', () => {
  assert.deepEqual(normalizeBluetoothProfile(PROFILE), { ...PROFILE, writeHex: '01ff' });
  assert.equal(normalizeBluetoothProfile(null), null);
  for (const changed of [{ service: 'battery_service' }, { characteristic: 'invalid' }, { label: '' }, { writeHex: 'f' }, { writeHex: 'gg' }, { writeHex: 'ff'.repeat(21) }]) {
    assert.throws(() => normalizeBluetoothProfile({ ...PROFILE, ...changed }));
  }
});

test('Bluetooth: uma ação precisa de confirmação explícita e envia somente bytes configurados', async () => {
  let review;
  const { driver, writes } = fixture({ confirmWrite: async value => { review = value; return true; } });
  driver.setProfile(PROFILE);
  await driver.connect();
  assert.equal((await driver.writeAction()).cancelled, false);
  assert.equal(review.deviceName, 'Indicador BLE');
  assert.equal(review.writeHex, '01ff');
  assert.equal(Object.isFrozen(review), true);
  assert.deepEqual(writes, [[1, 255]]);
  assert.throws(() => driver.setProfile({ ...PROFILE, writeHex: '02' }), /Desconecte/);
});

test('Bluetooth: falta de confirmação ou recusa nunca envia bytes', async () => {
  for (const confirmWrite of [undefined, async () => false, async () => 'true']) {
    const { driver, writes } = fixture({ confirmWrite });
    driver.setProfile(PROFILE);
    await driver.connect();
    assert.deepEqual(await driver.writeAction(), { cancelled: true });
    assert.equal(writes.length, 0);
  }
});

test('Bluetooth: desconexão e cancelamento durante confirmação bloqueiam escrita', async () => {
  for (const mode of ['disconnect', 'abort']) {
    const controller = new AbortController();
    const { driver, writes } = fixture({ confirmWrite: async () => {
      if (mode === 'disconnect') driver.disconnect();
      else controller.abort();
      return true;
    } });
    driver.setProfile(PROFILE);
    await driver.connect();
    if (mode === 'disconnect') await assert.rejects(driver.writeAction(), /Conecte/);
    else assert.deepEqual(await driver.writeAction({ signal: controller.signal }), { cancelled: true });
    assert.equal(writes.length, 0);
  }
});

test('Bluetooth: escrita sem confirmação GATT é recusada e falha não causa retry', async () => {
  let attempts = 0;
  for (const characteristic of [{ properties: { write: false } }, { async writeValueWithResponse() { attempts += 1; throw new DOMException('Perda de conexão', 'NetworkError'); } }]) {
    const { driver, writes } = fixture({ characteristic, confirmWrite: async () => true });
    driver.setProfile(PROFILE);
    await driver.connect();
    await assert.rejects(driver.writeAction(), /confirma|confirmar/);
    assert.equal(writes.length, 0);
  }
  assert.equal(attempts, 1);
});

test('Bluetooth: ação de leitura respeita offset do DataView', async () => {
  const { driver } = fixture({ characteristic: { async readValue() { return new DataView(Uint8Array.of(99, 1, 255, 99).buffer, 1, 2); } } });
  driver.setProfile({ ...PROFILE, writeHex: '' });
  await driver.connect();
  assert.equal(await driver.readAction(), '01 ff');
  await assert.rejects(driver.writeAction(), /Configure os bytes/);
});

test('Bluetooth: serializa operações GATT para impedir ações concorrentes', async () => {
  let finish;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const { driver } = fixture({ characteristic: { readValue() { return new Promise(resolve => { finish = resolve; notifyStarted(); }); } } });
  await driver.connect();
  const pending = driver.readBattery();
  await started;
  await assert.rejects(driver.readBattery(), /Aguarde/);
  finish(new DataView(Uint8Array.of(40).buffer));
  assert.equal(await pending, 40);
});

test('Bluetooth: GATT sem resposta libera a operação e encerra conexão', async () => {
  const { driver } = fixture({ operationTimeoutMs: 10, characteristic: { readValue() { return new Promise(() => {}); } } });
  await driver.connect();
  await assert.rejects(driver.readBattery(), /não respondeu a tempo/);
  assert.equal(driver.status().busy, false);
  assert.equal(driver.status().connected, false);
});

test('Bluetooth: conexão que termina após timeout é desconectada', async () => {
  let complete;
  const { driver, device } = fixture({ operationTimeoutMs: 10, gatt: { connect() { return new Promise(resolve => { complete = () => { this.connected = true; resolve(this); }; }); } } });
  await assert.rejects(driver.connect(), /não respondeu a tempo/);
  complete();
  await Promise.resolve();
  assert.equal(driver.status().connected, false);
  assert.equal(device.gatt.connected, false);
});

test('Bluetooth: comandos de chat e voz são completos, explícitos e não aceitam bytes', () => {
  for (const [text, action] of [['Bluetooth bateria', 'battery'], ['Gênesis, leia a bateria do dispositivo Bluetooth.', 'battery'], ['/bluetooth status', 'status'], ['Bluetooth informações', 'info'], ['Conecte um dispositivo via Bluetooth', 'connect'], ['Bluetooth executar ação', 'custom-write'], ['Bluetooth ler ação', 'custom-read']]) {
    assert.deepEqual(parseBluetoothCommand(text), { action });
  }
  for (const text of ['Como funciona Bluetooth?', 'Não desconecte o bluetooth', 'Bluetooth executar ação 01ff', 'Explique o comando Bluetooth bateria', 'Bluetooth desconectar e apagar arquivos']) assert.equal(parseBluetoothCommand(text), null);
  assert.deepEqual(parseBluetoothCommand('/bluetooth write 01ff'), { action: 'help' });
});
