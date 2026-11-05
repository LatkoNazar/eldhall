import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, vi } from 'vitest'
import { loadAppCatalog } from '../locales'
import { localeStorageKey } from '../../../../packages/i18n/src/core.ts'

beforeAll(async () => { await loadAppCatalog('uk') })

afterEach(() => {
  cleanup()
  try { localStorage.removeItem(localeStorageKey) } catch { /* Storage restriction tests intentionally make it unavailable. */ }
  vi.unstubAllGlobals()
})
