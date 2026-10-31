import { useSyncExternalStore } from 'react'

const indexKey = 'supportNavigationIndex'
const listeners = new Set<() => void>()
const guards = new Set<() => boolean>()
const readLocation = () => window.location.pathname + window.location.search + window.location.hash
let currentLocation = readLocation()
let currentIndex = 0
let restoring = false

function stateWithIndex(index: number) {
  const state: unknown = window.history.state
  return { ...(state && typeof state === 'object' ? state : {}), [indexKey]: index }
}
function historyIndex(): number | null {
  const index: unknown = window.history.state?.[indexKey]
  return typeof index === 'number' && Number.isInteger(index) ? index : null
}
function rememberLocation() {
  currentLocation = readLocation()
  const index = historyIndex()
  if (index === null) window.history.replaceState(stateWithIndex(currentIndex), '', currentLocation)
  else currentIndex = index
}
function notify() { listeners.forEach(listener => listener()) }
function allowed() { return [...guards].every(guard => guard()) }
function onHistoryChange() {
  if (restoring) {
    if (readLocation() !== currentLocation) {
      const index = historyIndex()
      if (index !== null && index !== currentIndex) {
        window.history.go(currentIndex - index)
        return
      }
      window.history.replaceState(stateWithIndex(currentIndex), '', currentLocation)
    }
    restoring = false
    rememberLocation()
    notify()
    return
  }
  const nextLocation = readLocation()
  if (nextLocation === currentLocation) return
  const nextIndex = historyIndex()
  // Fragment navigation does not unmount an editor. Give new native hash entries
  // their own index so a later cancelled Back can return to the exact entry.
  if (nextLocation.split('#')[0] === currentLocation.split('#')[0]) {
    if (nextIndex === null || nextIndex === currentIndex) {
      currentIndex++
      window.history.replaceState(stateWithIndex(currentIndex), '', nextLocation)
    }
    rememberLocation()
    notify()
    return
  }
  if (!allowed()) {
    if (nextIndex !== null && nextIndex !== currentIndex) {
      restoring = true
      window.history.go(currentIndex - nextIndex)
    } else window.history.pushState(stateWithIndex(currentIndex), '', currentLocation)
    return
  }
  rememberLocation()
  notify()
}
function subscribe(listener: () => void) {
  if (!listeners.size) {
    rememberLocation()
    window.addEventListener('popstate', onHistoryChange)
    window.addEventListener('hashchange', onHistoryChange)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      window.removeEventListener('popstate', onHistoryChange)
      window.removeEventListener('hashchange', onHistoryChange)
    }
  }
}

export function useAppLocation() {
  return useSyncExternalStore(subscribe, () => restoring ? currentLocation : readLocation(), () => '/')
}
export function isAppDestination(url: URL) {
  const pathname = url.pathname.replace(/\/$/, '') || '/'
  return url.origin === window.location.origin && (pathname === '/' || pathname === '/chat' || /^\/operator(?:\/(?:actions|analytics|knowledge|team|settings))?$/.test(pathname))
}
export function navigate(href: string, replace = false) {
  const target = new URL(href, window.location.href)
  if (!isAppDestination(target) || restoring) return false
  rememberLocation()
  const destination = target.pathname + target.search + target.hash
  if (destination === currentLocation) return true
  if (!allowed()) return false
  if (!replace) currentIndex++
  window.history[replace ? 'replaceState' : 'pushState'](stateWithIndex(currentIndex), '', destination)
  currentLocation = destination
  notify()
  return true
}
export function registerNavigationGuard(guard: () => boolean) {
  guards.add(guard)
  return () => { guards.delete(guard) }
}
