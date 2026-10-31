import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Avatar } from './Avatar'

describe('local animal avatars', () => {
  it('keeps a customer illustration stable across rerenders and display-name changes', () => {
    const { container, rerender } = render(<Avatar name="Олена" seed="business-1:customer-1" />)
    const original = container.innerHTML
    rerender(<Avatar name="Олена Петренко" seed="business-1:customer-1" />)
    expect(container.innerHTML).toBe(original)
    rerender(<Avatar name="Олена" seed="business-1:customer-2" />)
    expect(container.innerHTML).not.toBe(original)
  })

  it('renders a decorative local illustration without exposing an identity or external image URL', () => {
    const { container } = render(<Avatar name="Олена Петренко" seed="private-customer-id" />)
    expect(container.querySelector('.avatar')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('svg')).toHaveAttribute('focusable', 'false')
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 64 64')
    expect(container.querySelector('img, image, [href], [src]')).toBeNull()
    expect(container.innerHTML).not.toContain('private-customer-id')
    expect(container.textContent).toBe('')
  })
})
