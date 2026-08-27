# Conversa por voz e contexto local

A voz usa o mesmo composer, histórico e orquestrador do chat. A transcrição exibida continua canônica; apenas uma cópia determinística é normalizada para pronúncia, com datas, horários, versões, unidades e siglas em pt-BR e sem ruído de Markdown, tabelas, URLs longas ou blocos extensos de código.

## Usar

1. Inicie com `npm start` e abra `http://127.0.0.1:7331`.
2. Abra **Configurações de voz** e escolha reconhecimento, TTS, qualidade, voz e velocidade.
3. Use **Falar uma vez** para push-to-talk ou ative **Modo conversa mãos-livres**.
4. **Testar microfone** abre a entrada por até 15 segundos, mostra a frase reconhecida e não envia nada ao chat. Se o Windows ou o navegador não expuserem uma entrada ativa, a interface informa se o dispositivo está ausente, ocupado ou sem permissão.
5. **Testar voz do Genesis** bloqueia cliques repetidos enquanto o áudio é preparado. O contexto de saída é desbloqueado no clique, antes do aquecimento do engine local, para evitar bloqueio de reprodução pelo navegador.
4. No modo conversa, o ciclo passa por ouvindo, transcrevendo, pensando e falando. Se o STT não produzir texto, o ciclo volta a ouvir sem travar.
5. Fale durante a resposta para interromper: o áudio atual, a preparação e a fila pendente são cancelados antes da nova transcrição.

O TTS normal é sempre local. A ordem automática é Kokoro, Piper e Chatterbox; somente uma falha real de síntese tenta outro engine local instalado. Falhas da saída de áudio e engine ocupado são exibidas diretamente, porque trocar Kokoro por Piper não corrige o mesmo dispositivo de reprodução. Não há fallback para `speechSynthesis`. `SpeechRecognition` permanece apenas como fallback explícito de entrada e pode depender do fornecedor do navegador. **Preferir voz 100% local** o bloqueia.

| Perfil | STT | TTS | Observações |
| --- | --- | --- | --- |
| Compatibilidade de entrada | API do navegador | engine local instalado | o reconhecimento pode usar rede; a saída continua local |
| Local recomendado | whisper.cpp + Silero | Kokoro-82M pt-BR | processos persistentes; maior instalação e voz ainda sujeita a avaliação humana |
| Local leve | whisper.cpp + Silero | Piper pt-BR | menor modelo TTS e worker persistente |
| Experimental pesado | whisper.cpp + Silero | Chatterbox pt-BR | mais de 3,21 GB só nos pesos principais; não validado nesta máquina |

## Contexto de entrada

Turnos de voz enviam apenas metadados estruturados: modo de entrada, engine STT, modo conversa e se a resposta será falada. Áudio e transcrição nunca entram nesses metadados. O orquestrador recebe uma seção de sistema confiável para preferir frases pronunciáveis quando necessário.

Data, hora, cidade explicitamente informada e clima são resolvidos internamente pelo Genesis e entregues na conversa. Data e hora vêm do relógio do sistema, sem modelo remoto. Para clima de uma cidade, o servidor resolve o nome solicitado e consulta somente os provedores documentados. O Genesis pode reutilizar a última cidade declarada na conversa; ele não usa localização aproximada do navegador e não exibe widget, raio ou coordenadas.

## Privacidade e limites

- O microfone depende de ação e permissão explícitas do usuário; a geolocalização do navegador permanece desativada.
- A captura usa `AudioWorklet` same-origin, com `ScriptProcessor` somente como fallback compatível.
- O áudio bruto não entra em histórico, telemetria ou métricas. Temporários são removidos após cada operação e no shutdown.
- As métricas guardam apenas marcos, horário do cliente, engine e latência limitada.
- TTS e STT locais permanecem carregados em workers/servidor persistentes; o primeiro uso inclui aquecimento.
- O protocolo JSONL Node.js/Python força UTF-8, preservando acentos pt-BR; o texto exibido nunca é reescrito pela camada de voz.
- O chat textual continua funcional sem engine de voz, microfone, localização ou serviço de clima.

Consulte [VOICE_SETUP_WINDOWS.md](VOICE_SETUP_WINDOWS.md), [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md), [VOICE_BENCHMARK.md](VOICE_BENCHMARK.md) e [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
