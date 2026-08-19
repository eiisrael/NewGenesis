# SupremeMind Architecture

## Componentes

1. **File Walker** — percorre arquivos permitidos e aplica limites/ignores.
2. **Parser** — extrai símbolos, imports/includes e chamadas prováveis.
3. **Incremental Index** — reutiliza entradas cujo SHA-256 não mudou.
4. **Git Co-change** — reforça relações de arquivos alterados juntos.
5. **Graph Builder** — cria arestas de dependência, chamada e coalteração.
6. **Centrality** — calcula PageRank normalizado.
7. **Attraction Basins** — agrupa arquivos pela conexão dominante.
8. **Hybrid Retrieval** — BM25, vetor local, caminho, centralidade e memória.
9. **Context Assembler** — adiciona vizinhos e respeita orçamento de tokens.
10. **Memory Store** — persiste decisões e tarefas em JSONL.
11. **Galaxy** — gera visualização HTML autocontida.
12. **HTTP/MCP Adapter** — expõe busca, contexto, impacto, órbita e memória.

## Modelo de dados

### File node

```json
{
  "path": "src/Auth/Login.cpp",
  "language": "cpp",
  "summary": "...",
  "symbols": [],
  "imports": [],
  "calls": [],
  "terms": {},
  "vector": [],
  "hash": "sha256"
}
```

### Edge

```json
{
  "source": "src/A.cpp",
  "target": "src/B.h",
  "type": "dependency",
  "weight": 0.9,
  "confidence": 0.95
}
```

## Bacias

Para cada nó, a conexão dominante maximiza uma combinação do peso da aresta e centralidade do destino. O algoritmo segue a função de transição até encontrar um ciclo ou ponto fixo. O nó de maior PageRank do ciclo é o atrator da bacia.

## Complexidade

- Percorrer e analisar o repositório é pelo menos linear no volume lido.
- BM25 atual percorre os arquivos indexados.
- PageRank é iterativo sobre nós e arestas.
- Consultas em mapas/hash individuais têm custo médio próximo de O(1), mas isso não torna o pipeline completo O(1).
