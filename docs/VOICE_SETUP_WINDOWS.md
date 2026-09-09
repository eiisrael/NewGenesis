# Instalação da voz local no Windows

O core continua sem Python e sem modelos. O comando sem `-AcceptDownload` é uma simulação que mostra os tamanhos e não baixa nada.

## Diagnóstico

```powershell
npm run voice:diagnose
```

O diagnóstico executa cada Python isolado com limite de tempo e verifica o pip. Um `python.exe` existente pode estar quebrado quando o projeto foi copiado de outro computador; nesse caso ele aparece como `[FALHA]`. O status do Genesis também verifica o intérprete e a presença das dependências antes de oferecer o engine, usando cache para evitar iniciar Python a cada consulta. O aquecimento e o teste de síntese validam o carregamento efetivo dos modelos.

No Windows x64, mantenha o [Visual C++ Redistributable x64 oficial](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) atualizado. O [ONNX Runtime 1.21 e posteriores exigem ao menos 14.40](https://github.com/microsoft/onnxruntime/releases/tag/v1.21.0); versões anteriores podem causar `DLL load failed` ao importar Piper mesmo com o ambiente Python instalado. O diagnóstico verifica esse requisito. O setup de voz não instala componentes de sistema; após atualizar o redistribuível, reinicie o Genesis.

## Reparar um ambiente copiado ou quebrado

Informe o caminho absoluto de um Python funcional compatível com o componente:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component piper -PythonExecutable 'C:\caminho\python.exe' -AcceptDownload
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component kokoro -PythonExecutable 'C:\caminho\python.exe' -AcceptDownload -AcceptLargeDownload
```

O setup reutiliza ambientes saudáveis. Antes de recriar um ambiente inválido, verifica o Python escolhido e preserva o diretório antigo como `venv-<componente>.backup-<data>-<id>` dentro de `.genesis/voice`. Os modelos verificados são reutilizados. Se a criação do ambiente ou preparação do pip falhar, o ambiente anterior é restaurado e a tentativa incompleta fica em `venv-<componente>.failed-<id>`. Se uma instalação posterior de pacote falhar, o backup continua preservado; repita o mesmo comando para concluir a instalação. Nenhum backup é apagado automaticamente.

Depois, reinicie o Genesis, rode o diagnóstico e use **Testar voz do Genesis**. O teste de voz confirma a síntese real; a presença dos arquivos ou dependências, isoladamente, não garante que um modelo carregue.

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

O adaptador desativa flash attention (`-nfa`) no servidor e na CLI do Whisper. A otimização padrão do binário 1.8.6 apresentou violação de acesso durante a inicialização em CPU; a transcrição foi validada sem ela, preservando os modelos e os perfis de qualidade.

Kokoro cria `.genesis/voice/venv-kokoro`, usa Python 3.10 a 3.12 e instala versões fixas de `kokoro==0.7.16`, `misaki[en]==0.7.16`, `soundfile==0.13.1` e PyTorch CPU. O aceite grande é obrigatório porque modelo e três vozes oficiais pt-BR somam 328.782.506 bytes e o ambiente instalado pode superar 1 GB. As vozes disponíveis são Dora (`pf_dora`), Alex (`pm_alex`) e Santa (`pm_santa`).

O primeiro uso do Kokoro inclui importação das bibliotecas e carregamento dos pesos: o prazo total é de até 120 segundos, com cancelamento disponível. Após o worker ficar pronto, o prazo volta a 28 segundos por solicitação. O modelo permanece em modo de inferência e carregado entre falas.

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
