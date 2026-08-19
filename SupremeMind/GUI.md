# SupremeMind Control Core — Guia da Interface Gráfica

Este guia explica como operar o **SupremeMind 0.2.0** usando apenas a interface gráfica.

---

# 1. Abrindo a interface

Na pasta do projeto que deseja analisar:

```bash
suprememind gui
```

Ou informando o projeto:

```bash
suprememind gui "C:\Users\Home\Desktop\MeuProjeto"
```

No Windows, após executar `install.bat`, também é possível usar:

```text
SupremeMind-GUI.bat
```

A interface abre automaticamente em:

```text
http://127.0.0.1:7331
```

## Opções de inicialização

```bash
suprememind gui "C:\MeuProjeto" --port 7444
suprememind gui "C:\MeuProjeto" --no-open
suprememind gui "C:\MeuProjeto" --host 127.0.0.1 --port 7331
```

Por segurança, mantenha o host em `127.0.0.1`.

---

# 2. Dashboard

O Dashboard apresenta:

- quantidade de arquivos indexados;
- símbolos encontrados;
- relações do grafo;
- bacias de atração;
- memórias persistentes;
- commits Git analisados;
- principais atratores;
- operações recentes.

Quando os cartões exibirem `—`, o projeto ainda não foi indexado.

---

# 3. Projeto

A tela **Projeto** substitui os comandos principais do terminal.

## Carregar pasta

1. Cole o caminho completo no campo **Pasta do projeto**.
2. Clique em **Carregar pasta**.

Exemplo:

```text
C:\Users\Home\Desktop\MiniMarket\MiniMarket
```

## Inicializar

Clique em **Inicializar** para criar:

```text
.suprememind/
suprememind.config.json
.suprememindignore
```

## Indexar

Clique em **Indexar** para:

- ler arquivos aceitos;
- extrair símbolos;
- encontrar imports/includes;
- detectar chamadas prováveis;
- analisar Git;
- criar PageRank;
- formar bacias;
- salvar o índice.

## Atualizar

Clique em **Atualizar** após modificar o projeto.

Arquivos com o mesmo SHA-256 são reaproveitados. Apenas arquivos alterados são reprocessados.

## Reindexação total

Use **Reindexação total** quando:

- mudar `vectorDimensions`;
- alterar muitos padrões de exclusão;
- suspeitar de índice corrompido;
- atualizar o parser;
- precisar reconstruir tudo sem cache.

---

# 4. Busca neural

A tela **Busca neural** localiza arquivos relevantes por:

- texto exato;
- BM25;
- vetor semântico local;
- centralidade;
- caminho;
- memórias anteriores.

Exemplos de consultas:

```text
onde o login valida a senha
quem salva a posição do jogador
arquivos relacionados ao inventário
onde o servidor envia o pacote de personagem
```

Cada resultado mostra:

- relevância percentual;
- caminho;
- resumo estrutural;
- botão para abrir o arquivo.

A relevância é uma estimativa de recuperação, não uma prova absoluta.

---

# 5. Contexto IA

Use a tela **Contexto IA** antes de pedir alterações ao Codex.

## Procedimento

1. Escreva a tarefa completa.
2. Defina o orçamento de tokens.
3. Clique em **Gerar contexto**.
4. Copie ou baixe o Markdown.
5. Entregue o conteúdo ao Codex.

Exemplo de tarefa:

```text
Corrigir o login que alterna entre a posição antiga e a posição salva no banco. Preservar o comportamento original, não alterar layout de memória e verificar dependentes antes da edição.
```

O resultado contém:

- L0 — núcleo principal;
- L1/L2 — arquivos prioritários;
- atrator;
- chamadas de entrada e saída;
- relevância;
- estimativa de tokens;
- orientação para o agente.

## Orçamento de tokens

Valores sugeridos:

```text
2.000  tarefa pequena
6.000  tarefa normal
12.000 tarefa complexa
20.000 investigação ampla
```

Um orçamento maior não garante uma resposta melhor. O objetivo é incluir contexto suficiente sem excesso.

---

# 6. SupremeMind Galaxy

A tela **Galaxy** exibe o mapa visual do projeto.

Clique em **Gerar Galaxy** após indexar.

No mapa:

- cada nó representa um arquivo;
- o tamanho indica centralidade;
- conexões representam dependências, chamadas ou coalterações;
- arquivos agrupados convergem para atratores;
- cores diferenciam linguagens;
- o painel lateral mostra detalhes.

Controles:

- roda do mouse: zoom;
- arrastar: mover o mapa;
- clicar em nó: inspecionar;
- campo de busca: destacar arquivo.

---

# 7. Impacto e órbita

## Impacto

Informe um arquivo e clique em **Analisar impacto**.

A interface calcula:

- dependentes diretos;
- dependentes indiretos;
- profundidade;
- peso acumulado;
- classificação de risco.

Classificações:

