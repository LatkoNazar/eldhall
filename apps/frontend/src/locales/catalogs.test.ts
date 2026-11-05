import { describe, expect, it } from 'vitest'
import { localeCodes } from '../../../../packages/i18n/src/core.ts'
import { englishCatalog, getLoadedCatalog, loadAppCatalog } from './load.ts'

const placeholders = (value: string) => [...new Set([...value.matchAll(/\{\{\s*-?\s*([\w.]+)(?:\s*,[^}]*)?\s*\}\}/g)].map(match => match[1]))].sort()

describe('complete independently loaded interface catalogs', () => {
  it.each(localeCodes)('%s has every message and interpolation parameter, with no empty translation', async locale => {
    const messages = await loadAppCatalog(locale)
    expect(Object.keys(messages).sort()).toEqual(Object.keys(englishCatalog).sort())
    for (const [key, reference] of Object.entries(englishCatalog)) {
      const translated = messages[key as keyof typeof messages]
      expect(translated.trim(), `${locale}/${key}`).not.toBe('')
      expect(translated, `${locale}/${key}`).not.toMatch(/\b(?:TODO|TBD|TRANSLATE_ME)\b/)
      expect(placeholders(translated), `${locale}/${key}`).toEqual(placeholders(reference))
    }
    expect(getLoadedCatalog(locale)).toBe(messages)
  })

  it('reuses resolved resources and does not fetch an unsupported locale', async () => {
    const first = await loadAppCatalog('es')
    expect(await loadAppCatalog('es')).toBe(first)
    await expect(loadAppCatalog('invalid' as never)).rejects.toThrow('Unsupported interface locale')
  })
})
