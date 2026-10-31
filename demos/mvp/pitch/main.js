// Deterministic, seekable motion for the pitch film. Hyperframes owns media time;
// this only builds one paused GSAP timeline from the embedded scene config.
window.buildRootTimeline = (config) => {
  const tl = gsap.timeline({ paused: true })
  const { duration, overlap, window: win, capture: cap, scenes } = config
  tl.to({}, { duration, ease: 'none' }, 0)
  const at = (id) => document.getElementById(id)
  const captures = scenes.filter(s => s.type === 'capture')
  const intro = scenes[0], outro = scenes[scenes.length - 1]

  // Intro title
  tl.fromTo('#intro-brand', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0.15)
  tl.fromTo('#intro-kicker', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0.45)
  tl.fromTo('#intro-title .word', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out', stagger: 0.06 }, 0.6)
  tl.fromTo('#intro-sub', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }, 1.55)
  tl.to('#intro-card', { opacity: 0, scale: 1.03, duration: 0.45, ease: 'power2.in' }, intro.duration - 0.85)

  // Desktop + window entrance
  tl.fromTo('#desktop', { opacity: 0 }, { opacity: 1, duration: 0.6, ease: 'none' }, intro.duration - 0.5)
  tl.fromTo('#window', { opacity: 0, y: 60, scale: 0.955 }, { opacity: 1, y: 0, scale: 1, duration: 0.95, ease: 'power3.out', transformOrigin: '50% 50%' }, intro.duration - 0.05)
  tl.fromTo('#disclaimer', { opacity: 0 }, { opacity: 1, duration: 0.4 }, captures[0].start + 0.6)

  // Camera: zoom the stage so a capture-space rect is centred and readable.
  const focusParams = (rect, scale) => {
    const [x, y, w, h] = rect
    const px = win.x + (x + w / 2) * win.scale
    const py = win.y + win.titlebar + (y + h / 2) * win.scale
    const k = Math.max(1, Math.min(scale, 1720 / (w * win.scale), 880 / (h * win.scale)))
    return { scale: k, x: 960 - px * k, y: 500 - py * k }
  }

  captures.forEach((s, i) => {
    const t0 = s.start
    const last = i === captures.length - 1
    tl.fromTo(`#${s.id}-content`, { opacity: 0 }, { opacity: 1, duration: i === 0 ? 0.01 : overlap, ease: 'none' }, t0)
    tl.fromTo(`#${s.id}-url`, { opacity: 0 }, { opacity: 1, duration: 0.25 }, t0)
    tl.to(`#${s.id}-url`, { opacity: 0, duration: 0.2 }, t0 + s.duration - (last ? 0.2 : 0))
    tl.fromTo(`#${s.id}-caption`, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' }, t0 + 0.35)
    tl.to(`#${s.id}-caption`, { opacity: 0, y: -8, duration: 0.3, ease: 'power2.in' }, t0 + s.duration - 0.45)

    const foci = s.focus || []
    foci.forEach((f, j) => {
      tl.to('#stage', { ...focusParams(f.rect, f.scale), duration: 0.9, ease: 'power2.inOut' }, t0 + f.at)
      const next = foci[j + 1]
      if (!next || next.at > f.to + 0.85) tl.to('#stage', { scale: 1, x: 0, y: 0, duration: 0.8, ease: 'power2.inOut' }, t0 + f.to)
    })
    ;(s.highlights || []).forEach((h, j) => {
      const id = `#${s.id}-ring-${j}`
      tl.fromTo(id, { opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(2)', transformOrigin: '50% 50%' }, t0 + h.at)
      if (h.kind === 'action') tl.to(id, { scale: 1.05, duration: 0.3, yoyo: true, repeat: 1, ease: 'sine.inOut' }, t0 + h.at + 0.4)
      tl.to(id, { opacity: 0, duration: 0.3 }, t0 + h.at + h.dur)
    })
  })

  // Outro
  tl.to('#window', { opacity: 0, y: -30, scale: 0.96, duration: 0.6, ease: 'power2.in' }, outro.start - 0.15)
  tl.to('#desktop', { opacity: 0, duration: 0.6 }, outro.start + 0.1)
  tl.fromTo('#outro-card', { opacity: 0 }, { opacity: 1, duration: 0.5 }, outro.start)
  tl.fromTo('#outro-brand', { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(1.6)' }, outro.start + 0.3)
  tl.fromTo('#outro-title .word', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out', stagger: 0.07 }, outro.start + 0.6)
  tl.fromTo('#outro-sub', { opacity: 0 }, { opacity: 1, duration: 0.5 }, outro.start + 1.6)
  if (!at('outro-card')) console.warn('outro card missing')
  return tl
}
