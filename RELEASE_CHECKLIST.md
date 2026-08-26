# Checklist de release 2.3.1

## Código e segurança

- [ ] Revisar o diff final e confirmar escopo somente de estabilização.
- [ ] Confirmar política free-only, budgets, análise/mutação, ledger e redaction.
- [ ] Executar scanner de secrets no working tree e no histórico.
- [ ] Confirmar que `.env`, `.env.local` e variantes estão ignorados.
- [ ] Confirmar bind loopback e rejeição de `Host`/`Origin` externos.

## Validação

- [ ] `npm test` sem falhas, skips ou TODOs.
- [ ] `npm run check` sem falhas.
- [ ] `npm run test:browser` com voz suportada e degradada.
- [ ] `cd SupremeMind && npm run check`.
- [ ] Smoke de health, painel, Neural e shutdown.
- [ ] `git diff --check`.
- [ ] GitHub Actions verdes em Linux Node 20/22/24 e Windows Node 22.

## Publicação (somente com autorização)

- [ ] Atualizar a data de 2.3.1 no `CHANGELOG.md`.
- [ ] Revisar `RELEASE_NOTES_2.3.1.md` contra o diff/PR final.
- [ ] Fazer merge do PR aprovado na `main`.
- [ ] Criar tag anotada `v2.3.1` no commit correto.
- [ ] Criar GitHub Release com as notas revisadas.
- [ ] Verificar instalação/execução a partir do artefato publicado.
