import type { ComponentPropsWithRef } from 'react'
import { isAppDestination, navigate } from '../lib/navigation'

/** Internal navigation retains the document; ordinary anchor semantics stay native. */
export function AppLink({ onClick, ...props }: ComponentPropsWithRef<'a'>) {
  return <a {...props} onClick={event => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      (props.target && props.target !== '_self') || props.download !== undefined || !props.href || props.href.includes('#')) return
    const target = new URL(props.href, window.location.href)
    if (!isAppDestination(target)) return
    event.preventDefault()
    navigate(target.href)
  }} />
}
