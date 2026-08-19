# 🧠 SupremeMind — Guia de Ajuda e Comandos

Este documento explica como instalar, iniciar, usar e diagnosticar o **SupremeMind**.

O SupremeMind cria um índice local do seu projeto, extrai símbolos e dependências, monta um grafo estrutural, analisa o histórico Git, mantém memória persistente e entrega contexto compacto para o Codex e outros agentes.

> O SupremeMind não altera os pesos internos da IA. Ele melhora a qualidade do contexto enviado ao agente.

---

# 1. Requisitos

- **Node.js 20 ou superior**.
- **Git** instalado e disponível no terminal.
- Windows, Linux ou macOS.
- Permissão de leitura no projeto analisado.

Confira as versões:

```bash
node --version
git --version
```

---

# 2. Instalação

## Windows — instalação automática

Na pasta do SupremeMind:

```bat
install.bat
```

O instalador registra o comando global:

```bash
suprememind
```

## Instalação manual

```bash
npm install
npm link
```

## Execução sem instalação global

```bash
node ./bin/suprememind.js --help
```

---

# 3. Fluxo recomendado

Entre na pasta do projeto que deseja analisar:

```bash
cd C:\caminho\do\seu\projeto
```

Depois execute:

```bash
suprememind init
suprememind index
suprememind doctor
```

Agora o projeto está pronto para consultas:

```bash
suprememind query "onde o login é validado"
suprememind context "corrigir persistência do usuário" --budget 6000
```

Fluxo completo recomendado:

```text
init
  ↓
index
  ↓
query ou context
  ↓
orbit e impact
  ↓
editar e testar
  ↓
remember
  ↓
update
```

---

# 4. Resumo dos comandos

| Comando | Finalidade |
|---|---|
| `help` | Mostra ajuda rápida no terminal |
| `version` | Mostra a versão instalada |
| `init` | Inicializa o SupremeMind no projeto |
| `index` | Cria ou recria o índice do projeto |
| `update` | Atualiza o índice reutilizando arquivos inalterados |
| `query` | Pesquisa arquivos e símbolos relevantes |
| `context` | Monta contexto compacto para uma tarefa |
| `orbit` | Exibe dependências de entrada, saída e vizinhança |
| `impact` | Calcula o risco de alterar um arquivo |
| `remember` | Salva uma decisão ou descoberta na memória |
| `recall` | Recupera memórias salvas |
| `graph` | Gera o mapa visual SupremeMind Galaxy |
| `serve` | Inicia o servidor HTTP local e JSON-RPC |
| `doctor` | Verifica a saúde da instalação e do índice |
| `benchmark` | Mede o tempo de busca e montagem de contexto |

---

# 5. Ajuda e versão

## Exibir ajuda

```bash
suprememind help
```

Também funciona:

```bash
suprememind --help
suprememind -h
```

## Exibir versão

```bash
suprememind version
```

Também funciona:

```bash
suprememind --version
suprememind -v
```

---

# 6. `init` — Inicializar o projeto

Cria a configuração e a pasta de estado local do SupremeMind.

```bash
suprememind init
```

Inicializar outro diretório:

```bash
suprememind init "C:\Projetos\MiniMarket"
```

Após a inicialização, são usados normalmente:

```text
suprememind.config.json
.suprememind/
```

A pasta `.suprememind` contém o índice, memórias e dados locais do projeto.

---

# 7. `index` — Indexar o repositório

Analisa os arquivos, extrai símbolos, dependências, chamadas, histórico Git, PageRank e bacias de atração.

```bash
suprememind index
```

Indexar um caminho específico:

```bash
suprememind index "C:\Projetos\MiniMarket"
```

Forçar reprocessamento completo:

```bash
suprememind index --force
```

Ou:

```bash
suprememind index "C:\Projetos\MiniMarket" --force
```

### Quando usar `--force`

Use quando:

- o índice parecer corrompido;
- a configuração de parsing tiver mudado;
- arquivos importantes não aparecerem;
- o formato do índice tiver sido atualizado;
- desejar um reprocessamento integral.

Sem `--force`, o SupremeMind reutiliza arquivos cujo hash não mudou.

---

