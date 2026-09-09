# Bluetooth local do Genesis

Abra o Genesis em Chrome ou Edge com suporte a Web Bluetooth, em `localhost` ou HTTPS. Use o botão Bluetooth no topo, escolha o dispositivo no seletor do navegador e autorize a conexão. A descoberta ocorre somente nesse clique. Sem prefixo de nome, o seletor filtra os serviços de bateria, informações e eventual ação configurada; o prefixo permite encontrar dispositivos que não anunciam esses serviços.

O painel consulta bateria, fabricante e modelo quando o dispositivo fornece os serviços GATT padronizados. Estes comandos também funcionam no chat ou em uma transcrição de voz:

- `Bluetooth conectar`: abre o painel; clique em Conectar para autorizar.
- `Bluetooth status`, `Bluetooth bateria`, `Bluetooth informações`.
- `Bluetooth desconectar`, `Bluetooth ajuda`.
- `Bluetooth ler ação`, `Bluetooth executar ação`: operam somente a ação previamente configurada no painel.

Para configurar uma ação BLE, desconecte primeiro e informe nome, UUID completo do serviço, UUID completo da característica e, opcionalmente, de 1 a 20 bytes hexadecimais conforme o protocolo do fabricante. A configuração fica em memória apenas durante a sessão da página. Reconecte para conceder acesso ao serviço. Deixe os bytes vazios para permitir somente leitura. Cada escrita apresenta dispositivo, ação, UUIDs e bytes para confirmação manual; apenas características com escrita GATT com resposta são aceitas. Uma resposta GATT confirma a escrita, não comprova um efeito físico. Falhas de escrita não são repetidas automaticamente, pois o dispositivo pode já ter recebido a ação.

O parser de comandos é determinístico e reconhece a mensagem completa. Modelos de linguagem não definem UUIDs, bytes, permissões nem executam operações Bluetooth. Não há descoberta em segundo plano, polling nem reconexão automática. Leituras e operações BLE não chamam provedores de IA; transcrição e reprodução de voz seguem as engines de voz existentes.

Os comandos enviados pelo chat passam pelo mesmo ciclo de eventos da voz (`genesis:chat-start/end/error`). O navegador publica seu resultado em `POST /api/conversations/:id/device-actions`, com `{ content, inputMetadata?, result: { action, ok, content, deviceName? } }`, e recebe `{ conversation }`. O servidor registra o resultado como relato do cliente, sem conferir ao texto autoridade para executar ferramentas. Operações feitas só pelos botões aparecem no painel. Se a persistência falhar depois de uma operação, o resultado permanece no painel e a ação não é repetida.

Este suporte é para periféricos BLE GATT compatíveis. Não oferece áudio Bluetooth clássico, transferência de arquivos de telefones, controle genérico de computadores ou acesso universal a qualquer dispositivo. Serviços ausentes ou bloqueados pelo navegador são reportados como indisponíveis. Recarregar a página encerra a conexão e remove a configuração da ação; a permissão do site pode continuar no navegador, mas não há reconexão automática. Testes automatizados usam dispositivos simulados; validar o protocolo e o efeito físico requer o hardware real.

Referências primárias consultadas:

- [Chrome: comunicação com dispositivos Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth).
- [MDN: seleção e permissões de dispositivos](https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice).
- [MDN: escrita com resposta GATT](https://developer.mozilla.org/en-US/docs/Web/API/BluetoothRemoteGATTCharacteristic/writeValueWithResponse).

## Verificação reproduzível

Execute `node --test test/bluetooth.test.js test/bluetooth-server.test.js` para testar permissões, cancelamento, leituras, gravação e persistência com dispositivos simulados. O comando `npm run test:browser:bluetooth` usa o mesmo harness CDP do teste de voz, requer Node.js 22+ e Chrome/Edge instalado (ou `CHROME_PATH`) e inicia servidor e perfil de navegador temporários. Ele verifica chat/voz com backend real e BLE simulado, confirmação, cancelamento, Parar, bloqueio de troca de conversa durante operação, recarregamento e layout de 360px. Não solicita microfone, não usa hardware Bluetooth nem chama provedores de texto. As capturas `genesis-bluetooth-smoke.png` e `genesis-bluetooth-panel-mobile.png` ficam na pasta temporária do sistema.
