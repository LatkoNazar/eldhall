/* eslint-disable react-refresh/only-export-components -- Test-only render utility deliberately re-exports Testing Library, never shipped in the app. */
import type { ReactElement } from 'react'
import { render as renderUi } from '@testing-library/react'
import type { RenderOptions } from '@testing-library/react'
import type { Locale } from '../i18n'
import { I18nProvider } from '../i18n'

// Existing behavior tests explicitly retain their Ukrainian fixture language.
export * from '@testing-library/react'
export function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return ui.type === I18nProvider ? renderUi(ui, options) : renderWithLocale(ui, 'uk', options)
}

export function renderWithLocale(ui: ReactElement, locale: Locale, options?: Omit<RenderOptions, 'wrapper'>) {
  return renderUi(ui, { ...options, wrapper: ({ children }) => <I18nProvider initialLocale={locale}>{children}</I18nProvider> })
}
