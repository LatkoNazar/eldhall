import { useI18n, formatDateTime } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { Message } from '../lib/api'
import { Empty } from './ui'

export interface MessageRequestLink { id: string; label: string; title: string }
export function MessageThread({ messages, customerName, customer = false, loading = false, pending = '', requestLinks = {}, selectedSourceIds = [], onSelectRequest, sourceJump }: { messages: Message[]; customerName: string; customer?: boolean; loading?: boolean; pending?: string; requestLinks?: Readonly<Record<string, MessageRequestLink[]>>; selectedSourceIds?: readonly string[]; onSelectRequest?: (id: string) => void; sourceJump?: { messageId: string; sequence: number } | null }) {
  const { t, locale } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [away, setAway] = useState(false)
  const messageNodes = useRef(new Map<string, HTMLElement>())
  const lastId = messages.at(-1)?.id
  const emptyTitle = loading ? t('core.thread.loading') : t(customer ? 'core.chat.empty' : 'core.thread.emptyTitle')
  useEffect(() => {
    const element = container.current
    if (element && follow.current) element.scrollTop = element.scrollHeight
  }, [lastId, pending])
  useEffect(() => {
    if (customer || !sourceJump) return
    const node = messageNodes.current.get(sourceJump.messageId)
    if (!node) return
    follow.current = false
    node.focus({ preventScroll: true })
    node.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }, [sourceJump, customer])
  return <div className={`message-thread ${customer ? 'customer-message-thread' : ''}`}>
    <div className={customer ? 'customer-transcript' : 'transcript'} ref={container} tabIndex={0} role="log" aria-live="polite" aria-relevant="additions" aria-label={t("core.thread.label")} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; setAway(!follow.current) }}>
      {messages.map(message => <article key={message.id} data-message-id={message.id} tabIndex={-1} ref={node => { if (node) messageNodes.current.set(message.id, node); else messageNodes.current.delete(message.id) }} className={`message message-${message.role} ${!customer && selectedSourceIds.includes(message.id) ? 'request-source-selected' : ''}`}><span className="message-author">{message.role === 'customer' ? customer ? t("core.chat.you") : customerName : message.role === 'operator' ? t("core.thread.operator") : message.role === 'assistant' ? t("core.thread.assistant") : t("core.thread.system")}</span><div className="message-bubble">{message.body}</div><time dateTime={message.createdAt}>{formatDateTime(message.createdAt, locale)}</time>{!customer && requestLinks[message.id]?.length ? <div className="message-request-links" aria-label={t('requests.annotations')}>{requestLinks[message.id]!.map(link => <button type="button" key={link.id} aria-label={t('requests.open', { number: link.label, title: link.title })} onClick={() => onSelectRequest?.(link.id)}>{link.label}</button>)}</div> : null}</article>)}
      {!messages.length && (!customer || !pending) && <Empty title={emptyTitle} icon={customer ? 'chat' : 'inbox'} />}
      {pending && <p className="typing" role="status">{pending}</p>}
    </div>
    {away && <button className="latest-messages" onClick={() => { const element = container.current; if (element) element.scrollTop = element.scrollHeight; follow.current = true; setAway(false) }}>{t("core.thread.latest")}</button>}
  </div>
}
