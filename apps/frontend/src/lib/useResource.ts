import { useCallback, useEffect, useState } from 'react'
import { errorText, request } from './api'

export function useResource<T>(path: string, token: string, interval = 0, customer = false) {
  const [state, setState] = useState<{ data: T | null; error: string; checkedAt: string | null; requestedAt: number | null }>({ data: null, error: '', checkedAt: null, requestedAt: null })
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    let active = true
    let timer = 0
    const controller = new AbortController()
    async function load() {
      const requestedAt = Date.now()
      try {
        const data = await request<T>(path, token, { signal: controller.signal, customer })
        if (active) setState({ data, error: '', checkedAt: new Date().toISOString(), requestedAt })
      } catch (error) { if (active) setState(previous => ({ ...previous, error: errorText(error) })) }
      finally { if (active && interval) timer = window.setTimeout(() => void load(), interval) }
    }
    void load()
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [path, token, interval, customer, revision])
  return { ...state, loading: state.data === null && !state.error, refresh }
}
