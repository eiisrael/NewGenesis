import { GenesisBluetooth, bluetoothErrorMessage } from './bluetooth.js';

export function createBluetoothPanel() {
  const get = id => document.getElementById(id);
  const panel = get('bluetoothDialog');
  const confirmation = get('bluetoothConfirmDialog');
  const output = get('bluetoothOutput');
  let pendingConfirmation = null;

  const finishConfirmation = accepted => {
    const pending = pendingConfirmation;
    pendingConfirmation = null;
    if (confirmation.open) confirmation.close();
    pending?.(accepted);
  };

  const driver = new GenesisBluetooth({
    onChange: status => {
      get('bluetoothStatus').textContent = !status.supported
        ? 'Bluetooth indisponível aqui. Use Chrome ou Edge com HTTPS ou localhost.'
        : status.connected ? `Conectado: ${status.name}` : status.busy ? 'Conectando ou executando…' : 'Nenhum dispositivo conectado';
      get('bluetoothConnect').disabled = !status.supported || status.busy;
      get('bluetoothDisconnect').disabled = !status.connected && !status.busy;
      for (const id of ['bluetoothBattery', 'bluetoothInfo']) get(id).disabled = !status.connected || status.busy;
      get('bluetoothReadAction').disabled = !status.connected || status.busy || !status.profile;
      get('bluetoothWriteAction').disabled = !status.connected || status.busy || !status.profile?.writeHex;
      for (const id of ['bluetoothSaveAction', 'bluetoothClearAction']) get(id).disabled = status.connected || status.busy;
      get('bluetoothActionStatus').textContent = status.profile ? `Ação da sessão: ${status.profile.label}` : 'Nenhuma ação configurada';
      get('bluetoothToggle').classList.toggle('bluetooth-connected', status.connected);
      if (!status.connected) finishConfirmation(false);
    },
    confirmWrite: (request, signal) => new Promise(resolve => {
      if (signal?.aborted) { resolve(false); return; }
      get('bluetoothConfirmDetail').textContent = [
        `Dispositivo: ${request.deviceName}`,
        `Ação: ${request.label}`,
        `Serviço: ${request.service}`,
        `Característica: ${request.characteristic}`,
        `Bytes: ${request.writeHex.match(/../g).join(' ')}`,
        'Esta escrita pode alterar o dispositivo. Confirme somente se a ação corresponde ao protocolo do fabricante.'
      ].join('\n');
      const abort = () => finishConfirmation(false);
      pendingConfirmation = accepted => { signal?.removeEventListener('abort', abort); resolve(accepted); };
      signal?.addEventListener('abort', abort, { once: true });
      confirmation.showModal();
    })
  });

  const open = () => { if (!panel.open) panel.showModal(); };
  const execute = async (command, { signal } = {}) => {
    const action = command.action;
    let content;
    let ok = true;
    const cancelRead = () => driver.disconnect();
    const reading = ['battery', 'info', 'custom-read'].includes(action);
    if (reading) signal?.addEventListener('abort', cancelRead, { once: true });
    try {
      if (signal?.aborted) throw new DOMException('Operação Bluetooth cancelada.', 'AbortError');
      if (action === 'connect') {
        open();
        content = 'Clique em Conectar no painel Bluetooth e selecione seu dispositivo BLE. O navegador exige essa escolha presencial antes de permitir a conexão.';
      } else if (action === 'status') {
        const status = driver.status();
        content = !status.supported ? 'Bluetooth indisponível neste navegador. Use Chrome ou Edge com HTTPS ou localhost.'
          : status.connected ? `Bluetooth conectado a ${status.name}.` : 'Nenhum dispositivo Bluetooth conectado. Abra o botão Bluetooth para conectar.';
      } else if (action === 'disconnect') {
        finishConfirmation(false);
        driver.disconnect();
        content = 'Conexão Bluetooth encerrada.';
      } else if (action === 'battery') {
        content = `Bateria de ${driver.status().name}: ${await driver.readBattery()}%.`;
      } else if (action === 'info') {
        const info = await driver.readInfo();
        content = [driver.status().name, info.manufacturer && `Fabricante: ${info.manufacturer}`, info.model && `Modelo: ${info.model}`].filter(Boolean).join('\n');
      } else if (action === 'custom-read') {
        const value = await driver.readAction();
        content = `Leitura da ação ${driver.profile.label} (hexadecimal): ${value || '(vazio)'}.`;
      } else if (action === 'custom-write') {
        const result = await driver.writeAction({ signal });
        ok = !result.cancelled;
        content = result.cancelled ? 'Ação Bluetooth cancelada, sem envio de bytes.'
          : `Escrita da ação ${result.label} confirmada pelo serviço GATT. Confira no dispositivo o efeito físico da ação.`;
      } else {
        content = 'Comandos locais: “Bluetooth conectar”, “Bluetooth status”, “Bluetooth bateria”, “Bluetooth informações” e “Bluetooth desconectar”. Para uma ação configurada no painel: “Bluetooth ler ação” ou “Bluetooth executar ação”. A escrita pede confirmação presencial. Leituras e ações Bluetooth não consomem cota de modelos; o dispositivo precisa oferecer os serviços BLE correspondentes.';
      }
    } catch (error) { ok = false; content = bluetoothErrorMessage(error); }
    finally { if (reading) signal?.removeEventListener('abort', cancelRead); }
    output.textContent = content;
    return { action, ok, content, deviceName: driver.status().connected ? driver.status().name : undefined };
  };

  get('bluetoothToggle').addEventListener('click', open);
  get('bluetoothClose').addEventListener('click', () => panel.close());
  get('bluetoothConfirmCancel').addEventListener('click', () => finishConfirmation(false));
  get('bluetoothConfirmAccept').addEventListener('click', () => finishConfirmation(true));
  confirmation.addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
  confirmation.addEventListener('close', () => { if (!confirmation.open) finishConfirmation(false); });
  get('bluetoothConnect').addEventListener('click', () => {
    // Do not defer this call: requestDevice must run inside this click's activation.
    driver.connect({ namePrefix: get('bluetoothNamePrefix').value })
      .then(status => { output.textContent = `Conectado a ${status.name}. Consulte a bateria ou as informações abaixo.`; })
      .catch(error => { output.textContent = bluetoothErrorMessage(error); });
  });
  for (const [id, action] of Object.entries({ bluetoothDisconnect: 'disconnect', bluetoothBattery: 'battery', bluetoothInfo: 'info', bluetoothReadAction: 'custom-read', bluetoothWriteAction: 'custom-write' })) {
    get(id).addEventListener('click', () => execute({ action }));
  }
  get('bluetoothSaveAction').addEventListener('click', () => {
    try {
      driver.setProfile({ label: get('bluetoothActionLabel').value, service: get('bluetoothService').value, characteristic: get('bluetoothCharacteristic').value, writeHex: get('bluetoothWriteHex').value });
      output.textContent = 'Ação configurada nesta sessão. Conecte o dispositivo para autorizar o serviço.';
    } catch (error) { output.textContent = bluetoothErrorMessage(error); }
  });
  get('bluetoothClearAction').addEventListener('click', () => {
    try {
      driver.setProfile(null);
      for (const id of ['bluetoothActionLabel', 'bluetoothService', 'bluetoothCharacteristic', 'bluetoothWriteHex']) get(id).value = '';
      output.textContent = 'Ação removida desta sessão.';
    } catch (error) { output.textContent = bluetoothErrorMessage(error); }
  });
  window.addEventListener('pagehide', () => { finishConfirmation(false); driver.disconnect(); });
  driver.onChange(driver.status());
  return { open, execute };
}
