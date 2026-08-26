# Política de segurança

## Versões suportadas

As linhas 2.4.x e 2.3.x recebem correções de segurança. Versões históricas devem ser atualizadas antes de diagnóstico.

## Como reportar

Não abra uma issue pública com credenciais, exploits ou dados privados. Use **Security → Report a vulnerability** no repositório GitHub para iniciar um aviso privado. Inclua impacto, pré-condições, versão/commit, passos mínimos de reprodução e uma correção sugerida, se houver.

Nunca anexe chaves reais. Revogue imediatamente qualquer credencial que possa ter sido exposta.

## Limites de implantação

NewGenesis é um aplicativo local. Ele aceita somente loopback e não oferece autenticação para uso remoto. Não publique a porta por proxy, túnel, container ou regra de firewall. O cabeçalho `x-genesis-client` não é autenticação.

## Superfície de voz

`/api/voice/transcribe`, `/api/voice/synthesize` e `/api/voice/metrics` são endpoints locais same-origin e exigem a barreira da UI nas mutações. Áudio é limitado a WAV PCM mono 16-bit, 10 MiB e 45 s; texto TTS é limitado a 2.000 caracteres; concorrência é 1 por engine e há timeouts. O manifesto não pode resolver caminhos fora de `.genesis/voice`, processos são iniciados sem shell e encerrados com o lifecycle.

Não há retenção intencional de áudio. Arquivos temporários são removidos após sucesso/erro e no shutdown. Métricas de voz não aceitam texto transcrito nem buffers. O fallback `SpeechRecognition` pode usar rede do fornecedor; ative “Preferir voz 100% local” para proibi-lo.