# 8. `update` — Atualização incremental

Atualiza o índice reaproveitando os dados dos arquivos que não foram modificados.

```bash
suprememind update
```

Para outro diretório:

```bash
suprememind update "C:\Projetos\MiniMarket"
```

Use após:

- editar arquivos;
- criar ou excluir módulos;
- trocar de branch;
- fazer `git pull`;
- aplicar um patch;
- concluir uma tarefa no Codex.

---

# 9. `query` — Pesquisar o projeto

Pesquisa arquivos por uma combinação de:

- BM25;
- similaridade semântica local;
- correspondência exata;
- centralidade do grafo;
- memória persistente.

Exemplo:

```bash
suprememind query "onde o cliente é autenticado"
```

Limitar a quantidade de resultados:

```bash
suprememind query "sistema de inventário" --limit 10
```

Pesquisar persistência:

```bash
suprememind query "salvamento dos dados do jogador"
```

Pesquisar rede:

```bash
suprememind query "envio e recebimento de pacotes"
```

### Como interpretar a saída

Exemplo:

```text
01. 87.4% src/auth/LoginManager.cpp
    Implementa autenticação e criação de sessão.
```

- `87.4%`: score relativo de relevância.
- caminho: arquivo encontrado.
- resumo: descrição estrutural gerada durante a indexação.

O score não é uma garantia absoluta. Relações importantes devem ser confirmadas no código.

---

# 10. `context` — Montar contexto para o Codex

Cria um relatório Markdown compacto com:

- núcleo principal;
- arquivos prioritários;
- símbolos;
- dependências de entrada e saída;
- bacia de atração;
- estimativa de tokens;
- orientação de inspeção.

Uso:

```bash
suprememind context "corrigir o login que alterna de posição"
```

Definir orçamento de tokens:

```bash
suprememind context "corrigir persistência do usuário" --budget 6000
```

Salvar em arquivo:

```bash
suprememind context "corrigir persistência do usuário" --budget 6000 --save CONTEXTO.md
```

Exemplo para o Codex:

```bash
suprememind context "corrigir movimentação e câmera sem alterar o comportamento original" --budget 8000 --save CODEX_CONTEXT.md
```

Depois, informe ao Codex:

```text
Leia CODEX_CONTEXT.md antes de explorar o restante do projeto.
```

### Escolha do orçamento

| Projeto/tarefa | Orçamento sugerido |
|---|---:|
| Correção pequena | 2.000–4.000 |
| Funcionalidade média | 4.000–8.000 |
| Refatoração de módulo | 8.000–12.000 |
| Investigação arquitetural | 10.000–16.000 |

Um orçamento maior inclui mais arquivos e informações, mas consome mais contexto da IA.

---

# 11. `orbit` — Ver conexões de um arquivo

Mostra:

- atrator da bacia;
- dependências de saída;
- dependências de entrada;
- arquivos próximos por nível.

```bash
suprememind orbit src/Auth/Login.cpp
```

Aumentar profundidade:

```bash
suprememind orbit src/Auth/Login.cpp --depth 3
```

### Interpretação

- `outgoing`: arquivos ou símbolos usados pelo alvo.
- `incoming`: arquivos que dependem do alvo.
- `levels[0]`: próprio arquivo.
- `levels[1]`: vizinhos diretos.
- `levels[2]`: vizinhos indiretos.
- `attractor`: núcleo estrutural da bacia.

Use esse comando antes de editar arquivos compartilhados.

---

# 12. `impact` — Análise de impacto

Calcula dependentes diretos e indiretos e classifica o risco da alteração.

```bash
suprememind impact src/Auth/Login.cpp
```

Definir profundidade:

```bash
suprememind impact src/Auth/Login.cpp --depth 4
```

Classificações:

```text
LOW
MODERATE
HIGH
CRITICAL
```

### Leitura do resultado

- `direct`: quantidade de dependentes diretos.
- `indirect`: quantidade de dependentes indiretos.
- `score`: pontuação de impacto.
- `risk`: classificação de risco.
- `impacted`: lista dos arquivos afetados.

Antes de alterar um arquivo `HIGH` ou `CRITICAL`:

