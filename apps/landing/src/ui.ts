/** Mobile menu, header border on scroll, reveal-on-scroll. Each part is a no-op without its markup. */
export function initUi(root: Document = document): () => void {
  const page = root.defaultView
  if (!page) return () => {}
  const cleanup: Array<() => void> = []
  const header = root.querySelector<HTMLElement>('[data-header]')
  const nav = root.querySelector<HTMLElement>('[data-nav]')
  const toggle = root.querySelector<HTMLButtonElement>('[data-menu-toggle]')
  if (nav && toggle) {
    const setOpen = (open: boolean) => {
      nav.classList.toggle('is-open', open)
      toggle.setAttribute('aria-expanded', String(open))
    }
    const toggleMenu = () => setOpen(toggle.getAttribute('aria-expanded') !== 'true')
    const closeOnLink = (event: Event) => { if ((event.target as Element).closest('a')) setOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setOpen(false); toggle.focus() }
    }
    toggle.addEventListener('click', toggleMenu)
    nav.addEventListener('click', closeOnLink)
    root.addEventListener('keydown', closeOnEscape)
    cleanup.push(() => {
      toggle.removeEventListener('click', toggleMenu)
      nav.removeEventListener('click', closeOnLink)
      root.removeEventListener('keydown', closeOnEscape)
    })
  }
  if (header) {
    const update = () => header.classList.toggle('is-scrolled', page.scrollY > 8)
    update()
    page.addEventListener('scroll', update, { passive: true })
    cleanup.push(() => page.removeEventListener('scroll', update))
  }
  const reduced = page.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true
  const targets = root.querySelectorAll<HTMLElement>('.reveal')
  if (!reduced && 'IntersectionObserver' in page && targets.length) {
    root.documentElement.classList.add('js-motion')
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
    targets.forEach(target => observer.observe(target))
    cleanup.push(() => observer.disconnect())
  }
  return () => cleanup.forEach(remove => remove())
}
