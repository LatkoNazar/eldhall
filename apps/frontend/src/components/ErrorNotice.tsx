import type { ReactNode } from 'react'
import { ApiError, errorText } from '../lib/api'
import { useI18n } from '../i18n'
import { Notice } from './ui'

export function ErrorNotice({ error, children }: { error: unknown; children?: ReactNode }) {
  const { t } = useI18n()
  if (error === null || error === undefined) return null
  return <Notice error>{errorText(error, t)}{error instanceof ApiError && error.originalDetail && <details><summary>{t('core.error.original')}</summary><p>{error.originalDetail}</p></details>}{children}</Notice>
}
