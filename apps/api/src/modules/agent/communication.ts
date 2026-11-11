export const conversationGuidance = [
  'Write the customer reply in the language of their latest substantive message. Honor a clear request to change language. For a short acknowledgment, number, or identifier, continue in the language of the preceding customer turns. Set replyLanguage to the language used, as a BCP 47 code.',
  'Adapt formality, vocabulary and level of detail to the customer. For a straightforward request, lead with the answer or next step. For a confusing request, briefly reflect your understanding and ask one focused question only when the missing information matters. For frustration, acknowledge the specific impact once and calmly explain the next step. For urgency, put the safe immediate step first. Keep a respectful tone even if the customer is hostile. Avoid blame, emotional mimicry, stock apologies and unsupported promises.',
  'Write operator-facing summaries, factual explanations, handoff reasons and new request titles, goals and next steps in operatorLanguage, independently of the language of the reply. Translate the meaning of the request, distinguish customer reports from verified facts, and state what remains to check. Preserve names, identifiers, amounts, dates, status and evidence references.',
].join(' ');

export function operatorLanguage(value?: string): 'uk' | 'en' {
  return value === 'en' ? 'en' : 'uk';
}

export function languageCode(value?: string): string | undefined {
  if (!value || !/^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i.test(value)) return undefined;
  return value.split('-')[0]!.toLowerCase();
}

// A deterministic hint for server messages when a turn finishes before the model returns a language.
export function conversationLanguage(message: string, history: readonly { role: string; body: string }[] = []): string | undefined {
  const messages = [message, ...history.filter(item => item.role === 'customer').map(item => item.body).reverse()];
  for (const input of messages) {
    const value = input.normalize('NFC').toLowerCase().trim();
    if (/^(?:ok|okay|thanks|gracias|danke|obrigad[oa]|дякую|добре)[.! ]*$/u.test(value)) continue;
    if (/[а-яіїєґ]/u.test(value)) return /[ыэъё]/u.test(value) ? 'ru' : 'uk';
    if (/[¿¡ñ]/u.test(value) || /\b(?:hola|necesito|quiero|puede|pueden|cobro|cobraron|tarjeta|ayuda|gracias)\b/u.test(value)) return 'es';
    if (/[äöüß]/u.test(value) || /\b(?:hallo|ich|meine|bitte|zahlung|karte|erstattung|danke|wurde)\b/u.test(value)) return 'de';
    if (/[ãõç]/u.test(value) || /\b(?:olá|preciso|quero|podem|cartão|reembolso|obrigad[oa]|pagamento|cobrança)\b/u.test(value)) return 'pt';
    if (/\b(?:hello|please|thanks|need|want|payment|card|refund|charged|help|cancel|check)\b/u.test(value)) return 'en';
  }
  return undefined;
}

