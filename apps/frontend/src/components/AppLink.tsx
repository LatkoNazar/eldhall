import { useI18n, withLocale } from '../i18n'
import type { ComponentPropsWithRef } from 'react'
import { isAppDestination, navigate } from '../lib/navigation'

/** Internal navigation retains the document; ordinary anchor semantics stay native. */
export function AppLink({ onClick, ...props }: ComponentPropsWithRef<'a'>) {
  const { locale } = useI18n()
  let href = props.href
  if (href && !href.includes('#')) {
    try { if (isAppDestination(new URL(href, window.location.href))) href = withLocale(href, locale, window.location.href) ?? href } catch { /* Keep ordinary native anchor behavior for malformed destinations. */ }
  }
  return <a {...props} href={href} onClick={event => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      (props.target && props.target !== '_self') || props.download !== undefined || !href || href.includes('#')) return
    const target = new URL(href, window.location.href)
    if (!isAppDestination(target)) return
    event.preventDefault()
    navigate(target.href)
  }} />
}
