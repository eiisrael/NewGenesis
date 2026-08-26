# Conversa por voz

A camada de voz usa o mesmo composer, histórico e orquestrador do chat. O texto exibido permanece canônico; somente uma cópia determinística é simplificada para fala, removendo ruído de Markdown, URLs longas, tabelas, blocos extensos de código e emojis decorativos.

## Usar

1. Inicie com `npm start` e abra `http://127.0.0.1:7331`.
2. Abra **Voz**.
3. Escolha STT, TTS, qualidade, preset, voz e velocidade.
4. Use **Testar microfone** e **Testar voz do Genesis**.
5. Ative **Conversa por voz**. O ciclo passa por “Ouvindo”, “Entendendo”, “Genesis está pensando” e “Genesis está falando”, retornando automaticamente a “Ouvindo”.
6. Fale durante a resposta para interromper. O áudio e a fila pendente são cancelados antes da nova transcrição.

O botão do microfone mantém o push-to-talk. `Esc` interrompe captação/reprodução. O chat textual continua funcionando mesmo sem qualquer API ou engine de voz.

## Modos

| Perfil | STT | TTS | Rede e observações |
| --- | --- | --- | --- |
| Compatibilidade | API do navegador | `speechSynthesis` | pode depender do fornecedor do navegador; a UI avisa |
| Leve local | whisper.cpp quantizado + Silero | Piper pt-BR | local, menor download e menor qualidade perceptual que Chatterbox |
| Natural | whisper.cpp balanceado + Silero | Chatterbox pt-BR | local, opcional e pesado; requer Python compatível e mais de 3,21 GB só em pesos principais |

**Preferir voz 100% local** proíbe fallback silencioso para `SpeechRecognition`. Se o Whisper não estiver instalado, a captação fica indisponível em vez de enviar áudio a terceiros. A falha de TTS local só cai para `speechSynthesis` quando a preferência local está desligada.

## Privacidade

- O áudio bruto não entra no histórico, na telemetria ou nas métricas.
- O WAV temporário do Whisper e o texto temporário do TTS são criados em diretório exclusivo e removidos em `finally`; o shutdown também limpa a área temporária.
- As métricas guardam apenas nomes de marcos, horário do cliente, engine e latência limitada.
- O microfone é solicitado apenas após ação do usuário; recarregar a página não reativa conversa nem pede permissão.
- `echoCancellation`, `noiseSuppression` e `autoGainControl` são solicitados ao navegador quando suportados.

Consulte [VOICE_SETUP_WINDOWS.md](VOICE_SETUP_WINDOWS.md), [VOICE_ARCHITECTURE.md](VOICE_ARCHITECTURE.md), [VOICE_BENCHMARK.md](VOICE_BENCHMARK.md) e `THIRD_PARTY_NOTICES.md`.
