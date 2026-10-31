// Builds index.html from scenes/pitch.json + locales. Real footage goes in each scene's `slot`;
// a missing slot renders an explicit PLACEHOLDER panel. `--final` refuses to build with placeholders.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const final = process.argv.includes('--final')
const def = JSON.parse(await fs.readFile(path.join(root, 'scenes', 'pitch.json'), 'utf8'))
const t = JSON.parse(await fs.readFile(path.join(root, 'locales', `${def.locale}.json`), 'utf8'))
// Measured by scripts/capture.mjs from the real DOM; overrides storyboard estimates per scene.
const geometry = JSON.parse(await fs.readFile(path.join(root, 'scenes', 'geometry.json'), 'utf8').catch(() => '{}'))
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const esc = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const exists = p => fs.access(p).then(() => true, () => false)
const OVERLAP = 0.4 // crossfade between consecutive captures
const FLAME = '<svg viewBox="0 0 32 40" aria-hidden="true"><path d="M19 1C21 12 7 13 12 23c-5-1-6-5-6-5C-6 34 9 43 20 38 34 32 34 20 25 12c2 10-4 13-6 11C26 15 19 1 19 1Z" fill="currentColor"/></svg>'
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'

const { width: W, height: H, fps } = def
const cap = def.capture
const win = { ...def.window, scale: def.window.width / cap.width }
win.viewportHeight = Math.round(cap.height * win.scale)

