/** Narrow local recognition of acknowledgements, not a general intent classifier. */
export const isAcknowledgement = (value: string) => !/[\p{L}\p{N}]/u.test(value) || /^(?:hello|hi|hey|thanks|thank you|please|привіт|вітаю|дякую|добрий день|спасибі|hola|gracias|olá|obrigad[oa]|hallo|danke)[!,.\s]*$/iu.test(value.trim());
export function hasUnrepresentedInput(requests: {sourceMessageIds:string[];fulfillment?:{proof:{messageIds:string[]}}|null}[], messages: {id:string;body:string}[]) {
  const represented=new Set(requests.flatMap(row=>[...row.sourceMessageIds,...(row.fulfillment?.proof.messageIds??[])]));
  return messages.some(message=>!represented.has(message.id)&&!isAcknowledgement(message.body));
}
