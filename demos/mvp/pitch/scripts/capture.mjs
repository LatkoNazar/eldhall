// Records REAL MVP footage for the pitch film with Playwright and a live co-recorded Eldhall pointer.
// Two continuous sessions (customer chat, operator console) are recorded at 1600x900 and cut into
// the scene slots. Target geometry and timings are measured from the real DOM into scenes/geometry.json,
// and the backend state is verified through the API before any slot is written.
//
//   node scripts/capture.mjs              # needs the running MVP (see README) and OPERATOR_TOKEN
//   node scripts/capture.mjs --self-test  # toolchain check against the built landing page (not used in the film)
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const selfTest = process.argv.includes('--self-test')
const def = JSON.parse(await fs.readFile(path.join(root, 'scenes', 'pitch.json'), 'utf8'))
const cfg = JSON.parse(await fs.readFile(path.join(root, 'capture.config.json'), 'utf8'))
const W = def.capture.width, H = def.capture.height, FPS = def.fps, OVERLAP = 0.4, HOLD = 1.2
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const rx = s => new RegExp(s, 'i')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sceneDur = id => def.scenes.find(s => s.id === id).duration

// ---- live pointer (skill assets: 44x48 CSS px, arrow hotspot 3,3 / hand 22,4) ----
const cursorSvg = async f => 'data:image/svg+xml;base64,' + (await fs.readFile(path.join(root, 'assets', 'cursor', f))).toString('base64')
const pointerScript = (arrow, hand) => `(() => {
  const install = () => {
    if (document.getElementById('__eld_ptr')) return
    const el = document.createElement('img'); el.id = '__eld_ptr'; el.src = ${JSON.stringify(arrow)}
    Object.assign(el.style, { position: 'fixed', left: '0', top: '0', width: '44px', height: '48px', zIndex: 2147483647, pointerEvents: 'none', willChange: 'transform' })
    document.documentElement.appendChild(el)
    const st = window.__eldPtr = { x: ${W / 2}, y: ${H * 0.75}, hand: false }
    const place = () => { const hs = st.hand ? [22, 4] : [3, 3]; el.src = st.hand ? ${JSON.stringify(hand)} : ${JSON.stringify(arrow)}; el.style.transform = 'translate3d(' + (st.x - hs[0]) + 'px,' + (st.y - hs[1]) + 'px,0)' }
    place()
    st.move = (x, y, hand) => new Promise(done => {
      const x0 = st.x, y0 = st.y, d = Math.hypot(x - x0, y - y0), ms = Math.min(900, Math.max(320, d * 0.9)), t0 = performance.now()
      st.hand = hand
      const step = now => { const p = Math.min(1, (now - t0) / ms), e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
        st.x = x0 + (x - x0) * e; st.y = y0 + (y - y0) * e; place(); p < 1 ? requestAnimationFrame(step) : done() }
      requestAnimationFrame(step)
    })
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', install) : install()
})()`

async function session(browser, name, arrow, hand) {
  const dir = path.join(root, 'raw', name)
  await fs.mkdir(dir, { recursive: true })
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: W, height: H } } })
  await context.addInitScript(pointerScript(arrow, hand))
  const page = await context.newPage()
  const born = Date.now()
  const s = { name, context, page, born, marks: [] }
  s.t = () => (Date.now() - born) / 1000
  s.loc = spec => typeof spec === 'string' ? page.getByText(rx(spec)).first()
    : spec.role ? page.getByRole(spec.role, spec.name ? { name: rx(spec.name) } : {}).first()
    : page.getByLabel(rx(spec.label)).first()
  s.rect = async l => { const b = await l.boundingBox(); return b && [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }
  s.point = async (l, hand = true) => {
    await l.scrollIntoViewIfNeeded()
    const b = await l.boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2
    await page.evaluate(([x, y, h]) => window.__eldPtr?.move(x, y, h), [x, y, hand])
    await sleep(260); await page.mouse.move(x, y)
  }
  s.click = async l => { await s.point(l); await l.click() }
  s.type = async (l, text) => { await s.click(l); await l.pressSequentially(text, { delay: 38 }) }
  return s
}

// Cut [start, start+len] of a session recording into a CFR slot clip at the scene resolution.
function cut(src, start, len, out) {
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-ss', start.toFixed(3), '-i', src, '-t', len.toFixed(3), '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-an', '-movflags', '+faststart', out])
}

