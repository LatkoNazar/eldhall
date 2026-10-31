import type { ReactNode } from 'react'
import { caseLabels, proposalLabels } from '../lib/api'

const paths: Record<string, string> = {
  inbox: 'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5', spark: 'm12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z M19 2v4 M17 4h4',
  chart: 'M4 21V11h3v10 M11 21V6h3v15 M18 21V2h3v19', book: 'M12 5c-3-3-7-2-9-1v15c3-2 6-2 9 0 3-2 6-2 9 0V4c-3-1-6-2-9 1Z M12 5v14',
  team: 'M16 21v-3c0-3-3-4-6-4s-6 1-6 4v3 M10 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M17 4a4 4 0 0 1 0 7 M20 21v-3c0-2-1-3-3-4',
  settings: 'm9 3-1 3-3 1-2 3 2 3 1 3 3 1 1 3h4l1-3 3-1 1-3 2-3-2-3-3-1-1-3Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  search: 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z m6-2 6 6', arrow: 'M5 12h14 m-5-5 5 5-5 5', refresh: 'M20 7a8 8 0 1 0 1 8 M20 2v6h-6',
  clock: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', check: 'm4 12 5 5L20 6', close: 'm5 5 14 14 M19 5 5 19', plus: 'M12 4v16 M4 12h16', send: 'm3 3 19 9L3 21l4-9Z M7 12h15',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', file: 'M5 2h9l5 5v15H5Z M14 2v6h5 M8 13h8 M8 17h6', lock: 'M5 10h14v11H5Z M8 10V6a4 4 0 1 1 8 0v4', logout: 'M9 3H3v18h6 M9 12h12 m-5-5 5 5-5 5',
}
export function Icon({ name, size = 21 }: { name: string; size?: number }) { return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths.spark} /></svg> }
export function Brand() { return <a className="brand" href="/" aria-label="Eldhall Support — головна"><svg aria-hidden="true" viewBox="0 0 32 40"><path fill="currentColor" d="M18 0c5 12-12 13-10 24 1-6 10-7 14-14 11 10 10 19 2 25-6 5-18 5-21-4C-2 18 16 15 18 0Z"/><path fill="white" d="M23 20C20 31 7 26 9 35c-7-9 6-9 14-15Z"/></svg><span>eldhall<span className="brand-subtitle">SUPPORT</span></span></a> }
export function Badge({ value, children }: { value?: string; children?: ReactNode }) {
  const labels: Record<string, string> = { ...caseLabels, ...proposalLabels, bot: 'AI веде діалог', staff: 'Веде оператор', published: 'Опубліковано', draft: 'Чернетка', revoked: 'Відкликано', fallback: 'Резервні правила', llm: 'Мовна модель', ok: 'Завершено', captured: 'Оплачено', refunded: 'Повернено' }
  return <span className={`badge badge-${value ?? 'neutral'}`}>{children ?? labels[value ?? ''] ?? value}</span>
}
export function Empty({ icon = 'inbox', title, children }: { icon?: string; title: string; children?: ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name={icon} size={28} /></span><h3>{title}</h3>{children && <p>{children}</p>}</div> }
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div> }
export function Metric({ label, value, hint, icon = 'chart' }: { label: string; value: ReactNode; hint?: string; icon?: string }) { return <article className="metric card"><span className="metric-icon"><Icon name={icon} /></span><div><p>{label}</p><strong>{value}</strong>{hint && <small>{hint}</small>}</div></article> }
export function Avatar({ name }: { name: string }) { return <span className="avatar" aria-hidden="true">{name.split(' ').slice(0, 2).map(part => part[0]).join('')}</span> }
