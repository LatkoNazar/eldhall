import { isAcknowledgement as trivial } from './text.js';
import type { Message } from '../contracts.js';
import type { RequestCatalog, RequestCheckpoint, RequestTarget } from './contracts.js';

/** Explicit, conservative local fallback; this is not semantic extraction of arbitrary text. */
const rules = [
  { key: 'address', title: 'Змінити адресу доставки', matches: /адрес|address|квартир|apartment|під.?їзд/iu },
  { key: 'delivery', title: 'Перенести доставку', matches: /перенес.{0,40}достав|достав.{0,40}перенес|reschedul|delivery.{0,30}(?:date|tomorrow)|достав.{0,25}(?:листопад|дат[ауи])/iu },
  { key: 'refund', title: 'Перевірити повторне списання', matches: /поверн|refund|двічі|повторн.{0,25}спис|duplicate|charged twice|charged me twice|charged.*twice/iu },
  { key: 'invoice', title: 'Надіслати рахунок', matches: /рахунок|invoice/iu },
] as const;
export function fallbackCheckpoint(catalog: RequestCatalog, source: Pick<Message, 'id' | 'body'>): RequestCheckpoint {
  const clauses = source.body.split(/[.!?;\n]+/u).map(value => value.trim()).filter(Boolean);
  const matched = rules.filter(rule => rule.matches.test(source.body));
  const changes: RequestCheckpoint['changes'] = [];
  let uncertain = matched.length === 0 && !trivial(source.body);
  for (const rule of matched) {
    const existing = catalog.requests.filter(row => row.title === rule.title && row.lifecycle === 'open');
    if (existing.length > 1) { uncertain = true; continue; }
    const old = existing[0]; const fragment = clauses.filter(clause => rule.matches.test(clause)).join('. ').slice(0, 700);
    if(old&&!old.goal.includes(fragment)&&!/(?:уточн|clarif|correction|same|той сам|цю сам)/iu.test(fragment)) uncertain=true;
    const goal = old ? old.goal.includes(fragment) ? old.goal : (old.goal + '\nУточнення: ' + fragment).slice(-1200) : fragment;
    const waiting = rule.key === 'address' && /(?:квартир|адрес).{0,60}(?:пізніше|надішлю|уточню)|(?:apartment|address).{0,40}(?:later|will send)/iu.test(fragment);
    changes.push({ localKey: rule.key, ...(old ? { id: old.id, expectedRevision: old.revision } : {}), title: rule.title,
      goal, waitingOn: waiting ? 'customer' : null, nextStep: waiting ? 'Очікуємо обіцяне клієнтом уточнення адреси.' : null,
      sourceMessageIds: [source.id], dependencyIds: old?.dependencyIds ?? [], dependencyKeys: [] });
  }
  const address = changes.find(change => change.localKey === 'address');
  const delivery = changes.find(change => change.localKey === 'delivery');
  const explicitDependency = /достав.{0,80}(?:після|коли).{0,60}адрес|deliver.{0,80}(?:after|once).{0,60}address|(?:after|once).{0,40}address.{0,50}deliver/iu.test(source.body);
  if (address && delivery && explicitDependency) delivery.dependencyKeys = ['address'];
  else if (delivery && explicitDependency) {
    const prior = catalog.requests.filter(row => row.title === rules[0].title && row.lifecycle !== 'cancelled');
    if (prior.length === 1) delivery.dependencyIds = [prior[0]!.id];
  }
  const unknown = clauses.filter(clause => !trivial(clause) && !rules.some(rule => rule.matches.test(clause))).join('. ').slice(0,1200);
  if (unknown) {
    uncertain = true;
    const old=catalog.requests.find(row=>row.lifecycle==='open'&&row.title==='Уточнити запит клієнта'&&row.goal===unknown);
    changes.push({localKey:'unclassified',...(old?{id:old.id,expectedRevision:old.revision}:{}),title:'Уточнити запит клієнта',goal:unknown,waitingOn:'staff',nextStep:'Потрібна перевірка та уточнення запиту; автоматичне визначення мети відсутнє.',sourceMessageIds:[source.id],dependencyIds:[],dependencyKeys:[]});
  }
  return { version: catalog.version, syncState: uncertain ? 'needs_review' : 'current', changes };
}
export function fallbackTargets(catalog: RequestCatalog, tool: string): RequestTarget[] {
  if(tool === 'escalate_to_human') return catalog.requests.filter(row=>row.lifecycle==='open').map(row=>({id:row.id,revision:row.revision}));
  const eligible = catalog.requests.filter(row => row.lifecycle === 'open' && row.waitingOn !== 'customer' && row.dependencyIds.every(id => catalog.requests.some(dependency => dependency.id === id && dependency.lifecycle === 'fulfilled')));
  const matching = tool === 'refund_payment' ? eligible.filter(row => row.title === rules[2].title) : eligible;
  return matching.length === 1 ? [{ id: matching[0]!.id, revision: matching[0]!.revision }] : [];
}
