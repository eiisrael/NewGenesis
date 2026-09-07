# Instalação da voz local no Windows

O core continua sem Python e sem modelos. O comando sem `-AcceptDownload` é uma simulação que mostra os tamanhos e não baixa nada.

## Diagnóstico

```powershell
npm run voice:diagnose
```

## Perfil local recomendado

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component whisper -Profile rapid
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component whisper -Profile rapid -AcceptDownload
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component kokoro
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component kokoro -AcceptDownload -AcceptLargeDownload
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component piper -AcceptDownload
```

Perfis Whisper disponíveis:

| Perfil | Modelo multilíngue | Peso | Uso sugerido |
| --- | --- | ---: | --- |
| `rapid` | `base-q5_1` | 59.707.625 bytes | padrão em CPUs de até 8 threads |
| `balanced` | `small-q5_1` | 190.085.487 bytes | maior precisão, somente quando a latência medida for aceitável |
| `accurate` | `medium-q5_0` | 539.212.467 bytes | somente após benchmark |

O setup também baixa o binário CPU oficial do whisper.cpp 1.8.6 (4.093.849 bytes) e Silero VAD 6.2 (885.098 bytes). O upstream não publica binário Vulkan oficial para Windows nesta versão; ativar Vulkan exigiria build manual auditado, portanto não é feito silenciosamente.

Kokoro cria `.genesis/voice/venv-kokoro`, usa Python 3.10 a 3.12 e instala versões fixas de `kokoro==0.7.16`, `misaki[en]==0.7.16`, `soundfile==0.13.1` e PyTorch CPU. O aceite grande é obrigatório porque modelo e três vozes oficiais pt-BR somam 328.782.506 bytes e o ambiente instalado pode superar 1 GB. As vozes disponíveis são Dora (`pf_dora`), Alex (`pm_alex`) e Santa (`pm_santa`).

Piper cria `.genesis/voice/venv-piper`, instala `piper-tts==1.4.2` e baixa `pt_BR-cadu-medium` (62.950.044 bytes). Python 3.10 a 3.14 é aceito quando compatível com os wheels resolvidos.

## Chatterbox natural, opcional e experimental

Chatterbox exige Python 3.10 ou 3.11 neste adaptador, PyTorch e pelo menos 3.200.893.990 bytes de pesos principais. O download só começa com os dois aceites:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component chatterbox
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component chatterbox -AcceptDownload -AcceptLargeDownload -TorchBackend cpu
```

Use `-TorchBackend cuda128` apenas com NVIDIA/CUDA compatível e depois de confirmar a matriz do PyTorch. O setup usa `.genesis/voice/venv-chatterbox`, não altera o Python global e não baixa gravação de referência. Presets: `natural` (padrão), `calm` e `expressive`.

## Remoção

O comando abaixo resolve e valida o alvo antes da remoção e apaga apenas `.genesis/voice`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Remove
```

Reinicie o NewGenesis após instalar ou remover componentes. Se a UI não listar um engine, rode `npm run voice:diagnose`, confirme os hashes/manifesto e consulte o terminal. O fallback textual nunca depende desses componentes.
