# NewGenesis 2.4.0

> **Autoria e direitos autorais:** © 2026 **Erick Israel**.  
> Projeto distribuído sob a licença MIT. A autoria original e o aviso de copyright devem ser preservados conforme os termos do arquivo [`LICENSE`](LICENSE).

NewGenesis é um **agente local genérico e verificável**, desenvolvido para combinar conversa, análise de projetos, execução de tarefas, memória, telemetria, contexto estrutural e recursos de voz em uma única interface local.

A arquitetura integra o **SupremeMind** para compreensão estrutural do projeto, um orquestrador agentic com limites explícitos e uma política **free-only** para uso remoto via OpenRouter. Conversas, tarefas, preferências, memória canônica e telemetria permanecem no computador.

## O que o NewGenesis faz

O NewGenesis foi projetado para trabalhar como um agente que **analisa antes de agir, executa dentro de limites definidos e verifica o resultado**.

Principais capacidades:

- chat local com contexto contínuo;
- análise e diagnóstico de projetos;
- leitura, busca, edição e verificação de arquivos dentro da raiz autorizada;
- execução controlada de verificações do projeto;
- SupremeMind para índice estrutural, símbolos, dependências, contexto, impacto e grafo;
- memória local e histórico de tarefas;
- ledger de requests, tokens, ferramentas e resultados;
- telemetria local;
- área **Neural** para inspeção do runtime e do conhecimento estrutural;
- entrada e saída por voz com fallback para texto;
- roteamento somente por modelos gratuitos quando a OpenRouter é utilizada;
- proteções de orçamento, timeout, rede, segredos e mutação.

## Filosofia do projeto

O NewGenesis segue alguns princípios importantes:

1. **Local-first:** dados e estado do agente permanecem localmente sempre que possível.
2. **Verificável:** uma alteração não deve ser considerada concluída sem evidência ou verificação apropriada.
3. **Sem retry remoto oculto:** novas tentativas e fallbacks remotos entram no mesmo orçamento e aparecem no ledger.
4. **Free-only:** o roteamento automático aceita apenas `openrouter/free` e modelos explicitamente marcados com `:free`.
5. **Análise não é autorização de escrita:** pedidos de diagnóstico permanecem somente leitura até existir intenção real de alteração.
6. **Segurança por padrão:** o servidor opera apenas em loopback e arquivos sensíveis não devem entrar no Git.
7. **Fallback seguro:** ausência de APIs de voz, modelo remoto ou outros recursos opcionais não deve inutilizar o núcleo local.

---

# Requisitos

## Obrigatórios

| Componente | Requisito |
| --- | --- |
| Node.js | **20 ou superior** |
| npm | incluído com o Node.js |
| Navegador | Chrome, Chromium, Edge ou navegador moderno compatível |
| Sistema | Windows, Linux ou ambiente compatível com Node.js |

Para desenvolvimento, também é recomendado ter **Git** instalado.

A chave da OpenRouter é **opcional para recursos inteiramente locais** e necessária apenas quando uma resposta ou tarefa precisa utilizar modelos remotos.

## Verifique sua instalação

No terminal:

```powershell
node -v
npm -v
git --version
```

O projeto declara suporte a:

```text
Node.js >= 20
```

---

# Instalação

Clone o repositório:

```powershell
git clone https://github.com/eiisrael/NewGenesis.git
cd NewGenesis
```

O projeto raiz atualmente não depende de pacotes externos obrigatórios para o runtime principal, mas o comando padrão de preparação continua sendo:

```powershell
npm install
```

Depois inicie:

```powershell
npm start
```

No Windows também é possível utilizar:

```text
start.bat
```

Para encerrar com segurança a instância ativa na porta 7331 e iniciar outra:

```text
restart.bat
```

O reinício confirma primeiro que a porta pertence ao **Genesis New**. Ele não finaliza processos quando a porta estiver ocupada por outro serviço.

Abra no navegador:

```text
http://127.0.0.1:7331
```

A área Neural fica em:

```text
http://127.0.0.1:7331/neural/neural.html
```

---

# Configuração da OpenRouter

Para funções remotas, configure uma chave da OpenRouter.

O projeto inclui:

```text
.env.example
```

Você pode copiá-lo para:

```text
.env.local
```

Os arquivos reais `.env*` são ignorados pelo Git para reduzir o risco de publicação acidental de credenciais.

**Nunca publique uma chave real de API em commits, issues, logs ou documentação.**

---

# ASTRAEON e visão geral local

O pedido:

```text
Analise o Astraeon e retorne um bash com as informações do projeto.
```

é tratado como um **contrato especial de visão geral local**.

Nesse fluxo, o NewGenesis:

- usa o perfil local do projeto;
- consulta o contexto já disponível localmente;
- não chama a OpenRouter;
- registra **0 requests remotos**;
- registra **0 tokens remotos**.

