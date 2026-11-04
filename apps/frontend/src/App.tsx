import { useCallback, useEffect, useState } from 'react'
import { CustomerChat } from './pages/CustomerChat'
import { OperatorGate } from './components/OperatorGate'
import type { OperatorLink } from './lib/operator-link'
import { subscribeOperatorLinks } from './lib/operator-link'
import { useAppLocation } from './lib/navigation'

export default function App({ initialOperatorLink = {} }: { initialOperatorLink?: OperatorLink }) {
  const location = useAppLocation()
  const [bootstrap, setBootstrap] = useState({ link: initialOperatorLink, generation: 0 })
  useEffect(() => subscribeOperatorLinks(link => setBootstrap(current => ({ link, generation: current.generation + 1 }))), [])
  const consumeLink = useCallback(() => setBootstrap(current => Object.keys(current.link).length ? { ...current, link: {} } : current), [])
  if (new URL(location, window.location.origin).pathname.replace(/\/+$/, '') === '/chat') return <CustomerChat />
  return <OperatorGate key={bootstrap.generation} location={location} initialLink={bootstrap.link} onLinkConsumed={consumeLink} />
}
