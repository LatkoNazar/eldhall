import { localeOptions, normalizeLocale, useI18n } from '../i18n'

export function LanguagePicker() {
  const { t, locale, setLocale, switchingLocale, languageError } = useI18n()
  return <label className="language-picker"><span className="sr-only">{t('core.language.label')}</span><select aria-label={t('core.language.label')} value={switchingLocale ?? locale} aria-busy={switchingLocale !== null} onChange={event => { const next = normalizeLocale(event.target.value); if (next) setLocale(next) }}>{localeOptions.map(option => <option key={option.code} value={option.code} lang={option.code}>{option.name}</option>)}</select>{languageError && <span role="alert">{t(languageError.key, languageError.values)}</span>}</label>
}
