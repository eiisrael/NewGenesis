# Benchmark de voz

## Resultado executado em 27 de agosto de 2026

Hardware: Windows 10.0.19045 x64, Intel Core i5-4670K 3,40 GHz, 4 núcleos/4 threads, 25.468.071.936 bytes de RAM (~23,7 GiB), Radeon RX 460 4 GB + Intel HD 4600. Não havia NVIDIA/CUDA. O build oficial CPU do whisper.cpp foi usado; Vulkan não foi compilado.

Engines instalados e hashes verificados: whisper.cpp 1.8.6, `small-q5_1` multilíngue (190.085.487 bytes), Silero VAD 6.2 (885.098 bytes), Kokoro-82M 1.0 com três vozes pt-BR e Piper 1.4.2 com `pt_BR-cadu-medium`. Chatterbox não foi baixado: exige mais de 3,21 GB de pesos e um ambiente Python separado.

Os testes são **loopback sintético**: um TTS gera WAV e o mesmo buffer é enviado ao Whisper. Isso verifica integração, português, codificação, perfis, hashes, limpeza e capacidade computacional; não mede microfone, ruído, sotaque humano ou naturalidade percebida.

### Kokoro-82M pt-BR persistente

| Frase | TTS | Áudio | Whisper | RTF STT | WER normalizado |
| --- | ---: | ---: | ---: | ---: | ---: |
| “Bom dia. O que você gostaria de fazer hoje?” | 14.889 ms (frio) | 2,590 s | 6.396 ms | 2,472 | 0,0000 |
| “Encontrei três possíveis causas…” | 4.048 ms | 4,911 s | 6.528 ms | 1,330 | 0,0000 |
| “Consegui terminar a análise…” | 4.139 ms | 4,655 s | 6.123 ms | 1,316 | 0,0909 |

O primeiro teste reproduz exatamente a frase que falhava. Depois de forçar UTF-8 no protocolo Node.js/Python, o Whisper retornou `você`, sem verbalizar nomes de símbolos. A terceira diferença foi a omissão de “há” no loopback e não autoriza alegação de precisão humana.

Para “Olá, tudo bem. Como vai você?”, a análise PCM mediu 1,800 s totais, maior silêncio interno de 75 ms e silêncio final de 55 ms. A limpeza remove somente silêncio externo; não reescreve o texto exibido.

### Piper persistente

| Frase | TTS | Áudio | Whisper | RTF STT | WER normalizado |
| --- | ---: | ---: | ---: | ---: | ---: |
| “Bom dia. O que você gostaria de fazer hoje?” | 739 ms | 3,641 s | 8.498 ms | 2,335 | 0,0000 |
| “Encontrei três possíveis causas…” | 886 ms | 5,734 s | 8.883 ms | 1,552 | 0,0000 |
| “Consegui terminar a análise…” | 889 ms | 5,267 s | 10.287 ms | 1,956 | 0,0000 |

### Recursos nativos amostrados

Amostragem a cada 100 ms durante o benchmark Piper, com processos persistentes já aquecidos:

| Engine | Processos | Pico de working set | CPU média aproximada da máquina |
| --- | ---: | ---: | ---: |
| Kokoro ocioso | 2 (launcher + runtime Python) | 1.258.741.760 bytes (~1,17 GiB) | 0,0% |
| Piper | 2 (launcher + runtime Python) | 237.494.272 bytes (~226,5 MiB) | 3,4% |
| whisper.cpp/server | 1 | 387.395.584 bytes (~369,4 MiB) | 51,3% |

CPU usa a diferença do tempo de processador dentro da janela observada, dividida pelos quatro processadores lógicos. Não é um profiler; working set é pico amostrado, não compromisso total do sistema.

## Perfis Whisper

Nesta instalação, somente `balanced` (`small-q5_1`) existe. Chamadas para `rapid` ou `accurate` retornaram HTTP 503 com `whisper_not_installed`; a UI desativou essas opções e manteve `balanced`. Assim, a interface não promete três qualidades quando há apenas um modelo físico.

## Reproduzir

Com o servidor iniciado e os engines instalados:

```powershell
npm run voice:benchmark:kokoro
npm run voice:benchmark:loopback
npm run voice:benchmark:resources
npm run voice:benchmark
```

O último comando agrega marcos de turnos humanos já registrados localmente. Se não houver um turno completo, ele imprime `turns: []` em vez de inventar latências.

## Roteiro humano obrigatório antes da release

Em ambiente silencioso e depois com ruído moderado, testar frase curta, frase longa, silêncio, interrupção durante uma resposta curta e interrupção durante uma resposta longa. Registrar engine, modelo, transcrição, latências, falhas e percepção de voz.

O usuário relatou boa qualidade e dicção do Kokoro, mas a avaliação sistemática de microfone, ruído e sotaques não foi executada por automação. Chatterbox também não foi avaliado, pois exige autorização explícita para vários gigabytes. Este documento não extrapola WER de fala sintética para fala humana.