async function api(method, p, body, headers = {}) {
  const res = await fetch(cfg.apiUrl + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPERATOR_TOKEN ?? ''}`, ...headers }, body: body ? JSON.stringify(body) : undefined })
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${p} -> ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

const browser = await chromium.launch({ channel: process.env.CAPTURE_CHANNEL || cfg.channel, args: ['--hide-scrollbars'] })
const arrow = await cursorSvg('eldhall-arrow.svg'), hand = await cursorSvg('eldhall-pointer.svg')

if (selfTest) {
  // Toolchain check only: the landing page is real but it is NOT MVP footage and never fills a slot.
  const url = process.env.LANDING_URL || 'http://localhost:5174/#scenario'
  const s = await session(browser, 'selftest', arrow, hand)
  await s.page.goto(url); await sleep(800)
  const t0 = s.t()
  for (let i = 0; i < 4; i++) { await s.click(s.page.getByRole('button', { name: /Далі|Спочатку/ })); await sleep(700) }
  await s.click(s.page.getByRole('tab', { name: /ліміт/i })); await sleep(1200)
  const len = s.t() - t0 + 0.5
  await s.context.close()
  const out = path.join(root, 'renders', 'selftest-landing.mp4')
  await fs.mkdir(path.dirname(out), { recursive: true })
  cut(await s.page.video().path(), t0, len, out)
  console.log('self-test clip:', out, execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'compact', out], { encoding: 'utf8' }).trim())
  await browser.close()
  process.exit(0)
}

if (!process.env.OPERATOR_TOKEN) throw new Error('Set OPERATOR_TOKEN (same as the API)')
await api('GET', '/health/live')
await api('POST', '/api/v1/demo/reset')

const chat = await session(browser, 'chat', arrow, hand)
const op = await session(browser, 'operator', arrow, hand)
const geometry = {}
const seg = {}
const C = cfg.chat, O = cfg.operator

// Operator logs in off-camera time (segments start later).
await op.page.goto(cfg.appUrl + O.path)
const nameField = op.loc(O.loginName)
if (await nameField.isVisible().catch(() => false)) {
  await nameField.fill(O.operatorName); await op.loc(O.loginToken).fill(process.env.OPERATOR_TOKEN); await op.loc(O.loginSubmit).click()
}

// Scene "request": customer chat.
await chat.page.goto(cfg.appUrl + C.path); await sleep(600)
const persona = chat.loc(C.persona)
if (await persona.isVisible().catch(() => false)) { await chat.click(persona); await sleep(400) }
seg.request = { s: chat, start: chat.t() }
await chat.type(chat.loc(C.input), C.message)
await chat.click(chat.loc(C.send))
const reply = chat.page.getByText(rx(C.reply)).first()
await reply.waitFor({ timeout: 30000 })
const replyAt = chat.t() - seg.request.start
geometry.request = { highlights: [{ at: replyAt + 0.2, dur: 2.2, rect: await chat.rect(reply) }], focus: [{ at: 0.8, to: replyAt + 2.4, rect: await chat.rect(reply), scale: 1.2 }] }
seg.request.len = Math.max(sceneDur('request'), replyAt + 2.6)

// Scene "triage": queue with the new P1 case.
await op.page.goto(cfg.appUrl + O.path); await sleep(500)
seg.triage = { s: op, start: op.t() }
const item = op.loc(O.queueItem)
await item.waitFor({ timeout: 15000 }); await sleep(900)
const itemRect = await op.rect(item)
await op.click(item)
const openedAt = op.t() - seg.triage.start
geometry.triage = { highlights: [{ at: 0.9, dur: Math.max(1.2, openedAt - 1.2), rect: itemRect }], focus: [{ at: 0.4, to: openedAt + 0.6, rect: itemRect, scale: 1.45 }] }
await sleep(1200)
seg.triage.len = Math.max(sceneDur('triage'), op.t() - seg.triage.start + 0.6)

// Scene "policy": analysis + checklist (real elements).
seg.policy = { s: op, start: op.t() }
const analysis = op.loc(O.analysis), policy = op.loc(O.policy)
await op.point(analysis, false); await sleep(1600)
const aRect = await op.rect(analysis)
await op.point(policy, false); await sleep(2600)
const pRect = await op.rect(policy)
geometry.policy = { focus: [{ at: 0.4, to: 2.6, rect: aRect, scale: 1.5 }, { at: 2.9, to: op.t() - seg.policy.start - 0.4, rect: pRect, scale: 1.5 }], highlights: [{ at: 0.8, dur: 1.6, rect: aRect }, { at: 3.2, dur: 2.0, rect: pRect }] }
seg.policy.len = Math.max(sceneDur('policy'), op.t() - seg.policy.start + 0.4)

// Scene "approve": the real click.
seg.approve = { s: op, start: op.t() }
const approve = op.loc(O.approve)
const apRect = await op.rect(approve)
await op.click(approve)
const clickAt = op.t() - seg.approve.start
const executed = op.page.getByText(rx(O.executed)).first()
await executed.waitFor({ timeout: 15000 }); await sleep(1500)
geometry.approve = { highlights: [{ at: Math.max(0.2, clickAt - 0.9), dur: 1.4, rect: apRect, kind: 'action' }, { at: clickAt + 0.6, dur: 2.0, rect: await op.rect(executed) }], focus: [{ at: 0.2, to: op.t() - seg.approve.start - 0.3, rect: apRect, scale: 1.5 }] }
seg.approve.len = Math.max(sceneDur('approve'), op.t() - seg.approve.start + 0.4)

// Scene "result": the customer sees the confirmation (chat polls).
seg.result = { s: chat, start: chat.t() }
const conf = chat.page.getByText(rx(C.confirmation)).first()
await conf.waitFor({ timeout: 20000 })
const confAt = chat.t() - seg.result.start
await sleep(2400)
geometry.result = { highlights: [{ at: confAt + 0.2, dur: 2.2, rect: await chat.rect(conf) }], focus: [{ at: Math.max(0.3, confAt - 0.4), to: chat.t() - seg.result.start - 0.3, rect: await chat.rect(conf), scale: 1.2 }] }
seg.result.len = Math.max(sceneDur('result'), chat.t() - seg.result.start + 0.4)

// Scene "safety": Ivan writes through the real chat API (off camera); operator opens the escalated case.
const ivanCase = await api('POST', '/api/v1/chat/cases', null, { 'x-customer-session': 'demo-ivan' })
await api('POST', `/api/v1/chat/cases/${ivanCase.id}/messages`, { body: cfg.ivanMessage }, { 'x-customer-session': 'demo-ivan' })
await op.page.goto(cfg.appUrl + O.path); await sleep(600)
seg.safety = { s: op, start: op.t() }
const ivan = op.loc(O.ivanItem)
await ivan.waitFor({ timeout: 15000 }); await op.click(ivan)
const denied = op.page.getByText(rx(O.denied)).first()
await denied.waitFor({ timeout: 15000 }); await op.point(denied, false); await sleep(2600)
geometry.safety = { highlights: [{ at: op.t() - seg.safety.start - 2.5, dur: 2.2, rect: await op.rect(denied), kind: 'deny' }], focus: [{ at: 0.5, to: op.t() - seg.safety.start - 0.3, rect: await op.rect(denied), scale: 1.4 }] }
seg.safety.len = Math.max(sceneDur('safety'), op.t() - seg.safety.start + 0.4)

// Verify the real backend state before writing any slot.
const cases = await api('GET', '/api/v1/cases')
const detail = async name => api('GET', `/api/v1/cases/${cases.find(c => rx(name).test(c.customerName)).id}`)
const olena = await detail('Olena'), ivanD = await detail('Ivan')
const evidence = {
  at: new Date().toISOString(), appUrl: cfg.appUrl,
  model: olena.runs.map(r => ({ provider: r.provider, model: r.model, status: r.status, toolCalls: r.toolCalls })),
  olena: { status: olena.case.status, proposals: olena.proposals.map(p => [p.tool, p.status]), refunds: olena.refunds.length },
  ivan: { status: ivanD.case.status, proposals: ivanD.proposals.map(p => [p.tool, p.status]), refunds: ivanD.refunds.filter(r => ivanD.payments.some(p => p.id === r.paymentId)).length },
}
const ok = evidence.olena.status === 'resolved' && evidence.olena.refunds === 1 && olena.proposals.some(p => p.tool === 'refund_payment' && p.status === 'executed')
  && evidence.ivan.status === 'escalated' && evidence.ivan.refunds === 0 && ivanD.proposals.some(p => p.tool === 'refund_payment' && p.status === 'denied')
await fs.mkdir(path.join(root, 'capture'), { recursive: true })
await fs.writeFile(path.join(root, 'capture', 'evidence.json'), JSON.stringify({ ok, ...evidence }, null, 2))
await chat.context.close(); await op.context.close(); await browser.close()
if (!ok) throw new Error('Backend state does not match the storyboard; no slots written. See capture/evidence.json')
if (evidence.model.every(r => r.provider === 'rules')) console.warn('NOTE: rules mode — captions must not claim LLM tool calls.')

// Cut slots (+overlap tail for crossfades) and store measured geometry/durations.
await fs.mkdir(path.join(root, 'assets', 'capture'), { recursive: true })
for (const [id, g] of Object.entries(seg)) {
  cut(await g.s.page.video().path(), g.start, g.len + OVERLAP + 0.1, path.join(root, 'assets', 'capture', `${id}.mp4`))
  geometry[id].duration = Math.ceil(g.len * FPS) / FPS
}
await fs.writeFile(path.join(root, 'scenes', 'geometry.json'), JSON.stringify(geometry, null, 2))
console.log('Captured', Object.keys(seg).join(', '), '— evidence ok. Next: node scripts/build.mjs --final')
