export const accents = ['red', 'blue', 'violet', 'teal', 'amber', 'slate'] as const
export type Accent = typeof accents[number]

const storageKey = 'eldhall.accent'
const defaultAccent: Accent = 'red'

function isAccent(value: string | null | undefined): value is Accent {
  return accents.some(accent => accent === value)
}

export function currentAccent(): Accent {
  const value = document.documentElement.dataset.accent
  return isAccent(value) ? value : defaultAccent
}

export function restoreAccent() {
  let stored: string | null = null
  try { stored = window.localStorage.getItem(storageKey) } catch { /* Storage can be blocked. */ }
  document.documentElement.dataset.accent = isAccent(stored) ? stored : defaultAccent
}

export function setAccent(accent: Accent) {
  document.documentElement.dataset.accent = accent
  try { window.localStorage.setItem(storageKey, accent) } catch { /* The current page still updates. */ }
}
