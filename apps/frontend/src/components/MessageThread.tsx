import { useEffect, useRef, useState } from 'react'
import type { Message } from '../lib/api'
import { dateTime } from '../lib/api'
import { Empty } from './ui'

export function MessageThread({ messages, customerName, customer = false, loading = false, pending = '' }: { messages: Message[]; customerName: string; customer?: boolean; loading?: boolean; pending?: string }) {
  const container = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [away, setAway] = useState(false)
  const lastId = messages.at(-1)?.id
  useEffect(() => {
    const element = container.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [lastId, pending])
  return <div className={`message-thread ${customer ? 'customer-message-thread' : ''}`}>
    <div className={customer ? 'customer-transcript' : 'transcript'} ref={container} role="log" aria-live="polite" aria-relevant="additions" aria-label="Повідомлення діалогу" onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; setAway(!follow.current) }}>
      {messages.length ? messages.map(message => <article key={message.id} className={`message message-${message.role}`}><span className="message-author">{message.role === 'customer' ? customer ? 'Ви' : customerName : message.role === 'operator' ? 'Оператор' : message.role === 'assistant' ? 'AI-помічник' : 'Система'}</span><div className="message-bubble">{message.body}</div><time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time></article>) : <Empty title={loading ? 'Завантажуємо діалог…' : 'Чим можемо допомогти?'}>{customer ? 'Опишіть ситуацію у повідомленні нижче.' : 'Очікуємо перше повідомлення клієнта.'}</Empty>}
      {pending && <p className="typing" role="status">{pending}</p>}
    </div>
    {away && <button className="latest-messages" onClick={() => { const element = container.current; if (element) element.scrollTop = element.scrollHeight; follow.current = true; setAway(false) }}>До останніх повідомлень ↓</button>}
  </div>
}
