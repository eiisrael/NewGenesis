const normalize = value => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[!?.,;:]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const NAME = '(?:genesis|genesys|genesis chat|chat)';
const GREETING = new RegExp(`^(?:(?:oi|ola|opa|e ai|bom dia|boa tarde|boa noite)(?: ${NAME})?|${NAME} (?:oi|ola|bom dia|boa tarde|boa noite))$`);
const HEARING = new RegExp(`^(?:${NAME} )?(?:(?:voce )?(?:esta|ta) )?me (?:ouvindo|escutando)$`);
const HOW_ARE_YOU = new RegExp(`^(?:(?:oi|ola) )?(?:${NAME} )?(?:como (?:voce )?(?:esta|ta)|tudo bem)(?: ${NAME})?$`);
const THANKS = /^(?:obrigad[oa]|muito obrigad[oa]|valeu)(?: genesis)?$/;
const GOODBYE = /^(?:tchau|ate mais|ate logo|falou)(?: genesis)?$/;
const WAKE = new RegExp(`^(?:ei )?${NAME}$`);

function previousGreetingCount(conversation) {
  return (conversation?.messages || []).filter(message => message.role === 'user' && GREETING.test(normalize(message.content))).length;
}

function descriptor(content, message = 'Conversa social respondida localmente, com continuidade e sem consumir uma rota remota.') {
  return { content, model: 'genesis-conversation-local', message };
}

/** Resolve apenas interações sociais inequívocas; pedidos mistos seguem o orquestrador. */
export function resolveConversationalResponse({ query, conversation = null, language = 'pt-BR', inputMode = 'text' } = {}) {
  const text = normalize(query);
  if (!text || text.length > 90) return null;
  const english = language === 'en-US';

  if (HEARING.test(text)) {
    if (english) return descriptor(inputMode === 'voice'
      ? 'Yes. I received your voice message and I can hear you. How can I help?'
      : 'Yes, I received your message. How can I help?');
    return descriptor(inputMode === 'voice'
      ? 'Sim. Recebi sua mensagem por voz e estou ouvindo você. Como posso ajudar?'
      : 'Sim, recebi sua mensagem. Como posso ajudar?');
  }
  if (HOW_ARE_YOU.test(text)) {
    return descriptor(english
      ? "I'm doing well and ready to talk. How are you?"
      : 'Estou bem e pronto para conversar. E você, como está?');
  }
  if (GREETING.test(text)) {
    const again = previousGreetingCount(conversation) > 0;
    return descriptor(english
      ? `${again ? 'Hello again!' : 'Hello!'} I'm here. How can I help?`
      : `${again ? 'Oi novamente!' : 'Oi!'} Estou aqui. Como posso ajudar?`);
  }
  if (THANKS.test(text)) return descriptor(english ? "You're welcome!" : 'Por nada! Quando precisar, estou aqui.');
  if (GOODBYE.test(text)) return descriptor(english ? 'See you soon!' : 'Até mais!');
  if (WAKE.test(text)) return descriptor(english ? "Yes? I'm here." : 'Sim? Estou aqui.');
  return null;
}

export function conversationalFailureMessage(error, contract, language = 'pt-BR') {
  const detail = String(error?.message || '').replace(/\s+/g, ' ').trim();
  if (language === 'en-US') {
    return `I couldn't complete this ${contract?.kind === 'analysis' ? 'analysis' : 'response'} right now because the free models are temporarily unavailable. Your message and conversation were preserved; please try again shortly.${detail ? ` Details: ${detail}` : ''}`;
  }
  const action = contract?.kind === 'analysis' ? 'esta análise' : contract?.kind === 'diagnose' ? 'este diagnóstico' : 'esta resposta';
  return `Não consegui concluir ${action} agora porque os modelos gratuitos estão temporariamente indisponíveis. Sua mensagem e o contexto da conversa foram preservados; tente novamente em instantes.${detail ? ` Detalhe: ${detail}` : ''}`;
}
