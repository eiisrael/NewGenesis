# Conversa por voz e contexto local

A voz usa o mesmo composer, histórico e orquestrador do chat. A transcrição exibida continua canônica; apenas uma cópia determinística é normalizada para pronúncia, com datas, horários, versões, unidades e siglas em pt-BR e sem ruído de Markdown, tabelas, URLs longas ou blocos extensos de código.

## Usar

1. Inicie com `npm start` e abra `http://127.0.0.1:7331`.
2. Abra **Configurações de voz** e escolha reconhecimento, TTS, qualidade, voz e velocidade.
3. Use **Falar uma vez** para push-to-talk ou ative **Modo conversa mãos-livres**.
4. **Testar microfone** abre a entrada por até 15 segundos, mostra a frase reconhecida e não envia nada ao chat. Se o Windows ou o navegador não expuserem uma entrada ativa, a interface informa se o dispositivo está ausente, ocupado ou sem permissão.
5. **Testar voz do Genesis** bloqueia cliques repetidos enquanto o áudio é preparado. O contexto de saída é desbloqueado em toda interação. Enquanto os workers aquecem, o modo automático pode usar imediatamente uma voz pt-BR que o sistema marque como `localService`.
6. No modo conversa, o ciclo passa por ouvindo, transcrevendo, pensando, preparando e falando. Se o STT não produzir texto, o ciclo volta a ouvir sem travar.
7. Fale durante a resposta para interromper: o áudio atual, a preparação e a fila pendente são cancelados antes da nova transcrição.

O TTS normal permanece local. O modo automático prefere um Piper ou Kokoro já aquecido; durante o aquecimento usa uma voz pt-BR confirmada como local pelo `speechSynthesis` do sistema e, se ela não existir, aguarda o Piper. Kokoro deixa de ser escolhido enquanto estiver em cooldown após timeout. Falhas reais tentam outro engine, mas falhas do dispositivo de saída não são mascaradas por troca de sintetizador. `SpeechRecognition` permanece apenas como fallback de entrada e pode depender do fornecedor do navegador. **Preferir voz 100% local** o bloqueia.

| Perfil | STT | TTS | Observações |
| --- | --- | --- | --- |
| Rápido automático | whisper.cpp `base-q5_1` | voz pt-BR local do sistema, depois Piper aquecido | menor latência no hardware validado; baixa confiança exige revisão |
| Compatibilidade de entrada | API do navegador | engine local instalado | o reconhecimento pode usar rede; a saída continua local |
| Opção de maior qualidade | whisper.cpp + Silero | Kokoro-82M pt-BR | seleção explícita; maior instalação e aquecimento limitado a 28 s |
| Local leve | whisper.cpp + Silero | Piper pt-BR | menor modelo TTS e worker persistente |
| Experimental pesado | whisper.cpp + Silero | Chatterbox pt-BR | mais de 3,21 GB só nos pesos principais; não validado nesta máquina |

## Contexto de entrada

Turnos de voz enviam apenas metadados estruturados: modo de entrada, engine STT, modo conversa e se a resposta será falada. Áudio e transcrição nunca entram nesses metadados. O orquestrador recebe uma seção de sistema confiável para preferir frases pronunciáveis quando necessário.

Data, hora, cidade explicitamente informada e clima são resolvidos internamente pelo Genesis e entregues na conversa. Data e hora vêm do relógio do sistema, sem modelo remoto. Para clima de uma cidade, o servidor resolve o nome solicitado e consulta somente os provedores documentados. O Genesis pode reutilizar a última cidade declarada na conversa; ele não usa localização aproximada do navegador e não exibe widget, raio ou coordenadas.

## Privacidade e limites

- O microfone depende de ação e permissão explícitas do usuário; a geolocalização do navegador permanece desativada.
- A captura usa `AudioWorklet` same-origin, com `ScriptProcessor` somente como fallback compatível.
- A conversão para 16 kHz aplica filtragem antialias, não duplica o frame inicial e calcula somente em memória RMS, pico e clipping para o teste do microfone.
- O áudio bruto não entra em histórico, telemetria ou métricas. Temporários são removidos após cada operação e no shutdown.
- As métricas guardam apenas marcos, horário do cliente, engine e latência limitada.
- TTS e STT locais permanecem carregados em workers/servidor persistentes e são aquecidos em segundo plano. A interface distingue `PREPARING` de `SPEAKING`.
- O protocolo JSONL Node.js/Python força UTF-8, preservando acentos pt-BR. O TTS não altera a resposta exibida; o STT aplica apenas correções fonéticas estreitas e testadas antes de preencher o composer.
- O chat textual continua funcional sem engine de voz, microfone, localização ou serviço de clima.

Consulte [VOICE_SETUP_WINDOWS.md](VOICE_SETUP_WINDOWS.md), [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md), [VOICE_BENCHMARK.md](VOICE_BENCHMARK.md) e [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
