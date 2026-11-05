import { useI18n, formatDateTime } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { Message } from '../lib/api'
import { Empty } from './ui'

export function MessageThread({ messages, customerName, customer = false, loading = false, pending = '' }: { messages: Message[]; customerName: string; customer?: boolean; loading?: boolean; pending?: string }) {
  const { t, locale } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [away, setAway] = useState(false)
  const lastId = messages.at(-1)?.id
  useEffect(() => {
    const element = container.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [lastId, pending])
  return <div className={`message-thread ${customer ? 'customer-message-thread' : ''}`}>
    <div className={customer ? 'customer-transcript' : 'transcript'} ref={container} role="log" aria-live="polite" aria-relevant="additions" aria-label={t("core.thread.label")} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; setAway(!follow.current) }}>
      {messages.length ? messages.map(message => <article key={message.id} className={`message message-${message.role}`}><span className="message-author">{message.role === 'customer' ? customer ? t("core.chat.you") : customerName : message.role === 'operator' ? t("core.thread.operator") : message.role === 'assistant' ? t("core.thread.assistant") : t("core.thread.system")}</span><div className="message-bubble">{message.body}</div><time dateTime={message.createdAt}>{formatDateTime(message.createdAt, locale)}</time></article>) : <Empty title={loading ? t("core.thread.loading") : t("core.thread.emptyTitle")}>{customer ? t("core.thread.emptyCustomer") : t("core.thread.emptyOperator")}</Empty>}
      {pending && <p className="typing" role="status">{pending}</p>}
    </div>
    {away && <button className="latest-messages" onClick={() => { const element = container.current; if (element) element.scrollTop = element.scrollHeight; follow.current = true; setAway(false) }}>{t("core.thread.latest")}</button>}
  </div>
}
