import { useI18n } from '../i18n'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { Icon } from './ui'

export function ReadOnlyDemoBanner() {
  const { t } = useI18n()
  return isReadOnlyDemo() ? <aside className="demo-read-only" role="note" title={t('presentation.demoReadonly')}><Icon name="lock" size={17} /><span className="demo-read-only-short" aria-hidden="true">{t('presentation.demoShort')}</span><span className="demo-read-only-full">{t('presentation.demoReadonly')}</span></aside> : null
}
