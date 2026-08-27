# Arquitetura de voz e contexto local

## Fluxo de voz

`public/voice.js` compõe a UI; a execução é separada em:

- `VoiceConversationController`: turno, autoenvio, retomada, streaming, STT vazio recuperável e barge-in;
- `VoiceStateMachine`: `IDLE`, `LISTENING`, `SPEECH_DETECTED`, `TRANSCRIBING`, `THINKING`, `SPEAKING`, `INTERRUPTING` e `ERROR`;
- `MicrophoneAudioInput` + `AdaptiveEnergyVad`: `AudioWorklet` primário, fallback explícito, pre-roll, VAD adaptativo e WAV mono 16 kHz;
- `BrowserSpeechInputEngine`: fallback de entrada com `SpeechRecognition`;
- `LocalSpeechInputEngine`: envia somente o utterance WAV ao servidor loopback;
- `AudioPlaybackController`: fila sequencial, preparação limitada ao próximo trecho, cancelamento imediato e fallback exclusivamente local;
- `LocalTextToSpeechEngine`: prepara, decodifica e toca Kokoro, Piper ou Chatterbox;
- `speech-normalizer`: normalização pt-BR, chunking em fronteiras estáveis e filtro de possível retorno acústico;
- `VoiceRuntime`: `whisper-server` e workers JSONL TTS persistentes, limites, temporários e shutdown.

O chat emite `genesis:chat-start`, `genesis:chat-delta`, `genesis:chat-end` e `genesis:chat-error`. Somente trechos estáveis entram na fila. Barge-in percorre `SPEAKING → INTERRUPTING → SPEECH_DETECTED` e cancela reprodução, fetches e fila.

## Processos locais

| Engine | Processo | Persistência | Fallback |
| --- | --- | --- | --- |
| whisper.cpp 1.8.6 | `whisper-server.exe` em porta loopback aleatória | modelo permanece carregado | CLI por requisição se o servidor falhar |
| Kokoro-82M | `tts-server.py --engine kokoro` | modelo, pipeline e eSpeak permanecem carregados | outro TTS local disponível |
| Piper 1.4.2 | `tts-server.py --engine piper` | `PiperVoice` permanece carregada | outro TTS local disponível |
| Chatterbox | `tts-server.py --engine chatterbox` | modelo permanece carregado | outro TTS local disponível |

Kokoro é a primeira opção automática por ter vozes oficiais pt-BR e licença Apache-2.0. Piper permanece como opção leve. Chatterbox continua experimental e pesado. TTS de navegador foi removido do fluxo normal.

O worker JSONL força UTF-8 na entrada e na saída. Isso é obrigatório no Windows: herdar uma página de código legada corrompe acentos antes do G2P (por exemplo, `você` pode virar mojibake e produzir nomes audíveis de símbolos). A voz é carregada antes da semente determinística do Kokoro, tornando a primeira síntese equivalente às seguintes. O WAV final remove somente silêncio externo, preserva até 15 ms no início e 55 ms no fim e usa 40 ms entre chunks internos.

O `AudioContext` é criado e retomado durante a interação do usuário, antes da espera pela síntese fria. O controlador rejeita cliques manuais concorrentes e não usa outro sintetizador para mascarar falhas de saída de áudio. A captura descarta streams cujo track já terminou e solicita novamente o dispositivo, inclusive com constraints básicas quando o navegador rejeita as preferenciais.

O binário Windows oficial instalado do whisper.cpp é CPU. A Radeon RX 460 anunciar Vulkan não prova aceleração do Whisper; o upstream exige build `GGML_VULKAN=ON`, e não havia toolchain auditado nem binário oficial equivalente nesta validação. CPU continua sendo o baseline suportado.

## Contexto local

`src/local-context.js` valida timezone, locale e a cidade declarada na conversa, resolve data/hora deterministicamente e encapsula geocodificação e clima. A geolocalização do navegador foi desativada: o Genesis usa uma cidade e estado/país explicitamente informados e pode reutilizar a última cidade declarada na conversa. As coordenadas resolvidas pelo provedor são somente um detalhe interno da consulta meteorológica e nunca são exibidas, persistidas ou tratadas como GPS do usuário.

O serviço de clima usa origens e caminhos fixos, redirects bloqueados, timeout, resposta limitada e cache curto. O navegador não se conecta diretamente ao provedor, portanto a CSP permanece `connect-src 'self'`.

## Limites e segurança

- Host/Origin loopback e `x-genesis-client: web` em mutações;
- WAV PCM mono 16-bit, 8–48 kHz, até 10 MiB e 45 s;
- texto TTS até 2.000 caracteres; uma operação STT/TTS ativa por vez;
- STT 90 s, TTS 120 s e WAV TTS até 24 MiB;
- caminhos apenas sob `.genesis/voice` e `spawn` com `shell: false`;
- workers encerrados e temporários apagados no lifecycle do servidor;
- CSP sem `unsafe-inline`; microfone restrito à própria origem;
- `Permissions-Policy` bloqueia geolocalização e permite microfone somente na própria origem;
- nenhuma alegação de GPS real, precisão humana ou naturalidade sem ensaio correspondente.
