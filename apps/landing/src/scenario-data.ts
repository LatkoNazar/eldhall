// Illustrative demo data for the landing walkthrough. It mirrors the MVP's real flow
// (apps/api harness + policy) but is static: no request leaves this page.

export type ChatRole = 'customer' | 'assistant'
export interface ChatMessage { role: ChatRole; text: string }
export interface Check { label: string; detail: string; passed: boolean }
export interface Fact { term: string; value: string }
export type Tone = 'accent' | 'warn' | 'info' | 'ok' | 'grey'
export interface Tag { label: string; tone: Tone }

export interface Step {
  label: string
  kicker: string
  title: string
  text: string
  chat?: ChatMessage[]
  typing?: boolean
  tags?: Tag[]
  facts?: Fact[]
  checks?: Check[]
}

export interface Scenario { id: string; business: string; steps: Step[] }

export const SCENARIOS: Record<'refund' | 'limit', Scenario> = {
  refund: {
    id: 'refund',
    business: 'NovaPay Fitness',
    steps: [
      {
        label: 'Звернення', kicker: 'Крок 1 · Звернення', title: 'Клієнтка пише в чат',
        text: 'Ілюстративний сценарій без API-викликів: Олена бачить два однакові списання за підписку. У застосунку клієнта визначає сесія чату, а не текст звернення.',
        chat: [{ role: 'customer', text: 'Ви списали з мене двічі за жовтень!!! Негайно поверніть' }],
        facts: [{ term: 'Клієнт', value: 'Olena K. (демо)' }, { term: 'План', value: 'Premium monthly' }, { term: 'Канал', value: 'Чат підтримки' }],
      },
      {
        label: 'Аналіз', kicker: 'Крок 2 · AI-аналіз', title: 'AI розуміє намір і настрій',
        text: 'Приклад показує, як модель через lookup_payments перевіряє платежі клієнта й пропонує типізоване рішення. На цій сторінці модель не викликається.',
        typing: true,
        tags: [{ label: 'duplicate_charge', tone: 'info' }, { label: 'frustrated', tone: 'warn' }, { label: 'urgency: high', tone: 'warn' }, { label: 'P1', tone: 'accent' }],
        facts: [{ term: 'Знайдено', value: '2 × 499.00 UAH · SUB-OCT-2026' }, { term: 'Різниця', value: '40 секунд' }, { term: 'Tool calls', value: 'lookup_payments → submit_decision' }],
      },
      {
        label: 'Правила', kicker: 'Крок 3 · Policy check', title: 'Правила дозволяють повернення',
        text: 'Детермінований policy engine перевіряє пропозицію AI. Настрій клієнта тут не враховується — він впливає лише на пріоритет і тон.',
        chat: [{ role: 'assistant', text: 'Мені дуже шкода, що так сталося. Я знайшов два однакові списання і підготував повернення 499.00 UAH за дубль. Його має підтвердити спеціаліст — я напишу тут, щойно буде результат.' }],
        checks: [
          { label: 'Платіж належить клієнту', detail: 'Знайдено серед платежів сесії', passed: true },
          { label: 'Ідентичне списання', detail: 'Та сама сума й референс за 40 с', passed: true },
          { label: 'Ще не повернено', detail: 'Немає повернення чи відкритої пропозиції', passed: true },
          { label: 'У межах ліміту', detail: '499.00 з 2000.00 UAH', passed: true },
        ],
      },
      {
        label: 'Рішення', kicker: 'Крок 4 · Human approval', title: 'Оператор підтверджує саме цю операцію',
        text: 'Approve лише записує згоду на конкретні аргументи. Він не виконує повернення й не викликає платіжний провайдер. Виконання потребує окремого Execute.',
        tags: [{ label: 'refund_payment', tone: 'grey' }, { label: 'high risk', tone: 'accent' }, { label: 'approved', tone: 'ok' }],
        facts: [{ term: 'Дія', value: 'refund_payment' }, { term: 'Сума', value: '499.00 UAH' }, { term: 'Платіж', value: 'Друге списання SUB-OCT-2026' }, { term: 'Рішення', value: 'Approve · оператор Anna' }, { term: 'Ефект погодження', value: '0 повернень · 0 викликів провайдера' }, { term: 'Наступний крок', value: 'Окремий Execute' }],
      },
      {
        label: 'Виконання', kicker: 'Крок 5 · Execute', title: 'Окреме виконання — симульований результат',
        text: 'Ілюстрація окремого Execute: backend повторно перевіряє правила й записує результат симульованого провайдера. Реальні кошти не переміщуються. Повторний Execute відхиляється.',
        chat: [{ role: 'assistant', text: 'Симуляція завершена: повернення 499.00 UAH за дубль SUB-OCT-2026, референс SIM-RF-DEMO-001. Реальні кошти не переміщувалися.' }],
        tags: [{ label: 'payment: refunded', tone: 'ok' }, { label: 'case: resolved', tone: 'ok' }, { label: 'simulated provider', tone: 'grey' }],
        facts: [{ term: 'Виконання', value: 'Execute · окрема дія оператора' }, { term: 'Журнал', value: 'received → analyzed → proposed → approved → executed' }, { term: 'Повторний Execute', value: '409 · вже виконано' }],
      },
    ],
  },
  limit: {
    id: 'limit',
    business: 'NovaPay Fitness',
    steps: [
      {
        label: 'Звернення', kicker: 'Крок 1 · Звернення', title: 'Розлючений клієнт і річний план',
        text: 'Іван бачить подвійне списання за річну підписку і пише різко. Роздратування — не привід вважати клієнта зловмисником.',
        chat: [{ role: 'customer', text: 'Ви, ідіоти, двічі списали за річний план!!! Поверніть НЕГАЙНО' }],
        facts: [{ term: 'Клієнт', value: 'Ivan B. (демо)' }, { term: 'План', value: 'Annual' }],
      },
      {
        label: 'Аналіз', kicker: 'Крок 2 · AI-аналіз', title: 'Висока напруга — найвищий пріоритет',
        text: 'Лексичні сигнали та оцінка моделі дають мітку abusive. Це піднімає пріоритет і вмикає тон деескалації, але не дозволяє гроші.',
        typing: true,
        tags: [{ label: 'duplicate_charge', tone: 'info' }, { label: 'abusive', tone: 'accent' }, { label: 'tone: de-escalating', tone: 'warn' }, { label: 'P1', tone: 'accent' }],
        facts: [{ term: 'Знайдено', value: '2 × 3999.00 UAH · SUB-ANNUAL-2026' }, { term: 'Сигнали', value: 'груба лексика, капслок, «!!!»' }],
      },
      {
        label: 'Правила', kicker: 'Крок 3 · Policy check', title: 'Сума перевищує ліміт автоматичного повернення',
        text: 'Дубль справжній, але правила бізнесу не дозволяють автоматично повертати таку суму. Пропозицію відхилено ще до оператора.',
        checks: [
          { label: 'Платіж належить клієнту', detail: 'Знайдено серед платежів сесії', passed: true },
          { label: 'Ідентичне списання', detail: 'Та сама сума й референс за 70 с', passed: true },
          { label: 'У межах ліміту', detail: '3999.00 UAH > ліміт 2000.00 UAH', passed: false },
        ],
      },
      {
        label: 'Рішення', kicker: 'Крок 4 · Escalation', title: 'Кейс автоматично передано людині',
        text: 'Безпечна дія escalate_to_human виконується одразу. Спеціаліст бачить повний контекст: аналіз, сигнали й перевірку, що не пройшла.',
        chat: [{ role: 'assistant', text: 'Мені дуже шкода, що так сталося — розумію, як це неприємно. Я не можу виконати це автоматично за правилами компанії. Передаю ваше звернення спеціалісту.' }],
        tags: [{ label: 'refund_payment: denied', tone: 'accent' }, { label: 'escalate_to_human: executed', tone: 'ok' }],
      },
      {
        label: 'Результат', kicker: 'Крок 5 · Результат', title: 'Гроші не рухались — і клієнт це знає',
        text: 'Система не обіцяє того, чого не зробила. Кейс у черзі оператора з пріоритетом P1, кожен крок записано в журнал.',
        tags: [{ label: 'case: escalated', tone: 'warn' }, { label: 'refund: none', tone: 'grey' }],
        facts: [{ term: 'Журнал', value: 'received → analyzed → denied → escalated' }],
      },
    ],
  },
}
