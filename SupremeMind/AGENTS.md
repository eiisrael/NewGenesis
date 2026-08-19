# AGENTS.md

## Projeto

SupremeMind é uma camada local de inteligência estrutural e memória persistente para agentes de programação.

## Regras de contribuição

- Use Node.js 20+ e APIs nativas sempre que possível.
- Preserve funcionamento offline e sem telemetria.
- Não introduza alegações de desempenho sem benchmark reproduzível.
- Não chame números aleatórios de tokens de LLM.
- Toda alteração de parser, grafo ou ranking deve incluir testes.
- Nunca execute arquivos do repositório durante a indexação.
- Mantenha o servidor em loopback por padrão.
- Execute `npm run check` antes de concluir uma alteração.
