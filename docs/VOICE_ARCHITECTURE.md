# Arquitetura da conversa por voz

## Fluxo

`public/voice.js` é apenas composição e UI. A execução é dividida entre:

- `VoiceConversationController`: coordena turno, autoenvio, auto-retomada, streaming e barge-in.
- `VoiceStateMachine`: transições explícitas entre `IDLE`, `LISTENING`, `SPEECH_DETECTED`, `TRANSCRIBING`, `THINKING`, `SPEAKING`, `INTERRUPTING` e `ERROR`.
- `LocalAudioInputEngine` + `AdaptiveEnergyVad`: captação, pre-roll, VAD adaptativo, WAV mono 16 kHz e limiar mais alto durante reprodução.
- `BrowserSpeechInputEngine`: fallback com `SpeechRecognition`/`webkitSpeechRecognition`.
- `LocalSpeechToTextEngine`: envia somente o utterance WAV ao runtime loopback do NewGenesis.
- `AudioPlaybackController`: fila sequencial, cancelamento imediato e fallback controlado.
- `LocalTextToSpeechEngine` e `BrowserTextToSpeechEngine`: Chatterbox/Piper opcionais e `speechSynthesis`.
- `VoiceSettings`: defaults seguros, enumeração, migração e preferências locais.
- `speech-normalizer`: sentence chunking estável, texto falado e filtro de feedback acústico.
- `VoiceRuntime`: processos nativos, limites, diretórios temporários e integração ao lifecycle do servidor.

O chat emite `genesis:chat-start`, `genesis:chat-delta`, `genesis:chat-end` e `genesis:chat-error`. Somente sentenças terminadas entram na fila TTS. Barge-in faz `SPEAKING → INTERRUPTING → SPEECH_DETECTED`, cancela o item atual e os pendentes e mantém a nova fala.

## Escolha de engines

| STT | Pontos fortes | Limitações | Decisão |
| --- | --- | --- | --- |
| whisper.cpp 1.8.6 | Windows CPU oficial, modelos quantizados multilíngues, CLI simples, Silero VAD integrado | subprocesso por utterance tem cold start; Vulkan requer build manual | engine local padrão |
| sherpa-onnx 1.13.2 | streaming/non-streaming ASR, VAD, TTS, Node/WASM e ampla portabilidade | superfície nativa e manutenção maiores para este core sem dependências | pesquisado, não integrado |
| Browser Recognition | zero instalação e boa compatibilidade | implementação/privacidade dependem do navegador; pode usar rede | fallback explícito, proibido no modo 100% local |

| TTS | Pontos fortes | Limitações | Papel |
| --- | --- | --- | --- |
| Chatterbox Multilingual V3 pt-BR | maior ambição de naturalidade, MIT, prosódia configurável | mais de 3,21 GB, PyTorch, CPU lenta e não validado nesta máquina | natural opcional/experimental |
| Piper 1.4.2 + cadu | leve, local, modelo pt-BR permissivo | engine GPL-3.0 separado; voz menos natural e geração ainda lenta no i5 testado | fallback local leve |
| `speechSynthesis` | zero instalação | qualidade e vozes variam por SO/navegador | compatibilidade |

Transformers.js/WebGPU não foi integrado porque o issue oficial #1739, aberto em agosto de 2026, ainda descreve crescimento de memória em Whisper contínuo. Não há base honesta para torná-lo padrão sem correção e benchmark longo.

## Limites e segurança

- rotas locais mesmas-origem, Host/Origin loopback e `x-genesis-client: web` nas mutações;
- WAV PCM mono 16-bit, 8–48 kHz, até 10 MiB e 45 s;
- texto TTS até 2.000 caracteres e JSON até 12 KiB;
- uma geração por engine, STT 90 s, TTS 120 s, saída WAV até 24 MiB;
- caminhos resolvidos apenas sob `.genesis/voice`;
- `spawn` com `shell: false`, argumentos fixos e encerramento no shutdown;
- CSP permanece sem `unsafe-inline`.