let start = 0
const scenes = []
const ledger = []
const placeholders = []
for (const base of def.scenes) {
  const s = { ...base, ...(geometry[base.id] ?? {}) }
  const scene = { ...s, start }
  if (s.type === 'capture') {
    const file = path.join(root, s.slot)
    scene.real = await exists(file)
    if (scene.real) {
      const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' }))
      const v = info.streams.find(x => x.width)
      if (v.width !== cap.width || v.height !== cap.height) throw new Error(`${s.slot}: ${v.width}x${v.height}, expected ${cap.width}x${cap.height}`)
      const need = s.duration + OVERLAP + (s.mediaStart ?? 0)
      if (Number(info.format.duration) + 0.01 < need) throw new Error(`${s.slot} is ${Number(info.format.duration).toFixed(2)}s; scene needs ${need.toFixed(2)}s (record a longer genuine hold, do not speed up)`)
      ledger.push({ id: s.id, slot: s.slot, sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'), mediaStart: s.mediaStart ?? 0, playbackRate: 1, stream: v })
    } else placeholders.push(s.slot)
  }
  scenes.push(scene)
  start += s.duration
}
if (final && placeholders.length) throw new Error(`--final: missing real footage for ${placeholders.join(', ')}`)
const duration = Math.round(start * fps) / fps
const captures = scenes.filter(s => s.type === 'capture')
const intro = scenes[0], outro = scenes.at(-1)
const deskStart = intro.start + intro.duration - 0.5
const deskEnd = outro.start + 0.7

const ringHtml = s => (s.highlights ?? []).map((h, i) => {
  const [x, y, w, hh] = h.rect
  return `<div id="${s.id}-ring-${i}" class="ring ${h.kind ?? ''}" style="left:${x}px;top:${y}px;width:${w}px;height:${hh}px"></div>`
}).join('')
const content = (s, i) => {
  const last = i === captures.length - 1
  const d = s.duration + (last ? 0 : OVERLAP)
  const z = `style="z-index:${i + 1}"`
  return s.real
    ? `<video id="${s.id}-content" class="clip footage" ${z} data-start="${s.start}" data-duration="${d}" data-media-start="${s.mediaStart ?? 0}" data-playback-rate="1" data-track-index="0" src="${s.slot}" muted playsinline></video>`
    : `<div id="${s.id}-content" class="clip placeholder" ${z} data-start="${s.start}" data-duration="${d}" data-track-index="0"><span class="ph-tag">${esc(t.placeholder)}</span><span class="ph-file">${esc(s.slot)}</span><span class="ph-shows">${esc(s.shows)}</span></div>`
}
const words = text => text.trim().split(/\s+/).map(w => `<span class="word">${esc(w)}</span>`).join(' ')

const body = [
  `<div id="intro-card" class="clip card" data-start="${intro.start}" data-duration="${intro.duration}" data-track-index="3">
      <div class="brand" id="intro-brand">${FLAME}${esc(t.brand)}</div>
      <div class="kicker" id="intro-kicker">${esc(t.introKicker)}</div>
      <h1 id="intro-title">${words(t.introTitleA)} <em class="word">${esc(t.introTitleB)}</em></h1>
      <p id="intro-sub">${esc(t.introSubtitle)}</p>
    </div>`,
  `<div id="desktop" class="clip desktop" data-start="${deskStart}" data-duration="${deskEnd - deskStart}" data-track-index="1"></div>`,
  `<div id="stage" class="clip stage" data-start="${deskStart}" data-duration="${deskEnd - deskStart}" data-track-index="2">
      <div id="window" class="window">
        <div class="titlebar"><div class="lights"><i></i><i></i><i></i></div>
          <div class="urlbar">${captures.map(s => `<div id="${s.id}-url" class="url">${LOCK}${esc(s.url)}</div>`).join('')}</div>
        </div>
        <div class="viewport"><div class="capture-space">
          ${captures.map(content).join('\n          ')}
          ${captures.map(s => `<div class="rings" style="position:absolute;inset:0;z-index:50">${ringHtml(s)}</div>`).join('')}
        </div></div>
      </div>
    </div>`,
  `<div id="captions" class="clip caption-layer" data-start="${captures[0].start}" data-duration="${outro.start - captures[0].start}" data-track-index="4">
      ${captures.map((s, i) => `<div id="${s.id}-caption" class="caption"><span class="n">${String(i + 1).padStart(2, '0')}</span>${esc(t[s.id])}</div>`).join('\n      ')}
      <div id="disclaimer" class="disclaimer">${esc(t.disclaimer)}</div>
    </div>`,
  `<div id="outro-card" class="clip card outro" data-start="${outro.start}" data-duration="${outro.duration}" data-track-index="3">
      <div class="brand" id="outro-brand">${FLAME}${esc(t.brand)}</div>
      <h1 id="outro-title">${words(t.outroTitleA)} <em class="word">${esc(t.outroTitleB)}</em></h1>
      <p id="outro-sub">${esc(t.outroSubtitle)}</p>
    </div>`,
  placeholders.length ? `<div id="draft-badge" class="clip draft-badge" data-start="0" data-duration="${duration}" data-track-index="5"><span>${esc(t.draftBadge)}</span></div>` : '',
].filter(Boolean)

const config = { id: def.id, fps, width: W, height: H, duration, overlap: OVERLAP, capture: cap, window: win, scenes, draft: placeholders.length > 0 }
const html = `<!doctype html>
<html lang="uk" style="--canvas-width:${W}px;--canvas-height:${H}px;--wx:${win.x}px;--wy:${win.y}px;--ww:${win.width}px;--tb:${win.titlebar}px;--vh:${win.viewportHeight}px;--cw:${cap.width}px;--ch:${cap.height}px;--cs:${win.scale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${W},height=${H}">
  <link rel="stylesheet" href="styles.css">
  <script src="assets/vendor/gsap.min.js"></script>
</head>
<body>
  <main id="root" data-composition-id="${def.id}" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}" data-fps="${fps}">
    ${body.join('\n    ')}
  </main>
  <script id="demo-config" type="application/json">${JSON.stringify(config)}</script>
  <script src="main.js"></script>
  <script>window.__timelines=window.__timelines||{};window.__timelines['${def.id}']=window.buildRootTimeline(JSON.parse(document.getElementById('demo-config').textContent));</script>
</body>
</html>
`
await fs.writeFile(path.join(root, 'index.html'), html)
await fs.writeFile(path.join(root, 'scene-timing.json'), JSON.stringify(config, null, 2))
await fs.writeFile(path.join(root, 'assets', 'ledger.json'), JSON.stringify({ built: final ? 'final' : 'draft', placeholders, footage: ledger }, null, 2))
// Captions as SRT for accessibility / slide notes.
const stamp = s => { const ms = Math.round(s * 1000), p = (v, l = 2) => String(v).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}` }
await fs.mkdir(path.join(root, 'exports'), { recursive: true })
await fs.writeFile(path.join(root, 'exports', 'eldhall-pitch-uk.srt'), captures.map((s, i) => `${i + 1}\n${stamp(s.start + 0.35)} --> ${stamp(s.start + s.duration - 0.3)}\n${t[s.id]}\n`).join('\n'))
console.log(`Built ${def.id}: ${duration}s @ ${fps}fps, ${captures.length} capture scenes, ${placeholders.length ? `DRAFT with ${placeholders.length} placeholders` : 'all real footage'}`)
