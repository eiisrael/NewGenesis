# Política de segurança

## Versões suportadas

A linha 2.3.x recebe correções de segurança. Versões históricas devem ser atualizadas antes de diagnóstico.

## Como reportar

Não abra uma issue pública com credenciais, exploits ou dados privados. Use **Security → Report a vulnerability** no repositório GitHub para iniciar um aviso privado. Inclua impacto, pré-condições, versão/commit, passos mínimos de reprodução e uma correção sugerida, se houver.

Nunca anexe chaves reais. Revogue imediatamente qualquer credencial que possa ter sido exposta.

## Limites de implantação

NewGenesis 2.3.1 é um aplicativo local. Ele aceita somente loopback e não oferece autenticação para uso remoto. Não publique a porta por proxy, túnel, container ou regra de firewall. O cabeçalho `x-genesis-client` não é autenticação.
