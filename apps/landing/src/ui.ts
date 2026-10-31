/** Mobile menu, header border on scroll, reveal-on-scroll. Each part is a no-op without its markup. */
export function initUi(root: Document = document): void {
  const header = root.querySelector<HTMLElement>('[data-header]')
  const nav = root.querySelector<HTMLElement>('[data-nav]')
  const toggle = root.querySelector<HTMLButtonElement>('[data-menu-toggle]')

  if (nav && toggle) {
    const setOpen = (open: boolean) => {
      nav.classList.toggle('is-open', open)
      toggle.setAttribute('aria-expanded', String(open))
    }
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'))
    nav.addEventListener('click', event => { if ((event.target as Element).closest('a')) setOpen(false) })
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setOpen(false); toggle.focus() }
    })
  }

  if (header) {
    const update = () => header.classList.toggle('is-scrolled', window.scrollY > 8)
    update()
    window.addEventListener('scroll', update, { passive: true })
  }

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true
  const targets = root.querySelectorAll<HTMLElement>('.reveal')
  if (reduced || !('IntersectionObserver' in window) || !targets.length) return
  root.documentElement.classList.add('js-motion')
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('is-visible')
      observer.unobserve(entry.target)
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
  targets.forEach(target => observer.observe(target))
}
