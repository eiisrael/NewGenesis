const STANDARD_SERVICES = ['battery_service', 'device_information'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value, limit = 100) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
}

export function normalizeBluetoothProfile(input) {
  if (!input) return null;
  const service = String(input.service || '').trim().toLowerCase();
  const characteristic = String(input.characteristic || '').trim().toLowerCase();
  const label = cleanText(input.label, 40);
  const writeHex = String(input.writeHex || '').replace(/\s/g, '').toLowerCase();
  if (!UUID.test(service) || !UUID.test(characteristic) || !label) {
    throw new Error('Informe nome da ação e UUIDs completos do serviço e da característica, conforme o fabricante.');
  }
  if (writeHex && (!/^(?:[0-9a-f]{2}){1,20}$/.test(writeHex))) {
    throw new Error('O comando deve conter de 1 a 20 bytes hexadecimais, por exemplo 01 ff.');
  }
  return Object.freeze({ label, service, characteristic, writeHex });
}

function normalizedCommand(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/^(?:oi[, ]+)?genesis[,!: ]+/, '').replace(/[.!?]+$/, '').trim();
}

export function parseBluetoothCommand(content) {
  const text = normalizedCommand(content);
  const commands = {
    status: /^(?:\/?bluetooth status|status (?:do )?bluetooth|qual (?:o )?dispositivo bluetooth(?: esta conectado)?)$/,
    battery: /^(?:\/?bluetooth bateria|(?:leia|ler|consulte|consultar|qual(?: e)?) (?:a )?bateria (?:do )?(?:dispositivo )?bluetooth)$/,
    info: /^(?:\/?bluetooth (?:info|informacoes)|(?:leia|ler|mostre|mostrar) (?:as )?informacoes (?:do )?(?:dispositivo )?bluetooth)$/,
    disconnect: /^(?:\/?bluetooth desconectar|desconecte (?:o )?(?:dispositivo )?bluetooth)$/,
    connect: /^(?:\/?bluetooth conectar|conecte (?:um |o )?(?:dispositivo )?(?:via )?bluetooth)$/,
    'custom-read': /^\/?bluetooth ler acao$/,
    'custom-write': /^\/?bluetooth executar acao$/,
    help: /^(?:\/?bluetooth(?: ajuda)?|(?:ajuda|comandos) (?:do )?bluetooth)$/
  };
  for (const [action, pattern] of Object.entries(commands)) if (pattern.test(text)) return { action };
  // Reserve the explicit slash command; unrecognized instructions cannot reach an LLM executor.
  return /^\/bluetooth\b/.test(text) ? { action: 'help' } : null;
}

export function bluetoothErrorMessage(error) {
  if (error?.name === 'NotFoundError') return 'Dispositivo, serviço ou característica não encontrado. A seleção também pode ter sido cancelada.';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Acesso Bluetooth negado. Use o botão Conectar e autorize o dispositivo no navegador.';
  if (error?.name === 'NetworkError') return 'Conexão Bluetooth perdida ou operação indisponível no dispositivo.';
  if (error?.name === 'AbortError') return 'Operação Bluetooth cancelada.';
  return cleanText(error?.message || 'Não foi possível concluir a operação Bluetooth.', 300);
}