```text
LOW       impacto pequeno
MODERATE  revisar dependentes
HIGH      alteração sensível
CRITICAL  nó central; exige testes amplos
```

Antes de alterar um arquivo `HIGH` ou `CRITICAL`:

1. leia os dependentes;
2. confirme relações de baixa confiança no código;
3. crie backup ou branch;
4. rode build;
5. execute testes.

## Órbita

Clique em **Mapear órbita** para ver:

- saídas: arquivos chamados ou importados;
- entradas: arquivos que chamam ou dependem;
- tipo da relação;
- peso;
- confiança;
- atrator associado.

---

# 8. Arquivos

A tela **Arquivos** funciona como navegador do índice.

É possível filtrar por:

- caminho;
- linguagem;
- bacia;
- nome de módulo.

Ao clicar em um arquivo, o conteúdo é carregado no visualizador.

Limites de segurança:

- somente arquivos dentro da raiz ativa;
- máximo de 2 MB por leitura na GUI;
- arquivos binários não são exibidos;
- caminhos com traversal são bloqueados.

---

# 9. Memória persistente

A tela **Memória** registra conhecimento que deve sobreviver às próximas sessões.

Campos:

- título;
- conteúdo;
- arquivos relacionados;
- tags;
- status.

Exemplo:

```text
Título: Fonte única do layout de login
Conteúdo: Após sincronizar com o banco, o cliente não deve reaplicar a configuração local antiga.
Arquivos: LoginPanel.cpp, UILayoutRepository.cpp
Tags: login, ui, persistencia
Status: success
```

Status sugeridos:

```text
recorded    informação registrada
success     decisão validada
warning     cuidado importante
deprecated  conhecimento antigo
```

As memórias ficam em:

```text
.suprememind/memories.jsonl
```

---

# 10. Configurações

A tela **Configurações** edita `suprememind.config.json`.

## projectName

Nome exibido no Dashboard e nos relatórios.

## maxFileSize

Tamanho máximo de arquivo indexado em bytes.

Padrão:

```text
2500000
```

## vectorDimensions

Dimensões do vetor semântico local.

Padrão:

```text
128
```

Após alterar, faça reindexação total.

## tokenBudget

Orçamento padrão para contexto.

## maxContextFiles

Quantidade máxima de arquivos resumidos no contexto.

## gitCommitLimit

Número de commits usados para calcular coalterações.

## ignore

Uma pasta por linha.

Exemplo:

```text
.git
.suprememind
node_modules
vendor
third_party
dist
build
bin
obj
Library
Temp
coverage
```

---

# 11. Diagnóstico

## Doctor

Verifica:

- versão;
- Node.js;
- raiz ativa;
- índice;
- Git;
- bacias;
- estado geral.

## Benchmark

Executa consultas de referência e mede:

- tempo de busca;
- tempo de contexto;
- principal resultado;
- arquivos selecionados;
- tokens estimados.

Esse benchmark mede o SupremeMind local. Ele não mede velocidade de inferência de GPT, Claude ou Qwen.

---

# 12. Logs de operação

A interface mantém um histórico da sessão com:

- ação;
- horário;
- duração;
- sucesso ou erro;
- saída resumida.

O console visual da tela Projeto mostra a saída completa das operações principais.

---

# 13. Erros comuns

## A interface não abre

```bash
node --version
suprememind --help
suprememind gui --no-open
```

Depois abra manualmente:

```text
http://127.0.0.1:7331
```

## Porta ocupada

```bash
suprememind gui --port 7444
```

## SupremeMind não encontrado

Na pasta do SupremeMind:

```bash
npm install
npm link
```

## Projeto sem índice

Na GUI:

1. carregue a pasta;
2. inicialize;
3. indexe.

## Git indisponível

Confira:

```bash
git --version
```

A indexação continua funcionando, mas coalterações ficam desativadas.

## Resultado incorreto

- torne a consulta mais específica;
- use nomes de função ou domínio;
- reindexe após alterações;
- confira `.suprememindignore`;
- valide relações no código real.

---

# 14. Segurança

- Use somente em `127.0.0.1`.
- Não exponha a porta diretamente à internet.
- Adicione segredos ao `.suprememindignore`.
- Não indexe `.env`, chaves privadas ou dumps sensíveis.
- A GUI não executa o código analisado.
- A API aceita apenas ações previamente autorizadas.
- O visualizador não acessa caminhos fora do projeto.

---

# 15. Fluxo diário recomendado

```text
Abrir GUI
  ↓
Carregar projeto
  ↓
Atualizar índice
  ↓
Buscar funcionalidade
  ↓
Gerar contexto IA
  ↓
Analisar impacto
  ↓
Editar com Codex
  ↓
Build e testes
  ↓
Gravar memória validada
```

---

# 16. Comando rápido

```bash
suprememind gui "C:\Users\Home\Desktop\MeuProjeto"
```

A partir desse ponto, todas as operações normais podem ser realizadas pela interface.
