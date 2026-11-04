interface AuthorizationScope { token: string; generation: number; unauthorized: () => void }
let generation = 0
let active: AuthorizationScope | null = null

export function registerOperatorSession(token: string, unauthorized: () => void) {
  const scope = { token, unauthorized, generation: ++generation }
  active = scope
  return () => { if (active === scope) active = null }
}

// Capture at dispatch, including for mutations. A late response from an older
// session must not invalidate a newer session, even if its key string is equal.
export function captureOperatorUnauthorized(token: string, customer = false) {
  const scope = active
  if (customer || !scope || scope.token !== token) return undefined
  return () => {
    if (active !== scope || active.generation !== scope.generation) return
    active = null
    scope.unauthorized()
  }
}
