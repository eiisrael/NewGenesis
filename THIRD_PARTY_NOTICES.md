# Avisos de terceiros — voz

NewGenesis é código original de Erick Israel, Copyright (c) 2026 Erick Israel, distribuído sob a licença MIT existente em `LICENSE`. Os componentes abaixo não alteram essa autoria e permanecem sob as licenças de seus respectivos titulares.

Nenhum binário, wheel ou peso de modelo listado abaixo é versionado neste repositório. `scripts/setup-voice.ps1` só os baixa após aceite explícito para `.genesis/voice/`, diretório ignorado pelo Git. Ao redistribuir esses artefatos separadamente, preserve a licença e os avisos obtidos do upstream.

## Componentes instaláveis

| Componente | Versão/modelo fixado | Upstream | Licença declarada | Dataset/voz | Uso e redistribuição |
| --- | --- | --- | --- | --- | --- |
| whisper.cpp | 1.8.6, binário Windows x64 CPU | <https://github.com/ggml-org/whisper.cpp> | MIT | não aplicável | baixado pelo usuário; não redistribuído pelo NewGenesis |
| Whisper | `base-q5_1`, `small-q5_1` ou `medium-q5_0`, sempre multilíngue | <https://huggingface.co/ggerganov/whisper.cpp> e <https://github.com/openai/whisper> | MIT conforme upstream/model repo | mistura de treino descrita pelo upstream; nenhum dataset é distribuído | um peso quantizado é baixado pelo usuário e verificado por SHA-256 |
| Silero VAD para whisper.cpp | 6.2.0 | <https://github.com/ggml-org/whisper-vad> e <https://github.com/snakers4/silero-vad> | MIT | não aplicável | peso baixado pelo usuário e verificado por SHA-256 |
| Kokoro-82M | 1.0, runtime `kokoro==0.7.16` | <https://huggingface.co/hexgrad/Kokoro-82M> | Apache-2.0 conforme model card | vozes oficiais pt-BR `pf_dora`, `pm_alex` e `pm_santa` | modelo e vozes baixados pelo usuário e verificados por SHA-256; não redistribuídos pelo NewGenesis |
| Misaki/eSpeak NG | `misaki[en]==0.7.16` e dependências resolvidas no venv | <https://github.com/hexgrad/misaki> | consulte os avisos preservados dos pacotes | G2P pt-BR local | instalados somente no ambiente isolado do Kokoro |
| Piper | `piper-tts` 1.4.2 | <https://github.com/OHF-Voice/piper1-gpl> | GPL-3.0 | não aplicável ao engine | instalado como processo opcional separado em venv; não incorporado nem redistribuído no core MIT |
| Piper voice | `pt_BR-cadu-medium`, 22.050 Hz | <https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR/cadu/medium> | MIT no repositório/model card | OHF Voice Datasets, CC0; fine-tune da voz `lessac` medium | modelo baixado pelo usuário; SHA-256 do ONNX verificado |
| Chatterbox | código oficial do Space pt-BR na revisão `9e515821e826e207cd617a0fdd0223899ed108ea` | <https://github.com/resemble-ai/chatterbox> e <https://huggingface.co/spaces/ResembleAI/Chatterbox-Multilingual-TTS-pt-br> | MIT | condicionamento default oficial; nenhuma gravação externa ou voz de terceiro é empacotada | instalação opcional e experimental; exige aceite adicional de download grande |
| Chatterbox pt-BR | `ResembleAI/Chatterbox-Multilingual-pt-br`, `t3_pt_br.safetensors` + `s3gen_v3.pt` | <https://huggingface.co/ResembleAI/Chatterbox-Multilingual-pt-br> | MIT conforme model card | consulte o model card; NewGenesis não redistribui dataset nem referência de voz | 3.200.893.990 bytes de pesos principais, baixados pelo usuário e verificados por SHA-256 |

O ambiente opcional do Chatterbox também instala PyTorch, torchaudio, Hugging Face Hub, NumPy, resampy, librosa, s3tokenizer, Transformers, Diffusers, OmegaConf, resemble-perth, Silero VAD, conformer e safetensors nas versões registradas em `scripts/setup-voice.ps1`. São pacotes independentes, não redistribuídos; suas licenças e arquivos `dist-info` são preservados no venv. Antes de redistribuir um venv, gere o inventário exato com `pip list` e preserve todas as licenças transitivas. O setup do NewGenesis não cria um pacote redistribuível desses componentes.

## Serviços consultados em tempo de execução

Open-Meteo Geocoding (`geocoding-api.open-meteo.com`) resolve somente a cidade explicitamente informada na conversa. Open-Meteo Forecast (`api.open-meteo.com`) fornece o clima atual sob CC BY 4.0, com atribuição na própria resposta. O NewGenesis não envia coordenadas do navegador, não persiste as coordenadas resolvidas e não apresenta raio de precisão. Consulte <https://open-meteo.com/en/docs/geocoding-api>, <https://open-meteo.com/en/docs> e <https://open-meteo.com/en/license>.

## Avaliados, mas não integrados

| Projeto | Versão observada | Licença | Decisão |
| --- | --- | --- | --- |
| sherpa-onnx | 1.13.2 | Apache-2.0 | não instalado: excelente amplitude local, porém maior superfície nativa; o CLI do whisper.cpp foi mais simples para o core sem dependências npm |
| Transformers.js | estado observado em agosto de 2026 | Apache-2.0 | não instalado: o issue upstream #1739 relata crescimento de memória WebGPU em Whisper contínuo; não foi promovido a experimental sem uma correção demonstrada |

A API `SpeechRecognition` pertence ao navegador/sistema operacional. O NewGenesis não redistribui sua implementação; ela pode usar rede a critério do navegador e por isso é bloqueada quando “Preferir voz 100% local” está ativo. `speechSynthesis` não participa do fluxo normal de saída.
