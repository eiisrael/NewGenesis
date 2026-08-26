# Benchmark de voz

## Resultado executado em 26 de agosto de 2026

Hardware: Windows 10.0.19045 x64, Intel Core i5-4670K 3,40 GHz, 4 núcleos/4 threads, 25.468.071.936 bytes de RAM (~23,7 GiB), Radeon RX 460 4 GB + Intel HD 4600. Não havia NVIDIA/CUDA. O build oficial CPU do whisper.cpp foi usado; Vulkan não foi compilado.

Engines instalados e hashes verificados: whisper.cpp 1.8.6, `small-q5_1` multilíngue (190.085.487 bytes), Silero VAD 6.2 (885.098 bytes), Piper 1.4.2 e `pt_BR-cadu-medium` (62.950.044 bytes). Chatterbox não foi baixado: exigiria mais de 3,21 GB de pesos e Python compatível separado.

O teste abaixo foi um **loopback sintético**: Piper gerou WAV em memória e o mesmo buffer foi enviado ao Whisper. Isso verifica integração, português, hashes, limpeza e capacidade computacional; não mede microfone, ruído, sotaque humano ou naturalidade percebida.

| Frase | Piper | Áudio | Whisper | RTF STT | WER normalizado |
| --- | ---: | ---: | ---: | ---: | ---: |
| “Bom dia. O que você gostaria de fazer hoje?” | 4.815 ms | 4,574 s | 8.195 ms | 1,797 | 0,0000 |
| “Encontrei três possíveis causas…” | 4.844 ms | 6,293 s | 8.864 ms | 1,410 | 0,0000 |
| “Consegui terminar a análise…” | 4.695 ms | 6,014 s | 9.249 ms | 1,539 | 0,0000 |

Em uma execução fria anterior, o primeiro Piper levou 11.302 ms; depois ficou entre 4.361 e 4.534 ms. Whisper ficou entre 7.989 e 8.149 ms nessa execução. Logo, neste i5-4670K a camada local funciona, mas não atende uma alegação de “tempo real”. WER zero em fala sintética limpa não deve ser extrapolado para fala humana.

Amostragem dos processos nativos a cada 100 ms, em uma execução completa de três frases:

| Engine | Processos | Pico de working set observado | CPU aproximada da máquina |
| --- | ---: | ---: | ---: |
| whisper.cpp | 3 | 509.374.464 bytes (~485,8 MiB) | 67,8% |
| Piper/Python | 6 (wrapper + worker) | 226.242.560 bytes (~215,8 MiB) | 13,7% |

CPU é uma média aproximada baseada no tempo acumulado dos processos dividido pela vida observada e por 4 processadores lógicos. Não é um profiler; working set é pico amostrado, não compromisso total do sistema.

## Reproduzir

Com o servidor iniciado e os engines instalados:

```powershell
npm run voice:benchmark:loopback
npm run voice:benchmark:resources
npm run voice:benchmark
```

O último comando agrega marcos de turnos humanos já registrados localmente. Se não houver um turno completo, ele imprime `turns: []` em vez de inventar latências.

## Roteiro humano obrigatório antes da release

Em ambiente silencioso e depois com ruído moderado, testar frase curta, frase longa, silêncio, interrupção durante uma resposta curta e interrupção durante uma resposta longa. Registrar engine, modelo, transcrição, latências, falhas e percepção de voz. Repetir com Browser, Whisper+Piper e, se o usuário autorizar o download, Whisper+Chatterbox.

O teste humano de microfone e a avaliação perceptual do Chatterbox **não foram executados nesta sessão**: eles exigem fala/avaliação do usuário e, para Chatterbox, autorização explícita para vários gigabytes. Por isso este documento não atribui precisão humana nem qualidade “natural” observada ao resultado atual.
