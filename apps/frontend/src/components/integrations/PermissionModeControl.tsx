import { useId } from 'react'
import { useI18n } from '../../i18n'
import { modeLabel, type PermissionMode, type RuleMode } from '../../lib/integrations-api'

/** A policy draft, never a claim that runtime authorization has passed. */
export function PermissionModeControl({ value, inherited = 'deny', label, disabled = false, onChange }: {
  value: RuleMode; inherited?: PermissionMode; label: string; disabled?: boolean; onChange: (value: PermissionMode) => void
}) {
  const { t } = useI18n()
  const name = useId()
  const selected = value === 'inherit' ? inherited : value
  return <fieldset className="permission-mode" disabled={disabled} data-mode={selected}>
    <legend className="sr-only">{label}</legend>
    {(['deny', 'ask', 'auto'] as const).map(mode => <label className={`permission-mode-option permission-${mode}`} key={mode}>
      <input type="radio" name={name} value={mode} checked={selected === mode} aria-label={modeLabel(mode, t)}
        onChange={() => onChange(mode)} onClick={() => { if (value === 'inherit' && selected === mode) onChange(mode) }} />
      <span>{mode === 'deny' ? 'Deny' : mode === 'ask' ? 'Ask' : 'Auto'}</span>
    </label>)}
  </fieldset>
}