Essa garantia é protegida por testes para impedir regressões.

---

# SupremeMind

O **SupremeMind** é a camada estrutural local do NewGenesis.

Ele pode:

- inventariar arquivos de texto seguros;
- extrair símbolos e dependências;
- criar chunks de contexto;
- calcular relações entre partes do projeto;
- construir e consultar um grafo estrutural;
- fornecer contexto relevante ao agente;
- analisar impacto de alterações;
- manter memórias estruturadas.

Quando existe um projeto indexado, o mesmo contexto seletivo do SupremeMind participa também da conversa normal com o Genesis, não apenas da Área Neural. O orçamento varia conforme a intenção (chat, explicação, código, depuração ou arquitetura), e a geração do índice faz parte da chave de cache para impedir respostas baseadas em uma versão estrutural antiga.

Arquivos potencialmente sensíveis ou inadequados para indexação, como segredos, certificados, chaves, binários e outros formatos inseguros, são recusados pelas proteções do sistema.

O SupremeMind possui também sua própria rotina de validação:

```powershell
cd SupremeMind
npm run check
```

---

# Área Neural

A interface Neural funciona como um cockpit técnico do NewGenesis.

Ela reúne informações como:

- tarefas;
- utilização;
- contexto;
- grafo;
- impacto;
- órbita;
- memória;
- estado do runtime;
- diagnóstico estrutural.

Endereço padrão:

```text
http://127.0.0.1:7331/neural/neural.html
```

---

# Voz

A voz é uma camada modular sobre o mesmo composer, histórico e orquestrador. **Conversa por voz** detecta início/fim da fala, envia automaticamente, fala sentenças estáveis durante o streaming, volta a ouvir e aceita barge-in para cancelar TTS. Push-to-talk e chat textual continuam disponíveis.

O core inicia sem Python/modelos. `SpeechRecognition` permanece apenas como fallback de entrada. A saída automática usa uma voz pt-BR marcada como local pelo sistema enquanto Piper/Whisper aquecem em segundo plano; depois prefere o worker local saudável. Kokoro continua opcional e Chatterbox pt-BR experimental.

Para instalar o perfil local validado no Windows:

```powershell
npm run voice:diagnose
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component whisper -Profile rapid -AcceptDownload
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component kokoro -AcceptDownload -AcceptLargeDownload
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Component piper -AcceptDownload
```

Se as APIs e engines não estiverem disponíveis, **o chat textual continua funcionando normalmente** e os controles incompatíveis são desativados.

## Privacidade da voz

O áudio não é armazenado nem registrado. Arquivos temporários são removidos deterministicamente. O reconhecimento do navegador pode usar serviço online do fornecedor; **Preferir voz 100% local** impede esse fallback. O microfone é limitado à própria origem e a geolocalização do navegador é bloqueada. Cidade, data, hora e clima são respondidos no chat pelo próprio Genesis; a cidade deve ser declarada na conversa e não aparece em widget. A CSP continua `style-src 'self'; script-src 'self'` e as preferências ficam no armazenamento local do navegador.

