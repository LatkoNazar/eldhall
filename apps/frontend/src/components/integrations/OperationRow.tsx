import { useId, type ReactNode } from 'react'
import { Icon } from '../ui'

export function OperationRow({ operationKey, method, path, title, status, controls, expanded, onToggle, children }: {
  operationKey: string; method: string; path: string; title: string; status: ReactNode; controls: ReactNode
  expanded: boolean; onToggle: () => void; children: ReactNode
}) {
  const id = useId()
  return <article className="integration-tool" data-operation-key={operationKey}>
    <div className="integration-tool-row">
      <button className="integration-tool-toggle" type="button" aria-expanded={expanded} aria-controls={id} aria-label={`${method} ${path} ${title}`} onClick={onToggle}>
        <Icon name="arrow" size={16} /><span className={`http-method http-${method.toLowerCase()}`}>{method}</span>
        <span className="integration-tool-name"><code>{path}</code><span>{title}</span></span>
      </button>
      <div className="integration-tool-state">{status}</div>{controls}
    </div>
    <div className="integration-tool-details" id={id} hidden={!expanded}>{children}</div>
  </article>
}