export class GenesisBluetooth {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, secureContext = globalThis.isSecureContext, onChange = () => {}, confirmWrite = async () => false, operationTimeoutMs = 15000 } = {}) {
    this.bluetooth = bluetooth;
    this.secureContext = secureContext === true;
    this.onChange = onChange;
    this.confirmWrite = confirmWrite;
    this.operationTimeoutMs = operationTimeoutMs;
    this.device = null;
    this.server = null;
    this.profile = null;
    this.busy = false;
    this.generation = 0;
    this.disconnected = () => {
      this.generation += 1;
      this.server = null;
      this.onChange(this.status());
    };
  }

  status() {
    return {
      supported: this.secureContext && typeof this.bluetooth?.requestDevice === 'function',
      connected: this.server?.connected === true,
      name: cleanText(this.device?.name) || 'Dispositivo sem nome',
      busy: this.busy,
      profile: this.profile
    };
  }

  setProfile(input) {
    if (this.busy || this.server?.connected) throw new Error('Desconecte o dispositivo antes de alterar a ação.');
    this.profile = normalizeBluetoothProfile(input);
    this.onChange(this.status());
  }

  disconnect() {
    this.generation += 1;
    const device = this.device;
    this.device = null;
    this.server = null;
    device?.removeEventListener('gattserverdisconnected', this.disconnected);
    if (device?.gatt?.connected) device.gatt.disconnect();
    this.onChange(this.status());
  }

  async run(operation) {
    if (this.busy) throw new Error('Aguarde a operação Bluetooth atual terminar.');
    this.busy = true;
    this.onChange(this.status());
    try { return await operation(); }
    finally { this.busy = false; this.onChange(this.status()); }
  }

  async gattOperation(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => {
          this.disconnect();
          reject(new Error('O dispositivo não respondeu a tempo. A conexão Bluetooth foi encerrada.'));
        }, this.operationTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  connect({ namePrefix = '' } = {}) {
    if (!this.status().supported) return Promise.reject(new Error('Bluetooth indisponível neste navegador. Abra o Genesis em Chrome ou Edge com HTTPS ou localhost.'));
    return this.run(async () => {
      this.disconnect();
      const generation = this.generation;
      const services = [...STANDARD_SERVICES, ...(this.profile ? [this.profile.service] : [])];
      const prefix = cleanText(namePrefix, 40);
      const options = {
        filters: prefix ? [{ namePrefix: prefix }] : services.map(service => ({ services: [service] })),
        optionalServices: services
      };
      // Keep requestDevice before the first await: the browser requires a direct user gesture.
      const device = await this.bluetooth.requestDevice(options);
      if (generation !== this.generation) throw new DOMException('Operação Bluetooth cancelada.', 'AbortError');
      if (!device.gatt) throw new Error('Este dispositivo não disponibiliza conexão BLE GATT.');
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.disconnected);
      try {
        const server = await this.gattOperation(device.gatt.connect().then(server => {
          if (generation !== this.generation && server.connected) server.disconnect();
          return server;
        }));
        if (generation !== this.generation) {
          if (server.connected) server.disconnect();
          throw new DOMException('Operação Bluetooth cancelada.', 'AbortError');
        }
        this.server = server;
        return this.status();
      } catch (error) {
        this.disconnect();
        throw error;
      }
    });
  }

  assertConnected(generation = this.generation) {
    if (generation !== this.generation || !this.server?.connected) throw new Error('Conecte um dispositivo no painel Bluetooth para continuar.');
  }

  async read(serviceId, characteristicId, generation) {
    this.assertConnected(generation);
    const service = await this.gattOperation(this.server.getPrimaryService(serviceId));
    this.assertConnected(generation);
    const characteristic = await this.gattOperation(service.getCharacteristic(characteristicId));
    this.assertConnected(generation);
    const value = await this.gattOperation(characteristic.readValue());
    this.assertConnected(generation);
    return value;
  }

  readBattery() {
    return this.run(async () => {
      const value = await this.read('battery_service', 'battery_level', this.generation);
      if (value.byteLength !== 1 || value.getUint8(0) > 100) throw new Error('O dispositivo retornou um nível de bateria inválido.');
      return value.getUint8(0);
    });
  }

  readInfo() {
    return this.run(async () => {
      const generation = this.generation;
      const result = {};
      for (const [key, id] of [['manufacturer', 'manufacturer_name_string'], ['model', 'model_number_string']]) {
        try { result[key] = cleanText(new TextDecoder().decode(await this.read('device_information', id, generation))); }
        catch (error) { if (error?.name !== 'NotFoundError') throw error; }
      }
      this.assertConnected(generation);
      if (!Object.values(result).some(Boolean)) throw new Error('O dispositivo não disponibilizou fabricante ou modelo pelo serviço BLE de informações.');
      return result;
    });
  }

  readAction() {
    return this.run(async () => {
      if (!this.profile) throw new Error('Configure uma ação no painel Bluetooth primeiro.');
      const value = await this.read(this.profile.service, this.profile.characteristic, this.generation);
      return [...new Uint8Array(value.buffer, value.byteOffset, Math.min(value.byteLength, 64))]
        .map(byte => byte.toString(16).padStart(2, '0')).join(' ') + (value.byteLength > 64 ? ' …' : '');
    });
  }

  writeAction({ signal } = {}) {
    return this.run(async () => {
      this.assertConnected();
      const generation = this.generation;
      const profile = this.profile;
      if (!profile?.writeHex) throw new Error('Configure os bytes da ação no painel Bluetooth primeiro.');
      const confirmation = Object.freeze({ ...profile, deviceName: this.status().name });
      if (signal?.aborted || await this.confirmWrite(confirmation, signal) !== true) return { cancelled: true };
      if (signal?.aborted) return { cancelled: true };
      this.assertConnected(generation);
      if (this.profile !== profile) throw new Error('A configuração da ação mudou. Revise a ação novamente.');
      const service = await this.gattOperation(this.server.getPrimaryService(profile.service));
      this.assertConnected(generation);
      const characteristic = await this.gattOperation(service.getCharacteristic(profile.characteristic));
      this.assertConnected(generation);
      if (signal?.aborted) return { cancelled: true };
      if (!characteristic.properties?.write || typeof characteristic.writeValueWithResponse !== 'function') {
        throw new Error('A característica não suporta escrita com confirmação GATT.');
      }
      const bytes = Uint8Array.from(profile.writeHex.match(/../g), value => parseInt(value, 16));
      // Never retry a physical action: an error may occur after the device received it.
      try {
        await this.gattOperation(characteristic.writeValueWithResponse(bytes));
        this.assertConnected(generation);
      }
      catch { throw new Error('Não foi possível confirmar a escrita. O dispositivo pode ter recebido a ação; verifique seu estado antes de tentar novamente.'); }
      return { cancelled: false, label: profile.label };
    });
  }
}
