# Genesis New 2.1

Genesis New combina a interface do Genesis Painel, a inteligência estrutural local do SupremeMind e um orquestrador seguro de modelos gratuitos da OpenRouter. A conversa, as tarefas e a memória canônica permanecem locais; trocar de modelo não apaga o raciocínio já consolidado.

## O que esta versão resolve

- O pedido `Analise o Astraeon e retorne um bash com as informações do projeto.` usa o analisador local: **0 requisições e 0 tokens remotos**.
- Resultados de ferramentas não crescem indefinidamente: leituras têm paginação, limite de 400 linhas/16 mil caracteres, remoção de data URI/base64 e teto cumulativo por tarefa.
- Toda chamada HTTP consome um orçamento visível. Não existem retries ou recuperações ocultas.
- Há teto por requisição, teto cumulativo de entrada, reserva para síntese e deadline total de 90–120 segundos.
- Streaming interrompido, EOF incompleto e `finish_reason=error/length` nunca são tratados como conclusão verificada.
- Tokens, custo e requests reportados pelo provedor são preservados também em timeout, erro e STOP; estimativas ficam identificadas como tais.
- Pedidos de análise são somente leitura. Citar uma função chamada `delete` ou um “fix aplicado” não autoriza alterações.
- Alterações usam edição exata por trecho, escrita segura e ferramentas limitadas ao diretório aberto. Exclusão só é exposta quando solicitada explicitamente.
- O catálogo gratuito é descoberto dinamicamente e ranqueado conforme tarefa, capacidade, contexto, suporte a ferramentas, saúde e latência.
- O SupremeMind indexa HTML, CSS, YAML e código, recupera trechos, calcula relações e invalida o índice quando o agente altera o projeto.
- A área Neural é um cockpit funcional para tarefas, uso, grafo, contexto, impacto, órbita, memória e diagnóstico.

## Início

Requisitos: Node.js 20 ou superior e uma chave OpenRouter para respostas remotas.

No Windows, execute `start.bat`. Alternativamente:

```powershell
npm start
```

Abra `http://127.0.0.1:7331`. A chave pode permanecer apenas na sessão ou ser guardada no cofre local criptografado.

## Contratos e orçamentos

Cada mensagem recebe um contrato local com objetivo, tipo, complexidade, formato, etapas, critérios de sucesso, ferramentas permitidas e limites. Os valores efetivos são adaptados à tarefa:

- visão geral do projeto: 0 chamadas, relatório local;
- análise/diagnóstico: até 3 chamadas, uma rodada de leitura e síntese reservada;
- mudança/correção: até 6 chamadas, ou 8 em tarefa de alta complexidade;
- resposta comum: até 3 chamadas;
- contexto individual: 12–18 mil tokens estimados;
- deadline total: 90 segundos; mudanças recebem até 120 segundos.

Os limites globais de segurança ainda podem ser reduzidos em `.env.local`:

```text
OPENROUTER_API_KEY=sk-or-v1-...
GENESIS_MAX_ROUTES_PER_MESSAGE=3
GENESIS_MAX_REQUESTS_PER_MESSAGE=4
GENESIS_MAX_TOOL_REQUESTS_PER_MESSAGE=12
GENESIS_MAX_TOOL_ROUNDS=12
GENESIS_INPUT_TOKEN_BUDGET=12000
GENESIS_OUTPUT_TOKEN_BUDGET=4096
GENESIS_MAX_MESSAGE_CHARACTERS=120000
```

O contrato sempre prevalece quando for mais restritivo que esses tetos globais.

## Contabilidade

O painel separa tokens enviados/recebidos reportados pelo modelo, estimativas quando `usage` não vem, requests reportados/estimados/desconhecidos, consumo por modelo, custo retornado e economia local de contexto. O histórico de consumo é independente das mensagens exibidas: editar uma mensagem não apaga requests já cobrados.

## SupremeMind e Neural

O SupremeMind trabalha localmente: inventaria arquivos textuais seguros, extrai símbolos e dependências, cria chunks pesquisáveis, calcula PageRank, bacias, impacto e órbita, e mantém memórias estruturadas. Segredos, certificados, chaves, binários e índices antigos inseguros são recusados.

Acesse `http://127.0.0.1:7331/neural/neural.html` para acompanhar tarefas e consumo, criar o índice, explorar o grafo, consultar contexto/impacto/órbita, manter memórias e diagnosticar provedores e eventos.

Leia `SUPREMEMIND_PODER.txt` para a explicação completa e `EVOLUCAO_GENESIS_2_1.txt` para o mapa de evolução.

## Verificação

```powershell
npm test
npm run check
```

## Segurança e dados locais

- O servidor escuta `127.0.0.1` por padrão.
- Conversas, tarefas, telemetria e configurações ficam em `.genesis/`.
- O índice do projeto fica em `.suprememind/` dentro do projeto aberto.
- Conteúdo de projeto e anexos é tratado como dado não confiável.
- Arquivos sensíveis não entram no inventário nem no índice.
- Operações de escrita não podem sair da raiz real do projeto.