const messages = {
  en: {
    pendingRefund: (amount: string) => `I found two identical charges and prepared a refund of ${amount} for the duplicate. A specialist needs to approve it.`,
    denied: "I can't do this automatically under our policy, so I'm passing your request to a specialist.",
    handoff: 'I have passed your conversation to a human specialist. They will reply here.',
    refundCheck: 'I cannot confirm an automatic refund. Please tell me the date and amount of the charge.',
    cancellation: 'I cannot cancel the subscription automatically. A specialist can review your request.',
    billing: 'Please tell me the date and amount of the charge so I can check it.',
    clarify: 'How can I help?',
    fallback: "Thanks! I'm looking into this and a specialist will join if needed.",
    executionBlocked: 'We could not complete this action automatically. A specialist will follow up with you.',
    refundDone: (amount: string, merchant: string, reference: string) => `A simulated refund of ${amount} for the duplicate ${merchant} was completed in the demo (reference ${reference}). No money moved.`,
    refundFailed: 'No refund has been made. A specialist will review the request.',
    refundRejected: 'A support specialist did not approve an automatic refund. They will follow up with next steps.',
    refundUnknown: 'The result is not confirmed. A specialist will check it before anything is retried.',
    externalPending: (title: string) => `I prepared the request "${title}". A specialist needs to approve it.`,
    externalDone: (title: string, state: string | null) => `"${title}" is done${state ? ` (status: ${state})` : ''}.`,
    externalUnknown: (title: string) => `The result of "${title}" is not confirmed. A specialist will check it before anything is retried.`,
    externalFailed: (title: string) => `"${title}" was not completed.`,
    externalRejected: (title: string) => `A specialist did not approve "${title}" and will follow up with next steps.`,
  },
  uk: {
    pendingRefund: (amount: string) => `Я знайшов два однакові списання і підготував повернення ${amount} за дубль. Його має погодити спеціаліст.`,
    denied: 'Я не можу виконати це автоматично за правилами компанії. Передаю ваше звернення спеціалісту.',
    handoff: 'Я передав вашу розмову спеціалісту. Він відповість тут.',
    refundCheck: 'Я не можу підтвердити автоматичне повернення. Підкажіть дату та суму списання.',
    cancellation: 'Я не можу скасувати підписку автоматично. Ваш запит може розглянути спеціаліст.',
    billing: 'Підкажіть дату та суму списання, щоб я міг його перевірити.',
    clarify: 'З чим саме допомогти?',
    fallback: 'Дякую! Я перевіряю ваше звернення, спеціаліст підключиться за потреби.',
    executionBlocked: 'Автоматично виконати дію не вдалося. Спеціаліст зв’яжеться з вами.',
    refundDone: (amount: string, merchant: string, reference: string) => `Симульоване повернення ${amount} за дубль ${merchant} виконано в демо (номер ${reference}). Реальні кошти не переміщувалися.`,
    refundFailed: 'Повернення не виконано. Звернення розгляне спеціаліст.',
    refundRejected: 'Спеціаліст не погодив автоматичне повернення. Він повідомить вам про наступні кроки.',
    refundUnknown: 'Результат дії не підтверджено. Повторне виконання заблоковано до перевірки спеціалістом.',
    externalPending: (title: string) => `Я підготував запит «${title}». Його має підтвердити спеціаліст.`,
    externalDone: (title: string, state: string | null) => `Дію «${title}» виконано${state ? ` (статус: ${state})` : ''}.`,
    externalUnknown: (title: string) => `Результат дії «${title}» не підтверджено. Повторне виконання заблоковано до перевірки спеціалістом.`,
    externalFailed: (title: string) => `Дію «${title}» не виконано.`,
    externalRejected: (title: string) => `Спеціаліст не погодив дію «${title}». Він повідомить вам про наступні кроки.`,
  },
  es: {
    pendingRefund: (amount: string) => `Encontré dos cargos idénticos y preparé un reembolso de ${amount} por el duplicado. Un especialista debe aprobarlo.`,
    denied: 'La política de la empresa impide realizar esta acción automáticamente. Derivo tu solicitud a un especialista.',
    handoff: 'He derivado tu consulta a un especialista. Te responderá por aquí.',
    refundCheck: 'No puedo confirmar un reembolso automático. Indícame la fecha y el importe del cargo.',
    cancellation: 'No puedo cancelar la suscripción automáticamente. Un especialista puede revisar tu solicitud.',
    billing: 'Indícame la fecha y el importe del cargo para que pueda revisarlo.',
    clarify: '¿En qué puedo ayudarte?',
    fallback: 'Gracias. Estoy revisando tu consulta. Si hace falta, intervendrá un especialista.',
    executionBlocked: 'No pudimos completar la acción automáticamente. Un especialista te contactará.',
    refundDone: (amount: string, merchant: string, reference: string) => `Se completó en la demo un reembolso simulado de ${amount} por el duplicado de ${merchant} (referencia ${reference}). No se movió dinero real.`,
    refundFailed: 'El reembolso no se realizó. Un especialista revisará la solicitud.',
    refundRejected: 'Un especialista no aprobó el reembolso automático. Te informará de los siguientes pasos.',
    refundUnknown: 'El resultado sigue sin confirmarse. Un especialista lo revisará antes de cualquier reintento.',
    externalPending: (title: string) => `Preparé la solicitud «${title}». Un especialista debe aprobarla.`,
    externalDone: (title: string, state: string | null) => `Se completó «${title}»${state ? ` (estado: ${state})` : ''}.`,
    externalUnknown: (title: string) => `El resultado de «${title}» sigue sin confirmarse. Un especialista lo revisará antes de cualquier reintento.`,
    externalFailed: (title: string) => `No se completó «${title}».`,
    externalRejected: (title: string) => `Un especialista no aprobó «${title}» y te informará de los siguientes pasos.`,
  },
  de: {
    pendingRefund: (amount: string) => `Ich habe zwei identische Abbuchungen gefunden und eine Erstattung von ${amount} für die doppelte Abbuchung vorbereitet. Unser Supportteam muss sie freigeben.`,
    denied: 'Nach unseren Richtlinien kann ich das nicht automatisch erledigen. Ich leite Ihre Anfrage an unser Supportteam weiter.',
    handoff: 'Ich habe Ihre Anfrage an unser Supportteam weitergeleitet. Sie erhalten hier eine Antwort.',
    refundCheck: 'Ich kann keine automatische Erstattung bestätigen. Bitte nennen Sie mir Datum und Betrag der Abbuchung.',
    cancellation: 'Ich kann das Abonnement nicht automatisch kündigen. Unser Supportteam kann Ihre Anfrage prüfen.',
    billing: 'Bitte nennen Sie mir Datum und Betrag der Abbuchung, damit ich sie prüfen kann.',
    clarify: 'Wie kann ich Ihnen helfen?',
    fallback: 'Danke. Ich prüfe Ihre Anfrage und ziehe bei Bedarf unser Supportteam hinzu.',
    executionBlocked: 'Die Aktion konnte nicht automatisch abgeschlossen werden. Unser Supportteam meldet sich bei Ihnen.',
    refundDone: (amount: string, merchant: string, reference: string) => `In der Demo wurde für die doppelte Abbuchung von ${merchant} eine Erstattung von ${amount} simuliert (Referenz ${reference}). Es wurde kein echtes Geld bewegt.`,
    refundFailed: 'Es wurde keine Erstattung ausgeführt. Unser Supportteam prüft die Anfrage.',
    refundRejected: 'Unser Supportteam hat die automatische Erstattung nicht freigegeben und meldet sich mit den nächsten Schritten.',
    refundUnknown: 'Das Ergebnis ist unbestätigt. Unser Supportteam prüft es, bevor die Aktion erneut versucht wird.',
    externalPending: (title: string) => `Ich habe die Anfrage „${title}“ vorbereitet. Unser Supportteam muss sie freigeben.`,
    externalDone: (title: string, state: string | null) => `„${title}“ wurde abgeschlossen${state ? ` (Status: ${state})` : ''}.`,
    externalUnknown: (title: string) => `Das Ergebnis von „${title}“ ist unbestätigt. Unser Supportteam prüft es vor einem erneuten Versuch.`,
    externalFailed: (title: string) => `„${title}“ wurde nicht abgeschlossen.`,
    externalRejected: (title: string) => `Unser Supportteam hat „${title}“ nicht freigegeben und meldet sich mit den nächsten Schritten.`,
  },
  pt: {
    pendingRefund: (amount: string) => `Encontrei duas cobranças iguais e preparei um reembolso de ${amount} pela cobrança duplicada. Um especialista precisa de o aprovar.`,
    denied: 'A política da empresa impede a execução automática desta ação. Vou encaminhar o pedido para um especialista.',
    handoff: 'Encaminhei o pedido para um especialista, que responderá por aqui.',
    refundCheck: 'Não posso confirmar um reembolso automático. Indique-me a data e o valor da cobrança.',
    cancellation: 'Não posso cancelar a subscrição automaticamente. Um especialista pode analisar o pedido.',
    billing: 'Indique-me a data e o valor da cobrança para que eu possa verificá-la.',
    clarify: 'Em que posso ajudar?',
    fallback: 'Obrigado. Estou a verificar o pedido e, se necessário, um especialista irá ajudar.',
    executionBlocked: 'Não foi possível concluir a ação automaticamente. Um especialista entrará em contacto.',
    refundDone: (amount: string, merchant: string, reference: string) => `Na demonstração, foi simulado um reembolso de ${amount} pela cobrança duplicada de ${merchant} (referência ${reference}). Não houve movimentação de dinheiro real.`,
    refundFailed: 'O reembolso não foi efetuado. Um especialista irá analisar o pedido.',
    refundRejected: 'Um especialista não aprovou o reembolso automático e irá indicar os próximos passos.',
    refundUnknown: 'O resultado ainda não foi confirmado. Um especialista irá verificá-lo antes de qualquer nova tentativa.',
    externalPending: (title: string) => `Preparei o pedido «${title}». Um especialista precisa de o aprovar.`,
    externalDone: (title: string, state: string | null) => `«${title}» foi concluído${state ? ` (estado: ${state})` : ''}.`,
    externalUnknown: (title: string) => `O resultado de «${title}» ainda não foi confirmado. Um especialista irá verificá-lo antes de qualquer nova tentativa.`,
    externalFailed: (title: string) => `«${title}» não foi concluído.`,
    externalRejected: (title: string) => `Um especialista não aprovou «${title}» e irá indicar os próximos passos.`,
  },
};