Guias: [`docs/VOICE.md`](docs/VOICE.md), [`docs/VOICE_SETUP_WINDOWS.md`](docs/VOICE_SETUP_WINDOWS.md), [`docs/VOICE_ARCHITECTURE.md`](docs/VOICE_ARCHITECTURE.md), [`docs/VOICE_BENCHMARK.md`](docs/VOICE_BENCHMARK.md) e [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

# Ferramentas de projeto

O agente possui ferramentas controladas para trabalhar dentro do projeto aberto.

## Busca

`search_project`:

- aceita até **6 termos alternativos**;
- retorna no máximo **18 ocorrências**;
- contextualiza até **8 resultados**.

## Leitura

`read_project_file`:

- retorna no máximo **220 linhas** por chamada;
- limita a saída a **8.000 caracteres sanitizados**;
- utiliza paginação explícita quando necessário.

## Limites estruturais

- arquivo individual analisável: até **2 MiB**;
- inventário: até **10.000 arquivos**;
- texto seguro inventariado: até **128 MiB**.

## Escrita e mutação

Operações de criação, substituição, edição e movimentação permanecem dentro da raiz real do projeto aberto.

Exclusões só são disponibilizadas quando o pedido do usuário realmente autoriza exclusão.

Pedidos de análise ou diagnóstico permanecem em modo somente leitura. A simples presença de palavras como `fix`, `delete` ou trechos de código não constitui, por si só, autorização de mutação.

## Verificação automática

`run_project_check=auto` procura uma rotina segura de validação e pode preferir um script `check` quando ele claramente agrega múltiplas verificações.

A execução continua protegida por:

- allowlist de comandos;
- ambiente reduzido;
- isolamento na raiz do projeto;
- timeout de **120 segundos**;
- saída sanitizada.

---

# Orçamento global

Os valores definidos em `src/config.js` são **tetos**, e não uma promessa de consumo.

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

Esses limites podem ser reduzidos por variáveis como:

```text
GENESIS_MAX_ROUTES_PER_MESSAGE
GENESIS_MAX_REQUESTS_PER_MESSAGE
GENESIS_MAX_TOOL_REQUESTS_PER_MESSAGE
GENESIS_MAX_TOOL_ROUNDS
GENESIS_INPUT_TOKEN_BUDGET
GENESIS_OUTPUT_TOKEN_BUDGET
GENESIS_MAX_MESSAGE_CHARACTERS
GENESIS_REQUEST_TIMEOUT_MS
```

---

# Orçamento efetivo por contrato

O menor valor entre configuração global, capacidade do modelo e contrato da tarefa prevalece.

| Contrato | Requests | Entrada cumulativa | Entrada/request | Reserva final | Deadline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Visão geral local | 0 | 0 | 0 | 0 | local |
| Análise/diagnóstico | 3 | 30.000 | 14.000 | 1 | 90 s |
| Resposta comum | 4 | 36.000 | 12.000 | 1 | 90 s |
| Mudança/correção comum | 6 | 72.000 | 14.000 | 1 | 180 s |
| Mudança/correção ampla | 14 | 144.000 | 16.000 | 1 | 240 s |

O contexto realmente enviado pode ser menor por causa da janela do modelo, reserva de saída, orçamento restante e limite interno do motor.

Cada chamada remota é contabilizada antes de sair. Fallbacks e continuações remotas também consomem orçamento e ficam visíveis no ledger.

---

# Contabilidade e resultado verificável

O NewGenesis diferencia execução de sucesso real.

Não são transformados artificialmente em “sucesso verificado” casos como:

- streaming incompleto;
- EOF sem término válido;
- timeout;
- STOP;
- `finish_reason=error`;
- `finish_reason=length`.

Requests e tokens reportados continuam sendo contabilizados mesmo quando uma operação termina com erro, timeout ou interrupção.

Editar uma mensagem não apaga consumo já realizado.

---

# Telemetria e shutdown

A 2.3.1 adicionou um ciclo de desligamento determinístico para corrigir a race de `events.jsonl` observada especialmente no Windows.

Ao encerrar, o runtime pode:

1. parar de aceitar novas requisições;
2. cancelar operações ativas;
3. encerrar conexões SSE;
4. aguardar o fechamento HTTP;
5. drenar stores e filas de telemetria;
6. concluir a saída de maneira controlada.

A fila de telemetria também foi endurecida para não produzir `unhandledRejection` quando uma escrita falha; a falha continua podendo ser observada deterministicamente pelo fluxo de `flush()`.

---

# Segurança de rede

Por padrão, o NewGenesis foi feito para uso **local**.

O servidor aceita bind apenas em:

```text
127.0.0.0/8
::1
localhost
```

São recusados, nesta versão:

- `0.0.0.0`;
- IP de LAN;
- hostname externo;
- exposição remota direta.

Também existem validações de `Host` e `Origin` para impedir acesso por origens externas inesperadas.

O header:

```text
x-genesis-client: web
```

é uma barreira da interface contra determinados fluxos indevidos, **não um mecanismo de autenticação**.

O NewGenesis 2.3.1 não declara suporte a exposição remota segura. Não publique a porta `7331` diretamente na Internet.

Consulte [`SECURITY.md`](SECURITY.md) para orientações de segurança e comunicação responsável de vulnerabilidades.

---

# O que mudou na 2.3.1

A 2.3.1 é uma patch de estabilização da linha 2.3.

Entre as principais correções e melhorias estão:

- correção determinística da race de telemetria/`events.jsonl` no Windows;
- lifecycle reutilizável e shutdown seguro;
- drenagem de filas de telemetria antes da saída;
- correção de `unhandledRejection` em falhas de escrita de telemetria;
- CSS da voz compatível com CSP estrita;
- microfone limitado à própria origem;
- fallback textual validado quando APIs de voz não existem;
- proteção de `.env`, `.env.local` e outros `.env*`;
- `.env.example` seguro;
- bind restrito a loopback;
- validação de `Host` e `Origin`;
- versão canônica derivada de `package.json`;
- remoção de cache keys antigas divergentes de versão;
- melhoria da heurística de `run_project_check=auto`;
- manutenção da allowlist de comandos e remoção de execução insegura por shell no Windows;
- testes de regressão para Windows, telemetria, shutdown, CSP, rede, versão e ferramentas;
- smoke test real de voz em Chrome/Chromium;
- CI modernizado para Node 20/22/24, Linux e Windows;
- validação explícita do SupremeMind;
- documentação, changelog, política de segurança, licença e checklist de release sincronizados.

A estabilização preserva as garantias anteriores: **free-only, ausência de retry remoto oculto, orçamento explícito, separação entre análise e mutação, ledger, redaction de segredos e overview ASTRAEON sem OpenRouter**.

---

# Testes

## Testes principais

```powershell
npm test
```

## Verificação completa

```powershell
npm run check
```

## Smoke de navegador e voz

```powershell
npm run test:browser
```

O smoke de navegador requer Chrome, Chromium ou Edge. Também é possível apontar explicitamente o executável com `CHROME_PATH`.

## Benchmarks locais de voz

```powershell
npm run voice:benchmark:loopback
npm run voice:benchmark:resources
npm run voice:benchmark
```

## SupremeMind

```powershell
cd SupremeMind
npm run check
```

Na preparação da 2.3.1, a validação registrada no PR de estabilização alcançou:

```text
npm test            158/158 testes aprovados
npm run check       158/158 testes aprovados + syntax checks
SupremeMind check   4/4 testes aprovados + syntax + npm pack --dry-run
```

Sem testes ignorados para esconder regressões.

Neste branch 2.4, a validação atual aprovou **237/237** testes na suíte principal, manteve o SupremeMind em **4/4** com empacotamento seco e aprovou o smoke test real do navegador para conversa, barge-in, degradação e reprodução local.

---

# CI

A matriz de CI da 2.3.1 cobre:

| Ambiente | Validação |
| --- | --- |
| Ubuntu + Node 20 | projeto principal |
| Ubuntu + Node 22 | projeto principal |
| Ubuntu + Node 24 | projeto principal |
| Windows + Node 22 | projeto principal |
| Chrome/Chromium | smoke real de navegador/voz |
| SupremeMind | check próprio e empacotamento seco |

Os workflows usam Actions atualizadas para runtimes internos modernos e possuem timeouts definidos.

---

# Estrutura resumida

```text
NewGenesis/
├── public/                  Interface principal
├── scripts/                 Rotinas auxiliares e smoke de navegador
├── src/                     Runtime e backend do NewGenesis
│   ├── core/                Orquestração e núcleo agentic
│   ├── config.js            Configuração e limites
│   ├── project-tools.js     Ferramentas de projeto
│   ├── runtime-lifecycle.js Lifecycle e shutdown
│   ├── server.js            Servidor HTTP local
│   └── telemetry.js         Telemetria local
├── SupremeMind/             Motor estrutural local
├── test/                    Testes automatizados
├── .env.example             Exemplo seguro de configuração
├── CHANGELOG.md             Histórico de mudanças
├── SECURITY.md              Política de segurança
├── RELEASE_CHECKLIST.md     Checklist de release
├── RELEASE_NOTES_2.3.1.md   Notas da 2.3.1
├── LICENSE                  Licença MIT e copyright
└── README.md                Este documento
```

A decomposição ampla de módulos grandes, como `server.js`, orchestrator e integrações extensas, permanece uma melhoria arquitetural futura. A estabilização 2.3.1 priorizou correções comprovadas sem misturar um grande refactor estrutural.

---

# Documentação adicional

Consulte também:

- [`CHANGELOG.md`](CHANGELOG.md) — mudanças por versão;
- [`RELEASE_NOTES_2.3.1.md`](RELEASE_NOTES_2.3.1.md) — detalhes da patch 2.3.1;
- [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) — etapas para publicação;
- [`SECURITY.md`](SECURITY.md) — segurança e reporte responsável;
- [`SupremeMind/README.md`](SupremeMind/README.md) — documentação do SupremeMind;
- `RELATORIO_TECNICO.txt` — relatório técnico do estado atual;
- `EVOLUCAO_GENESIS_2_1.txt` — documento histórico da linha 2.1.

---

# Autoria, copyright e licença

**Autor e mantenedor original:** **Erick Israel**  
**Copyright:** © 2026 Erick Israel. Todos os direitos autorais sobre a obra original são atribuídos ao seu autor nos termos aplicáveis.

O código deste repositório é disponibilizado sob a **MIT License**, conforme o arquivo [`LICENSE`](LICENSE).

A licença MIT permite uso, cópia, modificação, distribuição, sublicenciamento e comercialização do software, desde que o **aviso de copyright e o texto de permissão da licença sejam mantidos nas cópias ou partes substanciais do software**.

A disponibilização sob MIT **não remove a autoria original de Erick Israel** nem autoriza a remoção do aviso de copyright exigido pela própria licença.

Ao redistribuir ou utilizar partes substanciais deste projeto, preserve:

```text
Copyright (c) 2026 Erick Israel
```

e o texto da licença MIT correspondente.

---

## NewGenesis

Criado e mantido por **Erick Israel**.

© 2026 Erick Israel — NewGenesis.  
Licenciado sob MIT; consulte [`LICENSE`](LICENSE).
