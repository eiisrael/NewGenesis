# 🧠 SupremeMind

**SupremeMind** é uma camada local de inteligência de código para Codex e outros agentes de programação. Ele indexa repositórios, extrai símbolos, constrói um grafo bidirecional, analisa o histórico Git, mantém memória persistente e monta contexto compacto sob orçamento de tokens.

A versão **0.2.0** inclui o **SupremeMind Control Core**, uma interface gráfica completa para operar o sistema sem precisar memorizar comandos.

> O SupremeMind não modifica os pesos internos de um LLM. Ele melhora a seleção e a organização do contexto enviado ao agente.

## Interface gráfica

A GUI controla visualmente:

- seleção do projeto;
- inicialização;
- indexação normal, incremental e forçada;
- dashboard de arquivos, símbolos, arestas, bacias, Git e memórias;
- busca híbrida do código;
- geração de contexto para IA;
- Galaxy topológica interativa;
- análise de impacto;
- órbitas de callers e callees;
- navegador de arquivos e visualizador de código;
- criação e consulta de memórias persistentes;
- edição de configurações;
- diagnóstico e benchmark;
- log visual de operações.

### Iniciar a GUI

Dentro do projeto que deseja analisar:

```bash
suprememind gui
```

Também é possível informar a pasta:

```bash
suprememind gui "C:\Users\Home\Desktop\MeuProjeto"
```

Opções:

```text
--host 127.0.0.1   Endereço local
--port 7331        Porta da interface
--no-open          Não abrir o navegador automaticamente
```

No Windows, também é possível executar:

```text
SupremeMind-GUI.bat
```

A interface abre por padrão em:

```text
http://127.0.0.1:7331
```

## Instalação

### Windows

```text
install.bat
```

Depois, execute:

```bash
suprememind gui
```

### Instalação manual

Requisitos:

- Node.js 20 ou superior;
- Git recomendado para análise de coalterações.

```bash
npm install
npm link
```

Execução sem instalação global:

```bash
node ./bin/suprememind.js gui
```

## Fluxo recomendado pela GUI

1. Abra o **Control Core**.
2. Entre em **Projeto**.
3. Informe a pasta do projeto.
4. Clique em **Inicializar**.
5. Clique em **Indexar**.
6. Use **Busca neural** para localizar funcionalidades.
7. Use **Contexto IA** para preparar uma tarefa para o Codex.
8. Antes de alterar arquivos centrais, abra **Impacto e órbita**.
9. Após validar a solução, registre a decisão em **Memória**.

## Funcionalidades do motor

- Indexação incremental por SHA-256.
- Parsers estruturais leves para C/C++, C#, JavaScript, TypeScript, Python, JSON, Markdown, XML e configurações.
- Extração de classes, funções, métodos, imports/includes e chamadas prováveis.
- Grafo direcionado com dependências, chamadas e coalterações Git.
- Callers, callees, órbitas e análise de impacto.
- PageRank e agrupamento determinístico em bacias de atração.
- Busca híbrida com BM25, vetores semânticos locais, centralidade e memória.
- Memória persistente por projeto em JSONL.
- Geração de contexto Markdown com orçamento de tokens.
- Relatório SupremeMind Galaxy.
- Servidor HTTP local e MCP/JSON-RPC.
- CLI sem dependências externas de runtime.
- Operação local por padrão.

## Console avançado

A GUI cobre o fluxo completo, mas a CLI permanece disponível para automação:

```text
suprememind gui [diretório] [--host 127.0.0.1] [--port 7331] [--no-open]
suprememind init [diretório]
suprememind index [diretório] [--force]
suprememind update [diretório]
suprememind query <consulta> [--limit 20]
suprememind context <consulta> [--budget 6000] [--save contexto.md]
suprememind orbit <arquivo> [--depth 2]
suprememind impact <arquivo> [--depth 3]
suprememind remember --title T --content C [--files a,b]
suprememind recall <consulta>
suprememind graph [--output arquivo.html]
suprememind serve [--host 127.0.0.1] [--port 7331]
suprememind doctor
suprememind benchmark
```

## Como funciona

```text
Repositório
    ↓
Hash e parsing estrutural
    ↓
Grafo de arquivos e símbolos
    ↓
Dependências + chamadas + histórico Git
    ↓
PageRank + bacias de atração
    ↓
BM25 + vetor semântico + memória
    ↓
Seleção sob orçamento de tokens
    ↓
Contexto compacto para o agente
```

A recuperação atual combina aproximadamente:

```text
39% similaridade semântica local
30% BM25
12% correspondência exata de caminho
10% centralidade
 9% afinidade com memórias
```

Os pesos são valores iniciais e devem ser calibrados por projeto.

## Arquivos gerados no projeto analisado

```text
.suprememind/
├── index.json
├── memories.jsonl
└── suprememind-galaxy.html

suprememind.config.json
.suprememindignore
```

A pasta `.suprememind/` contém estado local e normalmente não deve ser versionada.

## Configuração

Exemplo de `suprememind.config.json`:

```json
{
  "version": 1,
  "projectName": "MeuProjeto",
  "maxFileSize": 2500000,
  "vectorDimensions": 128,
  "tokenBudget": 6000,
  "maxContextFiles": 15,
  "gitCommitLimit": 500,
  "ignore": [
    ".git",
    ".suprememind",
    "node_modules",
    "vendor",
    "third_party",
    "dist",
    "build",
    "bin",
    "obj",
    "Library",
    "Temp",
    "coverage"
  ]
}
```

Essas opções podem ser editadas diretamente pela GUI.

## Integração com Codex

O repositório inclui uma Skill em:

```text
.codex/skills/suprememind/SKILL.md
```

Fluxo recomendado:

1. gere o contexto pela tela **Contexto IA**;
2. entregue o Markdown ao Codex;
3. verifique o arquivo L0 e os primeiros L1;
4. analise o impacto dos arquivos centrais;
5. execute build e testes;
6. grave a decisão validada na memória.

## Segurança

- A GUI escuta apenas em `127.0.0.1` por padrão.
- O indexador não executa o código do projeto.
- Caminhos de arquivo são limitados à raiz ativa.
- Requisições têm limite de tamanho.
- Comandos expostos pela GUI usam uma lista fechada de ações.
- Arquivos binários e ignorados não são indexados.
- Não exponha a GUI na rede sem autenticação, firewall e revisão de segurança.

Leia [SECURITY.md](SECURITY.md) antes de usar em projetos sensíveis.

## Testes

```bash
npm test
npm run check
```

Os testes cobrem:

- indexação e busca;
- contexto;
- memória;
- análise de impacto;
- Galaxy;
- inicialização e operação pela GUI;
- API local;
- leitura segura de arquivos.

## Limitações atuais

- Os parsers estruturais usam análise léxica/regex na versão atual.
- Chamadas dinâmicas, reflexão, macros complexas e ponteiros de função podem não ser totalmente resolvidos.
- Os vetores semânticos são locais por feature hashing; ONNX e HNSW estão planejados.
- A contagem de tokens é estimada.
- O MCP ainda não cobre todos os transportes do protocolo.
- A GUI é uma aplicação local servida no navegador; ainda não é empacotada como executável nativo independente.

## Documentação

- [HELP.md](HELP.md) — guia de comandos e solução de problemas.
- [GUI.md](GUI.md) — guia completo da interface gráfica.
- [ARCHITECTURE.md](ARCHITECTURE.md) — arquitetura do sistema.
- [SECURITY.md](SECURITY.md) — política e recomendações de segurança.

## Licença

MIT. Consulte [LICENSE](LICENSE).