export function customerMessages(language?: string) {
  const key = languageCode(language);
  return key && Object.hasOwn(messages, key) ? messages[key as keyof typeof messages] : messages.en;
}

// Conservative checks for action confirmations in the additional template languages.
export const localizedActionClaims = [
  /\b(?:ya\s+(?:te\s+|le\s+)?(?:devolv[ií]|reembols[eé]|cancel[eé]|bloque[eé])|(?:he|hemos)\s+(?:reembolsado|devuelto|cancelado|bloqueado)|(?:reembolso|devoluci[oó]n|solicitud)\b.{0,40}\b(?:completad[oa]|procesad[oa]|efectuad[oa]|realizad[oa]))/iu,
  /\b(?:ich\s+habe|wir\s+haben).{0,70}\b(?:erstattet|zurückgezahlt|überwiesen|storniert|gesperrt)\b|\b(?:erstattung|rückzahlung)\b.{0,40}\b(?:abgeschlossen|ausgeführt|veranlasst)\b/iu,
  /(?:\bj[aá]\s+(?:lhe\s+|te\s+)?(?:devolvi|reembolsei|cancelei|bloqueei)|\b(?:reembolso|devolu[cç][aã]o|solicita[cç][aã]o)\b.{0,40}\b(?:conclu[ií]d[oa]|processad[oa]|efetuad[oa]|realizad[oa])|\b(?:devolvemos|reembolsamos|cancelamos|bloqueamos)\b)/iu,
];
