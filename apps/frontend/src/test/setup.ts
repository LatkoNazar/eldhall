import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, vi } from 'vitest'
import { loadAppCatalog } from '../locales'
import { localeStorageKey } from '../../../../packages/i18n/src/core.ts'

beforeAll(async () => { await loadAppCatalog('uk') })

// JSDOM has scroll coordinates but not the browser's Element.scrollTo method.
// Preserve its observable coordinate effect for internal-scroll navigation tests.
if (!HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    if (typeof options === 'number') { this.scrollLeft = options; this.scrollTop = y ?? 0 }
    else { if (options?.left !== undefined) this.scrollLeft = options.left; if (options?.top !== undefined) this.scrollTop = options.top }
  }
}

afterEach(() => {
  cleanup()
  try { localStorage.removeItem(localeStorageKey) } catch { /* Storage restriction tests intentionally make it unavailable. */ }
  vi.unstubAllGlobals()
})