1. leia os dependentes diretos;
2. verifique interfaces e estruturas compartilhadas;
3. execute testes relacionados;
4. preserve contratos públicos;
5. gere uma memória depois da validação.

---

# 13. `remember` — Salvar memória do projeto

Registra decisões, descobertas, correções e regras importantes.

## Windows CMD

```bat
suprememind remember ^
  --title "Fonte única do layout" ^
  --content "O cliente usa o banco como fonte única após sincronização." ^
  --files "LoginPanel.cpp,UILayoutRepository.cpp" ^
  --tags "ui,login,persistencia" ^
  --status success
```

## PowerShell

```powershell
suprememind remember `
  --title "Fonte única do layout" `
  --content "O cliente usa o banco como fonte única após sincronização." `
  --files "LoginPanel.cpp,UILayoutRepository.cpp" `
  --tags "ui,login,persistencia" `
  --status success
```

## Git Bash, Linux ou macOS

```bash
suprememind remember \
  --title "Fonte única do layout" \
  --content "O cliente usa o banco como fonte única após sincronização." \
  --files "LoginPanel.cpp,UILayoutRepository.cpp" \
  --tags "ui,login,persistencia" \
  --status success
```

### Campos

| Campo | Obrigatório | Função |
|---|---|---|
| `--title` | recomendado | Nome curto da memória |
| `--content` | sim | Explicação completa |
| `--files` | não | Arquivos separados por vírgula |
| `--tags` | não | Etiquetas separadas por vírgula |
| `--status` | não | Estado, como `success`, `failed`, `accepted` |

Boas memórias:

- causa real de um bug;
- fonte única de verdade;
- restrição de arquitetura;
- arquivo central de uma funcionalidade;
- correção testada;
- comportamento que não pode ser alterado;
- relação não óbvia entre cliente e servidor.

Evite salvar:

- senhas;
- tokens;
- chaves privadas;
- dados pessoais;
- hipóteses não verificadas como fatos.

---

# 14. `recall` — Recuperar memórias

```bash
suprememind recall "layout login"
```

Limitar resultados:

```bash
suprememind recall "persistência banco" --limit 5
```

Listar memórias recentes ou gerais:

```bash
suprememind recall ""
```

As memórias influenciam a busca híbrida e ajudam o SupremeMind a priorizar arquivos usados anteriormente.

---

# 15. `graph` — SupremeMind Galaxy

Gera um arquivo HTML interativo com o grafo do projeto.

```bash
suprememind graph
```

Nome personalizado:

```bash
suprememind graph --output MAPA_SUPREMEMIND.html
```

Depois abra o arquivo no navegador.

O Galaxy mostra:

- arquivos como nós;
- dependências como arestas;
- atratores centrais;
- bacias de atração;
- centralidade;
- busca de arquivos;
- painel de inspeção.

A visualização ajuda a compreender a arquitetura, mas não substitui a inspeção do código.

---

# 16. `serve` — Servidor local

Inicia o serviço HTTP local.

```bash
suprememind serve
```

Porta personalizada:

```bash
suprememind serve --host 127.0.0.1 --port 7331
```

Rotas principais:

```text
GET /health
GET /query?q=autenticacao&limit=20
GET /context?q=corrigir+login&budget=6000
POST /mcp
```

Exemplo no navegador:

```text
http://127.0.0.1:7331/health
```

Por segurança, mantenha o host em `127.0.0.1` para uso local.

Não use `0.0.0.0` em redes públicas sem autenticação e firewall.

---

# 17. `doctor` — Diagnóstico

Verifica:

- versão do SupremeMind;
- versão do Node.js;
- diretório do projeto;
- existência do índice;
- disponibilidade do Git;
- quantidade de bacias;
- estado geral.

```bash
suprememind doctor
```

Exemplo esperado:

```text
SupremeMind Doctor
- Versão: 0.1.0
- Node: v20.x.x
- Projeto: C:\Projetos\MiniMarket
- Índice: OK
- Git: OK
- Bacias: 42
- Estado: saudável
```

---

# 18. `benchmark` — Medição local

Executa consultas internas e mede:

- tempo de busca;
- tempo de montagem do contexto;
- arquivo principal encontrado;
- quantidade de arquivos selecionados;
- tokens estimados.

```bash
suprememind benchmark
```

O benchmark mede o motor de recuperação do SupremeMind. Ele não mede a velocidade de geração de tokens de um LLM.

Para uma comparação confiável:

1. use o mesmo projeto;
2. use o mesmo modelo;
3. use o mesmo prompt;
4. compare com e sem contexto do SupremeMind;
5. registre tokens, arquivos abertos, tempo e testes aprovados.

---

# 19. Usar outro diretório com `--root`

A maioria dos comandos pode apontar para um projeto sem entrar na pasta:

```bash
suprememind query "autenticação" --root "C:\Projetos\MiniMarket"
```

```bash
suprememind context "corrigir banco" --root "C:\Projetos\MiniMarket" --budget 6000
```

```bash
suprememind doctor --root "C:\Projetos\MiniMarket"
```

Para `index` e `update`, também é possível passar o diretório como argumento posicional.

---

# 20. Configuração

Arquivo:

```text
suprememind.config.json
```

Exemplo:

```json
{
  "version": 1,
  "projectName": "MiniMarket",
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

## Campos

| Campo | Descrição |
|---|---|
| `projectName` | Nome exibido nos relatórios |
| `maxFileSize` | Tamanho máximo de arquivo indexado, em bytes |
| `vectorDimensions` | Dimensões do vetor semântico local |
| `tokenBudget` | Orçamento padrão do comando `context` |
| `maxContextFiles` | Limite de arquivos em um contexto |
| `gitCommitLimit` | Quantidade máxima de commits analisados |
| `ignore` | Diretórios e nomes ignorados |

Após alterar a configuração, execute:

```bash
suprememind index --force
```

---

# 21. Arquivos locais criados

```text
.suprememind/
├── index.json
└── memories.jsonl
```

## `index.json`

Contém:

- arquivos indexados;
- símbolos;
- vetores;
- termos;
- arestas;
- PageRank;
- bacias;
- histórico Git processado;
- estatísticas.

## `memories.jsonl`

Contém uma memória JSON por linha.

A pasta `.suprememind` deve normalmente permanecer local e não precisa ser enviada ao Git.

Adicione ao `.gitignore`:

```gitignore
.suprememind/
suprememind-report.html
CODEX_CONTEXT.md
```

Memórias que precisam ser compartilhadas com a equipe devem ser transformadas em documentação versionada, como `ARCHITECTURE.md` ou `DECISIONS.md`.

---

# 22. Uso com Codex

## Fluxo manual

```bash
suprememind update
suprememind context "corrigir o problema descrito" --budget 8000 --save CODEX_CONTEXT.md
suprememind impact caminho/do/arquivo.cpp
```

Prompt recomendado:

```text
Leia CODEX_CONTEXT.md antes de explorar o projeto.
Confirme as relações de baixa confiança diretamente no código.
Antes de editar arquivos centrais, execute a análise de impacto.
Preserve o comportamento original e rode os testes ao final.
```

## Fluxo com Skill

A Skill do SupremeMind orienta o Codex a:

1. consultar o índice antes de abrir muitos arquivos;
2. priorizar L0 e L1;
3. executar `impact` antes de alterar nós centrais;
4. abrir código completo apenas quando necessário;
5. registrar uma memória após validação.

---

# 23. Exemplos práticos

## Investigar um bug de login

```bash
suprememind update
suprememind query "login alterna entre posição antiga e nova"
suprememind context "corrigir login que pisca entre duas posições" --budget 8000 --save LOGIN_CONTEXT.md
suprememind impact src/ui/LoginPanel.cpp
```

## Investigar persistência

```bash
suprememind query "onde os dados são salvos no banco"
suprememind context "corrigir perda de dados após reiniciar" --budget 7000
```

## Investigar rede

```bash
suprememind query "pacote de autenticação enviado ao servidor"
suprememind orbit src/network/AuthPacket.cpp --depth 3
suprememind impact src/network/AuthPacket.cpp --depth 4
```

## Investigar Unity

```bash
suprememind query "movimentação personagem câmera zig zag"
suprememind context "corrigir movimento sem alterar controles existentes" --budget 6000
```

## Registrar uma correção validada

```bash
suprememind remember --title "Lens Flare ocluído" --content "Ativar Screen Space Occlusion no Inspector corrige o flare aparecendo na frente dos objetos; manter o script original." --files "CicloDiaNoite.cs" --tags "unity,lens-flare,render" --status success
```

---

# 24. Erros comuns

## `suprememind` não é reconhecido

Execute na pasta do SupremeMind:

```bash
npm install
npm link
```

Feche e abra o terminal novamente.

Teste:

```bash
suprememind version
```

Alternativa:

```bash
node C:\caminho\SupremeMind\bin\suprememind.js --help
```

## Node.js antigo

Confira:

```bash
node --version
```

Use Node.js 20 ou superior.

## Índice não encontrado

Execute:

```bash
suprememind init
suprememind index
```

## Resultados ruins ou desatualizados

```bash
suprememind update
```

Se continuar:

```bash
suprememind index --force
```

## Arquivo não aparece

Verifique:

- se está na lista `ignore`;
- se ultrapassa `maxFileSize`;
- se é binário;
- se o comando está sendo executado na raiz correta;
- se a extensão é suportada.

## Git aparece indisponível

Teste:

```bash
git --version
git status
```

O SupremeMind continua funcionando sem Git, mas não terá coalterações e histórico completo.

## Porta já está em uso

Troque a porta:

```bash
suprememind serve --port 7332
```

## Galaxy muito carregado

Projetos grandes podem gerar muitas linhas. Use a busca lateral para localizar arquivos e analise por módulo.

---

# 25. Boas práticas

1. Execute `update` antes de uma nova tarefa.
2. Use `query` para exploração rápida.
3. Use `context` para preparar o Codex.
4. Use `orbit` para compreender relações.
5. Use `impact` antes de editar arquivos centrais.
6. Rode os testes reais do projeto.
7. Salve somente memórias verificadas.
8. Não trate score semântico como prova.
9. Não envie `.suprememind` com segredos ao Git.
10. Reindexe com `--force` após mudar configurações importantes.

---

# 26. Sequências prontas

## Uso diário

```bash
suprememind update
suprememind query "minha tarefa"
suprememind context "minha tarefa" --budget 6000 --save CODEX_CONTEXT.md
```

## Antes de editar

```bash
suprememind orbit caminho/do/arquivo.cpp --depth 2
suprememind impact caminho/do/arquivo.cpp --depth 3
```

## Depois de editar e testar

```bash
suprememind remember --title "Resumo da correção" --content "Descrição validada da causa e solução" --files "arquivo1.cpp,arquivo2.h" --status success
suprememind update
```

## Diagnóstico completo

```bash
suprememind doctor
suprememind benchmark
suprememind graph --output suprememind-report.html
```

---

# 27. Referência rápida

```text
suprememind init [diretório]
suprememind index [diretório] [--force]
suprememind update [diretório]
suprememind query <consulta> [--limit 20]
suprememind context <consulta> [--budget 6000] [--save arquivo.md]
suprememind orbit <arquivo> [--depth 2]
suprememind impact <arquivo> [--depth 3]
suprememind remember --title T --content C [--files a,b] [--tags x,y] [--status success]
suprememind recall <consulta> [--limit 10]
suprememind graph [--output arquivo.html]
suprememind serve [--host 127.0.0.1] [--port 7331]
suprememind doctor
suprememind benchmark
suprememind help
suprememind version
```

Parâmetro opcional para apontar outro projeto:

```text
--root "C:\caminho\do\projeto"
```

---

# 28. Suporte e diagnóstico ao relatar problemas

Ao abrir uma issue, informe:

```text
Sistema operacional:
Versão do Node.js:
Versão do Git:
Versão do SupremeMind:
Comando executado:
Saída completa do erro:
Linguagens do projeto:
Quantidade aproximada de arquivos:
Resultado de suprememind doctor:
```

Nunca publique chaves, senhas, tokens ou conteúdo confidencial do projeto.

---

**SupremeMind — contexto estrutural, memória persistente e análise de impacto para agentes de programação.**
