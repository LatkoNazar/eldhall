import { render, screen } from '../test/render'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Icon } from './ui'

describe('decorative UI icons', () => {
  it('keeps controls named and keyboard-operable without adding SVG tab stops', async () => {
    const user = userEvent.setup()
    const search = vi.fn()
    const logout = vi.fn()
    const { container } = render(<>
      <button aria-label="Пошук" onClick={search}><Icon name="search" /></button>
      <button onClick={logout}><Icon name="logout" />Вийти</button>
    </>)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('focusable', 'false')
      expect(svg).not.toHaveAttribute('tabindex')
      expect(svg.children.length).toBeGreaterThan(0)
    }
    await user.tab()
    expect(screen.getByRole('button', { name: 'Пошук' })).toHaveFocus()
    await user.keyboard(' ')
    expect(search).toHaveBeenCalledTimes(1)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Вийти' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('retains the requested size and renders a local fallback for unknown or inherited names', () => {
    const { container, rerender } = render(<Icon name="eye-off" size={32} />)
    expect(container.querySelector('svg')).toHaveAttribute('width', '32')
    expect(container.querySelector('svg')).toHaveAttribute('height', '32')

    for (const name of ['not-an-icon', 'constructor', '__proto__']) {
      rerender(<Icon name={name} />)
      const svg = container.querySelector('svg')
      expect(svg).toHaveAttribute('width', '21')
      expect(svg).toHaveAttribute('height', '21')
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg!.children.length).toBeGreaterThan(0)
      expect(container.querySelector('img, image, use, [href], [src]')).toBeNull()
    }
  })
})
