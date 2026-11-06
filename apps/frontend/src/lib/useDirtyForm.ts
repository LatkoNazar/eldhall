import { useEffect } from 'react'
import { useI18n } from '../i18n'
import { registerNavigationGuard } from './navigation'

export function useDirtyForm(dirty: boolean) {
  const { t } = useI18n()
  useEffect(() => {
    if (!dirty) return
    const remove = registerNavigationGuard(() => window.confirm(t('operations.common.discardPrompt')))
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => { remove(); window.removeEventListener('beforeunload', warn) }
  }, [dirty, t])
}
