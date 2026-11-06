import type { ReactNode } from 'react'
import { useI18n, type AppMessageKey } from '../../i18n'
import { ApiError, errorText } from '../../lib/api'
import { Notice } from '../ui'

const messages: Record<string, AppMessageKey> = {
  openapi_json_required: 'onboarding.error.json', invalid_openapi: 'onboarding.error.json',
  address_blocked: 'onboarding.error.address', https_required: 'onboarding.error.https',
  credential_profile_unavailable: 'onboarding.error.profile', profile_origin_mismatch: 'onboarding.error.origin', profile_target_mismatch: 'onboarding.error.origin',
  spec_unauthorized: 'onboarding.error.authorization', redirect_refused: 'onboarding.error.redirect',
  unsupported_schema: 'onboarding.error.schema', invalid_openapi_or_review: 'onboarding.error.schema', review_not_compilable: 'onboarding.error.schema', invalid_import: 'onboarding.error.schema',
  compiler_busy: 'onboarding.error.busy', egress_busy: 'onboarding.error.busy', response_too_large: 'onboarding.error.size', response_headers_too_large: 'onboarding.error.size', encoded_response_refused: 'onboarding.error.encoded', invalid_url: 'onboarding.error.url', spec_unavailable: 'onboarding.error.remote', upstream_unavailable: 'onboarding.error.remote', connection_unavailable: 'onboarding.error.remote', runtime_missing: 'onboarding.error.runtime', managed_not_configured: 'onboarding.error.runtime', managed_unavailable: 'onboarding.error.runtime',
  prepared_identity_mismatch: 'onboarding.previewChanged', import_not_found: 'onboarding.previewChanged', unknown_operation: 'onboarding.error.selection', operation_not_supported: 'onboarding.error.selection', managed_request_refused: 'onboarding.error.refused',
}
function importErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object' || Array.isArray(error.payload)) return null
  const code = (error.payload as Record<string, unknown>).code
  return typeof code === 'string' && Object.hasOwn(messages, code) ? code : null
}

export function ImportErrorNotice({ error, children }: { error: unknown; children?: ReactNode }) {
  const { t } = useI18n()
  if (!error) return null
  const code = importErrorCode(error)
  return <Notice error>{code ? t(messages[code]!) : errorText(error, t)}{children}</Notice>
}
