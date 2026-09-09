# Limpeza profissional do Genesis

O Genesis possui uma separação importante entre o **código versionado** e os **dados locais gerados em runtime**. O repositório GitHub é pequeno; instalações locais podem crescer vários gigabytes por causa de engines de voz, ambientes Python, modelos, caches e resíduos de instalação.

## Comandos

Auditoria sem excluir nada:

```bash
npm run cleanup:audit
```

Aplicação da limpeza segura:

```bash
npm run cleanup
```

O modo de auditoria é sempre recomendado antes da aplicação. A limpeza usa `git ls-files` como barreira: se o Git não puder confirmar quais arquivos são versionados, nenhuma exclusão é executada.

## O que pode ser removido automaticamente

Somente resíduos que podem ser recriados e que não fazem parte do código versionado:

- `node_modules` local quando não contém arquivos rastreados;
- caches de teste e ferramentas (`.cache`, `coverage`, `.nyc_output`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`);
- `.genesis/voice/tmp`;
- `.genesis/voice/downloads`;
- diretórios temporários `.genesis/voice/extract-*`;
- ambientes `venv-*.failed-*` criados por tentativas de instalação que já falharam;
- backups `venv-*.backup-*` **somente quando o ambiente ativo correspondente passa em um teste real de imports**;
- `__pycache__`, `.pyc`, `.pyo`, `.tmp`, `.log` e `.download` dentro do runtime de voz;
- metadados locais `.DS_Store` e `Thumbs.db`.

## O que é preservado deliberadamente

A rotina não remove automaticamente:

- `.git` e seu histórico;
- qualquer arquivo rastreado pelo Git;
- código-fonte, testes, documentação e scripts;
- `.suprememind` e memória/indexação de projetos;
- conversas, anexos, configurações ou estado geral dentro de `.genesis`;
- modelos ativos de Whisper, Piper, Kokoro e Chatterbox;
- ambientes Python ativos;
- `hf-cache` do Chatterbox, pois ele pode conter pesos necessários em runtime;
- arquivos cuja função não possa ser determinada com segurança.

A regra é conservadora: **na dúvida, preservar**.

## Por que uma instalação pode ultrapassar 8 GB

O sistema de voz opcional é a maior fonte legítima de uso de disco. O instalador informa que o Chatterbox usa cerca de 3,2 GB apenas em pesos principais, além de PyTorch e demais dependências; Kokoro também instala PyTorch e pode superar 1 GB. Ambientes virtuais antigos preservados como `venv-*.backup-*` podem duplicar boa parte desse tamanho. A limpeza detecta esses backups e só os remove quando o ambiente ativo foi validado.

## Observação sobre modelos opcionais

Modelos ativos não são considerados lixo. Se a intenção for desinstalar uma engine de voz inteira para liberar vários gigabytes, isso deve ser uma ação explícita porque altera funcionalidades. Para remover todos os componentes opcionais de voz existe o fluxo oficial do instalador:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-voice.ps1 -Remove
```

Esse comando remove o runtime/modelos opcionais de `.genesis/voice`, portanto não faz parte da limpeza automática conservadora.
