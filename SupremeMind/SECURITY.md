# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

Não publique vulnerabilidades sensíveis em uma issue pública.

Envie um relato privado ao mantenedor do repositório contendo:

- versão afetada;
- sistema operacional;
- passos mínimos para reprodução;
- impacto observado;
- arquivos ou logs sem segredos;
- sugestão de correção, quando disponível.

Uma confirmação inicial deve ocorrer em até 7 dias. A correção será priorizada de acordo com impacto e possibilidade de exploração.

## Modelo de segurança

O SupremeMind foi projetado para trabalhar localmente. Ele não executa código indexado e o servidor usa `127.0.0.1` por padrão. Ainda assim:

- não indexe arquivos de segredo;
- revise `.suprememindignore`;
- não exponha a porta HTTP diretamente à internet;
- não versione `.suprememind/`;
- execute sob uma conta sem privilégios administrativos;
- mantenha Node.js e Git atualizados.
