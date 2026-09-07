# Changelog

Todas as mudanças relevantes do NewGenesis serão documentadas neste arquivo.

## [Unreleased]

### Adicionado

- Conversa por voz mãos-livres com máquina de estados explícita, VAD adaptativo, auto-retomada, sentence streaming e barge-in.
- Engines opcionais locais: whisper.cpp 1.8.6 + Silero VAD, Piper 1.4.2 pt-BR e adaptador experimental Chatterbox Multilingual V3 pt-BR.
- Setup/diagnóstico Windows com venvs isolados, aceite de download, hashes, perfis e remoção limpa.
- Métricas locais sem áudio, benchmark sintético/recurso e documentação completa de arquitetura, setup, privacidade e terceiros.
- Saída imediata por voz pt-BR marcada como local pelo sistema enquanto os workers Piper/Kokoro aquecem.

### Corrigido

- A fila de sentenças não prepara mais dois chunks simultaneamente nem entra em sete colisões `voice_tts_busy`.
- O runtime serializa TTS em FIFO, propaga cancelamento HTTP, usa deadlines absolutos e aquece Piper/Whisper sem bloquear a inicialização.
- `SPEAKING` só é exibido quando o áudio realmente inicia; síntese e decodificação usam `PREPARING`.
- Cancelamentos tardios de STT não reativam o microfone nem contaminam o turno seguinte.
- A captura não duplica o frame inicial e reamostra para 16 kHz com filtragem antialias.
- O perfil rápido é selecionado adaptativamente em CPUs de quatro threads, com revisão antes do envio em baixa confiança.

### Segurança

- Limites de áudio/texto/concorrência/tempo, caminhos confinados a `.genesis/voice`, subprocessos sem shell e limpeza determinística.
- Preferência 100% local impede fallback silencioso para reconhecimento potencialmente online do navegador.

### Testes

- Cobertura de estado, VAD, WAV, normalização, fila/fallback, autoenvio, auto-retomada, barge-in, métricas, input hostil e cleanup.
- Smoke real de navegador cobre o ciclo `LISTENING → TRANSCRIBING → THINKING → SPEAKING → LISTENING`, interrupção e degradação textual.

## [2.3.1] - futura

### Corrigido

- Shutdown determinístico drena a telemetria e demais filas antes da saída, cobrindo a race de `events.jsonl` no Windows.
- A fila de telemetria não produz mais `unhandledRejection` quando uma escrita falha.
- A voz usa CSS estático compatível com CSP estrita e microfone limitado a `self`.
- `run_project_check=auto` reconhece rotinas `check` claramente agregadoras.
- Versão do runtime deriva de `package.json`; cache keys antigas foram removidas.

### Segurança

- Arquivos `.env*` são ignorados, com `.env.example` seguro.
- Bind não-loopback é recusado e requests com `Host`/`Origin` externos são bloqueados.
- `x-genesis-client` é documentado como barreira de UI, nunca autenticação.

### Testes e CI

- Regressões de flush/`ENOENT`, CSP, rede, versão e heurística de checks.
- Smoke real de voz em Chrome/Chromium, incluindo degradação sem APIs de voz.
- CI em Node 20/22/24, Windows/Linux, com verificação separada do SupremeMind.

### Documentação

- Defaults, contratos, limites, privacidade de voz e política de rede sincronizados com o código.
- Adicionados licença MIT, política de segurança, notas e checklist de release.
