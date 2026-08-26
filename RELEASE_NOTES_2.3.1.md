# NewGenesis 2.3.1 — notas de release (rascunho)

Esta patch release estabiliza a linha 2.3 sem mudar as garantias econômicas do agente.

Destaques:

- persistência determinística e shutdown reutilizável, eliminando a race de `events.jsonl` observada no Windows;
- voz compatível com CSP estrita, microfone limitado à própria origem e fallback textual validado;
- bind somente em loopback, validação de `Host`/`Origin` e proteção de arquivos `.env`;
- versão canônica, documentação atualizada e `run_project_check` com heurística agregadora;
- CI ampliado para Node 20/22/24, Windows/Linux, browser real e SupremeMind.

Não há modelo pago automático, retry remoto escondido ou chamada OpenRouter no overview ASTRAEON.

Antes de publicar, complete `RELEASE_CHECKLIST.md`, confirme os jobs do PR e substitua no `CHANGELOG.md` a data “futura” pela data real. Nenhuma tag ou GitHub Release deve ser criada durante a preparação.
