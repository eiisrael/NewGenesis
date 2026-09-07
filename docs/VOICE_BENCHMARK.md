# Benchmark de voz

## Resultado executado em 27 de agosto de 2026

Hardware: Windows 10.0.19045 x64, Intel Core i5-4670K 3,40 GHz, 4 núcleos/4 threads, 25.537.277.952 bytes de RAM (~23,8 GiB), Radeon RX 460 4 GB + Intel HD 4600. Não havia NVIDIA/CUDA. O build oficial CPU do whisper.cpp foi usado; Vulkan não foi compilado.

Engines instalados e hashes verificados: whisper.cpp 1.8.6, `base-q5_1` (59.707.625 bytes), `small-q5_1` (190.085.487 bytes), Silero VAD 6.2 (885.098 bytes), Kokoro-82M 1.0 com três vozes pt-BR e Piper 1.4.2 com `pt_BR-cadu-medium`. Chatterbox não foi baixado: exige mais de 3,21 GB de pesos e um ambiente Python separado.

Os testes são **loopback sintético**: um TTS gera WAV e o mesmo buffer é enviado ao Whisper. Isso verifica integração, português, codificação, perfis, hashes, limpeza e capacidade computacional; não mede microfone, ruído, sotaque humano ou naturalidade percebida.

### Kokoro-82M pt-BR persistente

| Frase | TTS | Áudio | Whisper | RTF STT | WER normalizado |
| --- | ---: | ---: | ---: | ---: | ---: |
| “Bom dia. O que você gostaria de fazer hoje?” | 14.889 ms (frio) | 2,590 s | 6.396 ms | 2,472 | 0,0000 |
| “Encontrei três possíveis causas…” | 4.048 ms | 4,911 s | 6.528 ms | 1,330 | 0,0000 |
| “Consegui terminar a análise…” | 4.139 ms | 4,655 s | 6.123 ms | 1,316 | 0,0909 |

O primeiro teste reproduz exatamente a frase que falhava. Depois de forçar UTF-8 no protocolo Node.js/Python, o Whisper retornou `você`, sem verbalizar nomes de símbolos. A terceira diferença foi a omissão de “há” no loopback e não autoriza alegação de precisão humana.

Para “Olá, tudo bem. Como vai você?”, a análise PCM mediu 1,800 s totais, maior silêncio interno de 75 ms e silêncio final de 55 ms. A limpeza remove somente silêncio externo; não reescreve o texto exibido.

### Piper persistente + Whisper `rapid` após a correção

| Frase | TTS | Áudio | Whisper | RTF STT | WER normalizado |
| --- | ---: | ---: | ---: | ---: | ---: |
| “Bom dia. O que você gostaria de fazer hoje?” | 570 ms | 3,647 s | 4.392 ms | 1,206 | 0,0000 |
| “Genesis está me ouvindo?” | 297 ms | 1,455 s | 4.527 ms | 3,118 | 0,0000 |
| “Encontrei três possíveis causas…” | 860 ms | 5,644 s | 5.025 ms | 0,891 | 0,1429 |
| “Consegui terminar a análise…” | 780 ms | 5,500 s | 4.635 ms | 0,845 | 0,0909 |

O endpoint Piper aquecido gerou a saudação completa de controle em 0,81 s. Duas requisições simultâneas foram serializadas e concluíram com HTTP 200 em 371 ms e 702 ms, sem `voice_tts_busy`. No navegador real, o clique em **Testar voz do Genesis** atingiu o primeiro áudio em 878 ms, reproduziu até `tts_end` e voltou a `IDLE`, sem erro de console.

### Recursos nativos amostrados

Amostragem a cada 100 ms durante o benchmark Piper, com processos persistentes já aquecidos:

| Engine | Processos | Pico de working set | CPU média aproximada da máquina |
| --- | ---: | ---: | ---: |
| Kokoro ocioso | 2 (launcher + runtime Python) | 1.258.741.760 bytes (~1,17 GiB) | 0,0% |
| Piper | 2 (launcher + runtime Python) | 237.494.272 bytes (~226,5 MiB) | 3,4% |
| whisper.cpp/server | 1 | 387.395.584 bytes (~369,4 MiB) | 51,3% |

CPU usa a diferença do tempo de processador dentro da janela observada, dividida pelos quatro processadores lógicos. Não é um profiler; working set é pico amostrado, não compromisso total do sistema.

## Perfis Whisper

Nesta instalação, `rapid` (`base-q5_1`) e `balanced` (`small-q5_1`) existem; `accurate` permanece desativado. `rapid` é o padrão adaptativo neste CPU de quatro threads: os probes de 2,53–2,60 s foram transcritos em 4,17–4,90 s, com confiança entre 0,83 e 0,94. A troca fria para `balanced` transcreveu corretamente o mesmo probe em 15,94 s e usa um deadline próprio de 30 s; ao retornar para `rapid`, a latência foi 4,46 s.

O WER do loopback rápido acima não é zero em todas as frases longas. A interface preserva a escolha manual `balanced` e só corrige padrões fonéticos estreitos já observados (`voca a gostaria` e o cumprimento colado ao nome Gênesis); conteúdo arbitrário, nomes de arquivo e texto técnico não recebem correção global.

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
