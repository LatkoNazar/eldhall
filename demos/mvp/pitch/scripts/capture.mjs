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
  const res = await fetch(cfg.apiUrl + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${process.env.OPERATOR_TOKEN ?? ''}`, ...headers }, body: body ? JSON.stringify(body) : undefined })
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
const api1 = await fetch(cfg.apiUrl + '/health/live'); if (!api1.ok) throw new Error('API is not reachable')
await api('POST', '/api/v1/demo/reset')

const chat = await session(browser, 'chat', arrow, hand)
const op = await session(browser, 'operator', arrow, hand)
const geometry = {}
const seg = {}
const C = cfg.chat, O = cfg.operator
const text = (s, re) => s.page.getByText(rx(re)).first()
const button = (s, re) => s.page.getByRole('button', { name: rx(re) }).first()
const caseItem = name => op.page.locator(O.caseItemCss, { hasText: rx(name) }).first()
const mark = (id, entry) => { geometry[id] ??= { focus: [], highlights: [] }; for (const k of ['focus', 'highlights']) if (entry[k]) geometry[id][k].push(...entry[k]) }
const since = id => op.t() - seg[id].start
const finish = (id, s) => { seg[id].len = Math.max(sceneDur(id), s.t() - seg[id].start + 0.4) }
const inbox = () => op.page.getByRole('heading', { name: /Вхідні звернення/ }).waitFor()

// Operator signs in before any operator segment starts (never on camera).
await op.page.goto(cfg.appUrl + O.path)
await op.page.locator(O.tokenCss).fill(process.env.OPERATOR_TOKEN)
await button(op, O.loginSubmit).click()
await inbox()

// request: customer chat
await chat.page.goto(cfg.appUrl + C.path)
await button(chat, C.persona).waitFor(); await sleep(500)
seg.request = { s: chat, start: chat.t() }
await chat.click(button(chat, C.persona))
const input = chat.page.locator(C.inputCss); await input.waitFor()
await chat.type(input, C.message)
await chat.click(button(chat, C.send))
const reply = text(chat, C.reply); await reply.waitFor({ timeout: 30000 })
const replyAt = chat.t() - seg.request.start
await sleep(1600)
const replyRect = await chat.rect(reply)
mark('request', { focus: [{ at: Math.max(0.5, replyAt - 1.2), to: chat.t() - seg.request.start - 0.2, rect: replyRect, scale: 1.25 }], highlights: [{ at: replyAt + 0.15, dur: 1.4, rect: replyRect }] })
finish('request', chat)

// triage: inbox, open the P1 case, show the copilot summary and signals
await op.page.reload(); await inbox()
const olena = caseItem(O.olena); await olena.waitFor({ timeout: 15000 }); await sleep(400)
seg.triage = { s: op, start: op.t() }
mark('triage', { highlights: [{ at: 0.3, dur: 1.2, rect: await op.rect(olena) }] })
await op.click(olena)
await text(op, O.summary).waitFor()
await op.click(op.page.locator('summary', { hasText: rx(O.signals) }).first()); await sleep(900)
const insp = await op.rect(op.page.locator('aside.inspector'))
mark('triage', { focus: [{ at: since('triage') - 1.4, to: since('triage') + 0.3, rect: [insp[0], insp[1], insp[2], Math.min(insp[3], 520)], scale: 1.6 }] })
finish('triage', op)

// policy: the proposed refund with its checklist
seg.policy = { s: op, start: op.t() }
const card = op.page.locator(O.actionCardCss).first()
await card.scrollIntoViewIfNeeded(); await sleep(300)
const checks = card.locator(O.checksCss).first()
await op.point(checks, false); await sleep(2600)
const cRect = await op.rect(card), kRect = await op.rect(checks)
mark('policy', { focus: [{ at: 0.3, to: since('policy') + 0.3, rect: cRect, scale: 1.7 }], highlights: [{ at: 0.9, dur: 2.2, rect: kRect }] })
finish('policy', op)

// approve: consent only, no money moves
seg.approve = { s: op, start: op.t() }
const approve = button(op, O.approve); await approve.scrollIntoViewIfNeeded()
const aRect = await op.rect(approve)
await op.click(approve)
const clickA = since('approve')
const note = text(op, O.approvedNote); await note.waitFor({ timeout: 15000 }); await sleep(1700)
mark('approve', { focus: [{ at: 0.2, to: since('approve') - 0.1, rect: await op.rect(card), scale: 1.7 }], highlights: [{ at: Math.max(0.2, clickA - 0.8), dur: 1.0, rect: aRect, kind: 'action' }, { at: clickA + 0.5, dur: 1.6, rect: await op.rect(note) }] })
finish('approve', op)

// execute: separate server-side execution
seg.execute = { s: op, start: op.t() }
const execute = button(op, O.execute); await execute.scrollIntoViewIfNeeded()
const eRect = await op.rect(execute)
await op.click(execute)
const clickE = since('execute')
const ref = text(op, O.refundRef); await ref.waitFor({ timeout: 15000 }); await ref.scrollIntoViewIfNeeded(); await sleep(1800)
const refRect = await op.rect(ref)
mark('execute', { focus: [{ at: 0.2, to: since('execute') - 0.1, rect: refRect, scale: 1.6 }], highlights: [{ at: Math.max(0.2, clickE - 0.8), dur: 1.0, rect: eRect, kind: 'action' }, { at: since('execute') - 1.6, dur: 1.4, rect: refRect }] })
finish('execute', op)

// result: the customer sees the confirmation
seg.result = { s: chat, start: chat.t() }
const conf = text(chat, C.confirmation); await conf.waitFor({ timeout: 20000 })
await chat.point(conf, false); await sleep(2200)
const confRect = await chat.rect(conf)
mark('result', { focus: [{ at: 0.4, to: chat.t() - seg.result.start - 0.2, rect: confRect, scale: 1.3 }], highlights: [{ at: 0.9, dur: 2.2, rect: confRect }] })
finish('result', chat)

// safety: Ivan writes through the real customer API (off camera); operator opens the case
const ivanCase = await api('POST', '/api/v1/chat/cases', null, { 'x-customer-session': 'demo-ivan' })
await api('POST', `/api/v1/chat/cases/${ivanCase.id}/messages`, { body: cfg.ivanMessage, clientMessageId: crypto.randomUUID() }, { 'x-customer-session': 'demo-ivan' })
await op.page.reload(); await inbox()
const ivan = caseItem(O.ivan); await ivan.waitFor({ timeout: 15000 }); await sleep(300)
seg.safety = { s: op, start: op.t() }
await op.click(ivan)
const denied = text(op, O.deniedCheck); await denied.waitFor({ timeout: 15000 }); await denied.scrollIntoViewIfNeeded()
await op.point(denied, false); await sleep(2400)
const dRect = await op.rect(denied)
mark('safety', { focus: [{ at: since('safety') - 2.6, to: since('safety') - 0.1, rect: dRect, scale: 1.6 }], highlights: [{ at: since('safety') - 2.3, dur: 2.0, rect: dRect, kind: 'deny' }] })
finish('safety', op)

// Verify the real backend state before writing any slot.
const cases = await api('GET', '/api/v1/cases')
const detail = async name => api('GET', `/api/v1/cases/${cases.find(c => rx(name).test(c.customerName)).id}`)
const olenaD = await detail(O.olena), ivanD = await detail(O.ivan)
const evidence = {
  at: new Date().toISOString(), appUrl: cfg.appUrl,
  model: [...olenaD.runs, ...ivanD.runs].map(r => ({ provider: r.provider, model: r.model, status: r.status })),
  olena: { status: olenaD.case.status, proposals: olenaD.proposals.map(p => [p.tool, p.status]), refunds: olenaD.refunds.map(r => r.providerRef) },
  ivan: { status: ivanD.case.status, priority: ivanD.case.priority, proposals: ivanD.proposals.map(p => [p.tool, p.status]), refunds: ivanD.refunds.length },
}
const ok = evidence.olena.status === 'resolved' && evidence.olena.refunds.length === 1 && olenaD.proposals.some(p => p.tool === 'refund_payment' && p.status === 'executed')
  && evidence.ivan.status === 'escalated' && evidence.ivan.refunds === 0 && ivanD.proposals.some(p => p.tool === 'refund_payment' && p.status === 'denied')
await fs.mkdir(path.join(root, 'capture'), { recursive: true })
await fs.writeFile(path.join(root, 'capture', 'evidence.json'), JSON.stringify({ ok, ...evidence }, null, 2))
await chat.context.close(); await op.context.close(); await browser.close()
if (!ok) throw new Error('Backend state does not match the storyboard; no slots written. See capture/evidence.json')
if (evidence.model.every(r => r.provider === 'rules')) console.warn('NOTE: rules mode — captions must not claim LLM tool calls.')

await fs.mkdir(path.join(root, 'assets', 'capture'), { recursive: true })
for (const [id, g] of Object.entries(seg)) {
  cut(await g.s.page.video().path(), g.start, g.len + OVERLAP + 0.1, path.join(root, 'assets', 'capture', `${id}.mp4`))
  geometry[id].duration = Math.ceil(g.len * FPS) / FPS
}
await fs.writeFile(path.join(root, 'scenes', 'geometry.json'), JSON.stringify(geometry, null, 2))
console.log('Captured', Object.keys(seg).join(', '), '— evidence ok:', JSON.stringify(evidence))
