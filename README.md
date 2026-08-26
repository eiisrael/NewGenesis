# NewGenesis 2.3.1

NewGenesis combina uma interface local, o contexto estrutural do SupremeMind e um orquestrador verificável que usa somente rotas gratuitas da OpenRouter. Conversas, tarefas, telemetria, memória canônica e preferências permanecem no computador.

O pedido `Analise o Astraeon e retorne um bash com as informações do projeto.` é um contrato especial de visão geral: usa o perfil local do projeto, não consulta o OpenRouter e registra zero requests/tokens remotos.

## Início

Requisito: Node.js 20 ou superior. A chave OpenRouter é opcional para recursos inteiramente locais e necessária para respostas remotas.

```powershell
npm start
```

No Windows, `start.bat` executa o mesmo comando. Abra `http://127.0.0.1:7331`. Copie `.env.example` para `.env.local` se preferir configurar a chave por arquivo; `.env*` reais são ignorados pelo Git.

## Tetos globais

Os defaults de `src/config.js` são limites máximos, não uma promessa de consumo:

| Limite | Default |
| --- | ---: |
| Rotas candidatas por mensagem | 4 |
| Requests de inferência sem ferramentas | 5 |
| Requests quando ferramentas estão habilitadas | 14 |
| Rodadas de ferramenta | 12 |
| Contexto de entrada montado pelo motor | 12.000 tokens estimados |
| Saída por request | 8.192 tokens, ainda limitada pelo modelo |
| Mensagem do usuário | 120.000 caracteres |
| Timeout de request | 60 s |

Podem ser reduzidos com `GENESIS_MAX_ROUTES_PER_MESSAGE`, `GENESIS_MAX_REQUESTS_PER_MESSAGE`, `GENESIS_MAX_TOOL_REQUESTS_PER_MESSAGE`, `GENESIS_MAX_TOOL_ROUNDS`, `GENESIS_INPUT_TOKEN_BUDGET`, `GENESIS_OUTPUT_TOKEN_BUDGET`, `GENESIS_MAX_MESSAGE_CHARACTERS` e `GENESIS_REQUEST_TIMEOUT_MS`.

## Orçamento efetivo do contrato

O menor valor entre a configuração global, a capacidade do modelo e o contrato da tarefa prevalece:

| Contrato | Requests | Entrada cumulativa | Entrada por request | Reserva final | Deadline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Visão geral local | 0 | 0 | 0 | 0 | local |
| Análise/diagnóstico | 3 | 30.000 | 14.000 | 1 | 90 s |
| Resposta comum | 4 | 36.000 | 12.000 | 1 | 90 s |
| Mudança/correção comum | 6 | 72.000 | 14.000 | 1 | 180 s |
| Mudança/correção ampla | 14 | 144.000 | 16.000 | 1 | 240 s |

O contexto realmente enviado costuma ser menor: respeita o teto de 12.000 tokens do motor, a janela do modelo, a reserva de saída, o modo escolhido e o orçamento restante. Cada chamada é contabilizada antes de sair; não há retry remoto oculto. Fallbacks entre rotas gratuitas e continuações aparecem no ledger e consomem o mesmo orçamento.

## Ferramentas de projeto

- `search_project` aceita até 6 termos alternativos, retorna no máximo 18 ocorrências e contextualiza até 8.
- `read_project_file` retorna no máximo 220 linhas e 8.000 caracteres sanitizados por chamada, com paginação explícita.
- Arquivos individuais analisáveis têm até 2 MiB; o inventário aceita até 10.000 arquivos e 128 MiB de texto seguro.
- Escrita, substituição, criação e movimentação permanecem dentro da raiz real do projeto aberto.
- Exclusão só é oferecida quando o pedido a autoriza explicitamente.
- `run_project_check=auto` prefere um script `check` quando ele agrega claramente múltiplas verificações; comandos continuam em allowlist, com ambiente reduzido, timeout de 120 s e saída sanitizada.

## Análise, mutação e verificação

Pedidos de análise/diagnóstico são somente leitura. Uma frase que apenas menciona “delete”, “fix” ou código mutável não autoriza escrita. Mudanças exigem uma ferramenta real, respeitam o modo de aprovação (`ask` ou `full`), produzem evidências e reservam verificação/síntese quando o orçamento permite. Streaming parcial, EOF sem término, timeout, STOP e `finish_reason=error/length` nunca viram sucesso verificado.

## Free-only e contabilidade

O catálogo aceita apenas `openrouter/free` e IDs explicitamente `:free`; nenhum modelo pago é escolhido automaticamente. Requests e tokens reportados pelo provedor continuam contabilizados em sucesso, erro, timeout e STOP. Estimativas são identificadas e editar uma mensagem não apaga consumo anterior.

## SupremeMind e Neural

O SupremeMind funciona localmente: inventaria texto seguro, extrai símbolos/dependências, cria chunks, calcula relações e mantém memórias estruturadas. Segredos, certificados, chaves, binários e índices inseguros são recusados. O overview ASTRAEON não faz chamada remota.

A área Neural fica em `http://127.0.0.1:7331/neural/neural.html` e expõe tarefas, uso, grafo, contexto, impacto, órbita, memória e diagnóstico do runtime.

## Voz e privacidade

A voz é uma camada progressiva sobre o mesmo composer e histórico do chat. O microfone é permitido pela `Permissions-Policy` somente para a própria origem; CSS e scripts obedecem à CSP `style-src 'self'; script-src 'self'`. Sem `SpeechRecognition` ou `speechSynthesis`, o composer textual permanece funcional e os controles incompatíveis são desativados.

O áudio não é armazenado pelo NewGenesis. O reconhecimento é fornecido pelo navegador e, dependendo dele, pode usar um serviço online do próprio fornecedor. Preferências de voz ficam no armazenamento local do navegador.

## Segurança e rede

- O servidor aceita bind somente em `127.0.0.0/8`, `::1` ou `localhost`.
- `0.0.0.0`, IP de LAN e hostname externo são recusados; não existe modo remoto seguro suportado nesta versão.
- `Host` e `Origin` externos são rejeitados. `x-genesis-client: web` é uma barreira anti-CSRF da UI, não autenticação.
- Chaves persistidas ficam no cofre local criptografado e nunca retornam à UI.
- O shutdown de `SIGINT`/`SIGTERM` para novas requisições, cancela operações ativas, espera o HTTP fechar e drena stores/telemetria.

Consulte `SECURITY.md` para comunicar vulnerabilidades.

## Verificação

```powershell
npm test
npm run check
npm run test:browser
cd SupremeMind
npm run check
```

`test:browser` requer Chrome, Chromium ou Edge (ou `CHROME_PATH`) e usa o navegador real sem dependências adicionais. O CI cobre Node 20/22/24 no Linux, Node 22 no Windows, o smoke de voz no Chrome e a verificação própria do SupremeMind.

Veja `CHANGELOG.md`, `RELEASE_NOTES_2.3.1.md` e `RELEASE_CHECKLIST.md` para a preparação da release. `EVOLUCAO_GENESIS_2_1.txt` foi preservado apenas como documento histórico da linha 2.1.
