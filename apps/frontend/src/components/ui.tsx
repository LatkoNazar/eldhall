import { useI18n, formatNumber, type AppMessageKey } from '../i18n'
import { AppLink } from './AppLink'
import type { ReactNode } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon'
import BookOpen01Icon from '@hugeicons/core-free-icons/BookOpen01Icon'
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'
import Building03Icon from '@hugeicons/core-free-icons/Building03Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import ChartIncreaseIcon from '@hugeicons/core-free-icons/ChartIncreaseIcon'
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon'
import File01Icon from '@hugeicons/core-free-icons/File01Icon'
import HelpCircleIcon from '@hugeicons/core-free-icons/HelpCircleIcon'
import InboxIcon from '@hugeicons/core-free-icons/InboxIcon'
import Key01Icon from '@hugeicons/core-free-icons/Key01Icon'
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon'
import LockPasswordIcon from '@hugeicons/core-free-icons/LockPasswordIcon'
import Login01Icon from '@hugeicons/core-free-icons/Login01Icon'
import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon'
import Mail01Icon from '@hugeicons/core-free-icons/Mail01Icon'
import PaletteIcon from '@hugeicons/core-free-icons/PaletteIcon'
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import SentIcon from '@hugeicons/core-free-icons/SentIcon'
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon'
import SparklesIcon from '@hugeicons/core-free-icons/SparklesIcon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import UserGroupIcon from '@hugeicons/core-free-icons/UserGroupIcon'
import UserIcon from '@hugeicons/core-free-icons/UserIcon'
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon'
import ViewOffSlashIcon from '@hugeicons/core-free-icons/ViewOffSlashIcon'
import { caseLabels, proposalLabels } from '../lib/api'

const icons: Record<string, IconSvgElement> = {
  inbox: InboxIcon, spark: SparklesIcon, chart: ChartIncreaseIcon, book: BookOpen01Icon,
  team: UserGroupIcon, building: Building03Icon, settings: Settings01Icon, search: Search01Icon, arrow: ArrowRight01Icon,
  refresh: RefreshIcon, clock: Clock01Icon, check: Tick02Icon, close: Cancel01Icon,
  plus: Add01Icon, send: SentIcon, help: HelpCircleIcon, file: File01Icon,
  lock: LockPasswordIcon, logout: Logout01Icon, login: Login01Icon, user: UserIcon,
  mail: Mail01Icon, eye: ViewIcon, 'eye-off': ViewOffSlashIcon, loading: Loading03Icon,
  alert: AlertCircleIcon, key: Key01Icon,
  chat: BubbleChatIcon, external: ArrowUpRight01Icon, palette: PaletteIcon,
}
export function Icon({ name, size = 21 }: { name: string; size?: number }) {
  const icon = Object.hasOwn(icons, name) ? icons[name] ?? SparklesIcon : SparklesIcon
  return <HugeiconsIcon icon={icon} size={size} color="currentColor" strokeWidth={1.7} aria-hidden="true" focusable="false" />
}
export function Brand() {
  const { t } = useI18n()
  return <AppLink className="brand" href="/" aria-label={t('core.brand.home')}>
    <svg aria-hidden="true" focusable="false" viewBox="0 0 32 40">
      {/* The gap between the two flame shapes forms the curved E. */}
      <path fill="currentColor" d="M16.5 1C18 7.8 13.4 11.8 8.4 16.8 4.3 20.9 1.5 24.8 1.5 29.1c0 5.6 4.4 9.5 10.8 10.2-4.9-3.6-5.1-8.2-1.8-12.1 2.4-2.9 5.9-4.1 9.8-6.3 4.8-2.8 5.1-6.4 3-10.5C21.6 6.9 19 3.8 16.5 1Z" />
      <path fill="currentColor" d="M26 14.6c.7 5.2-2.8 8.3-7.6 10.2-3.1 1.2-5.3 2.6-6 4.8 3.3-1.7 7.4-.9 11-3.7-1.1 3.2-4 4.7-8 5.5-2 .4-2.8 1.4-2.3 2.6.7 1.7 4 2.3 7.4 1.4 6.4-1.8 10.2-6 10.1-11.1-.1-3.3-1.8-6.5-4.6-9.7Z" />
    </svg>
    <span>eldhall<span className="brand-subtitle">SUPPORT</span></span>
  </AppLink>
}
export function Badge({ value, children }: { value?: string; children?: ReactNode }) {
  const { t } = useI18n()
  const labels: Record<string, AppMessageKey> = { ...caseLabels, ...proposalLabels, bot: 'core.status.bot', staff: 'core.status.staff', published: 'core.status.published', draft: 'core.status.draft', revoked: 'core.status.revoked', fallback: 'core.status.fallback', llm: 'core.status.llm', ok: 'core.status.ok', captured: 'core.status.captured', refunded: 'core.status.refunded', queued: 'core.status.queued', running: 'core.status.running', completed: 'core.status.completed', cancelled: 'core.status.cancelled' }
  const key = labels[value ?? '']
  return <span className={`badge badge-${value ?? 'neutral'}`}>{children ?? (key ? t(key) : value)}</span>
}
export function Empty({ icon = 'inbox', title, children }: { icon?: string; title: string; children?: ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name={icon} size={28} /></span><h3>{title}</h3>{children && <p>{children}</p>}</div> }
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div> }
export function Metric({ label, value, hint, icon = 'chart' }: { label: string; value: ReactNode; hint?: string; icon?: string }) { const { locale } = useI18n(); return <article className="metric card"><span className="metric-icon"><Icon name={icon} /></span><div><p>{label}</p><strong>{typeof value === 'number' ? formatNumber(value, locale) : value}</strong>{hint && <small>{hint}</small>}</div></article> }
export { Avatar } from './Avatar'
