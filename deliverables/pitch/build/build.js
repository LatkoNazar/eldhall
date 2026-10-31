// Builds deliverables/pitch/Eldhall-Pitch.pptx. Run: node build.js
const path = require('path')
const pptxgen = require('pptxgenjs')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const sharp = require('sharp')
const lu = require('react-icons/lu')
const { applyTheme } = require(path.join(process.env.PPTX_SKILL, 'scripts', 'apply_theme.js'))

const OUT = path.resolve(__dirname, '..', 'Eldhall-Pitch.pptx')

// Eldhall tokens (apps/landing/src/styles.css). Arial stands in for Inter for portability.
const HEX = { ink: '16161B', ink2: '4A4A55', muted: '696975', accent: 'D7263D', ok: '16A34A', info: '2563EB', warn: '8F5600', line: 'ECECF0', alt: 'F6F6F8', dark2: '24242B', darkLine: '3A3A44', darkMuted: 'A9A9B4' }
const THEME = {
  name: 'Eldhall',
  headFontFace: 'Arial',
  bodyFontFace: 'Arial',
  colors: { dk1: HEX.ink, lt1: 'FFFFFF', dk2: HEX.ink2, lt2: HEX.alt, accent1: HEX.accent, accent2: HEX.ok, accent3: HEX.info, accent4: HEX.warn, accent5: HEX.muted, accent6: HEX.line, hlink: HEX.accent, folHlink: 'BB1C31' },
}
const FLAME = 'M19 1C21 12 7 13 12 23c-5-1-6-5-6-5C-6 34 9 43 20 38 34 32 34 20 25 12c2 10-4 13-6 11C26 15 19 1 19 1Z'

async function flamePng(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" width="320" height="400"><path d="${FLAME}" fill="#${color}"/></svg>`
  return 'image/png;base64,' + (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')
}
async function iconPng(name, color) {
  const svg = renderToStaticMarkup(React.createElement(lu[name], { color: `#${color}`, size: 256, strokeWidth: 1.8 }))
  return 'image/png;base64,' + (await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer()).toString('base64')
}

async function main() {
  const pres = new pptxgen()
  pres.layout = 'LAYOUT_WIDE' // 13.333 x 7.5
  pres.title = 'Eldhall — AI Support Copilot'
  pres.author = 'Eldhall team'
  pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace }
  const C = pres.SchemeColor
  const W = 13.333

  const flameRed = await flamePng(HEX.accent)
  const icons = {}
  const icon = async (name, color = HEX.accent) => (icons[name + color] ??= await iconPng(name, color))

  // Layouts
  const footer = (dark) => [
    { image: { x: 0.6, y: 6.98, w: 0.16, h: 0.2, data: flameRed } },
    { text: { text: 'eldhall', options: { x: 0.82, y: 6.93, w: 1.2, h: 0.3, fontSize: 11, bold: true, color: dark ? 'FFFFFF' : HEX.ink, margin: 0 } } },
    { text: { text: 'PolyTech Code Fest × SKELAR', options: { x: 1.75, y: 6.93, w: 4, h: 0.3, fontSize: 10, color: dark ? HEX.darkMuted : HEX.muted, margin: 0 } } },
  ]
  const titlePh = (dark) => ({ placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 0.78, w: 12.1, h: 0.85, fontSize: 32, bold: true, color: dark ? 'FFFFFF' : HEX.ink, charSpacing: -0.5, align: 'left', valign: 'top', margin: 0 }, text: '' } })
  const eyebrowPh = { placeholder: { options: { name: 'eyebrow', type: 'body', x: 0.6, y: 0.42, w: 9, h: 0.32, fontSize: 12, bold: true, color: HEX.accent, charSpacing: 1.5, margin: 0 }, text: '' } }
  pres.defineSlideMaster({ title: 'Content', background: { color: 'FFFFFF' }, objects: [...footer(false), eyebrowPh, titlePh(false)], slideNumber: { x: 12.2, y: 6.93, w: 0.5, h: 0.3, fontSize: 10, color: HEX.muted, align: 'right' } })
  pres.defineSlideMaster({ title: 'Dark Content', background: { color: HEX.ink }, objects: [...footer(true), eyebrowPh, titlePh(true)], slideNumber: { x: 12.2, y: 6.93, w: 0.5, h: 0.3, fontSize: 10, color: HEX.darkMuted, align: 'right' } })
  pres.defineSlideMaster({ title: 'Title', background: { color: HEX.ink }, objects: [] })

  // Helpers (fresh option objects every call: pptxgenjs mutates them)
  const T = (slide, text, o) => slide.addText(text, { isTextBox: true, margin: 0, fontSize: 14, color: HEX.ink, valign: 'top', ...o })
  const card = (slide, x, y, w, h, o = {}) => slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: o.fill ?? 'FFFFFF' }, line: { color: o.line ?? HEX.line, width: 1 }, ...(o.shadow ? { shadow: { type: 'outer', color: '000000', opacity: 0.12, blur: 14, offset: 4, angle: 90 } } : {}), objectName: o.name })
  const soft = (slide, x, y, w, h, color, name) => slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.1, fill: { color, transparency: 90 }, line: { color, transparency: 100 }, objectName: name })
  const iconTile = async (slide, name, x, y, s = 0.52, color = HEX.accent) => {
    soft(slide, x, y, s, s, color, `icon-tile-${name}`)
    slide.addImage({ data: await icon(name, color), x: x + s * 0.24, y: y + s * 0.24, w: s * 0.52, h: s * 0.52, altText: name.replace('Lu', '') })
  }
  const tag = (slide, text, x, y, color, o = {}) => {
    const w = o.w ?? Math.max(0.6, 0.085 * text.length + 0.32)
    soft(slide, x, y, w, 0.3, color, `tag-${text}`)
    T(slide, text, { x, y, w, h: 0.3, fontSize: 10, bold: true, color, align: 'center', valign: 'middle' })
    return w
  }
  // PowerPoint refuses negative extents: draw with positive w/h and flip instead.
  const arrow = (slide, x1, y1, x2, y2, color = HEX.muted) => slide.addShape(pres.shapes.LINE, {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1, line: { color, width: 1.5, endArrowType: 'triangle' },
  })
  const content = (section, eyebrow, title, dark = false) => {
    const s = pres.addSlide({ masterName: dark ? 'Dark Content' : 'Content', sectionTitle: section })
    s.addText(eyebrow, { placeholder: 'eyebrow' })
    s.addText(title, { placeholder: 'title' })
    return s
  }

  // 1 — Title
  pres.addSection({ title: 'Opening' })
  {
    const s = pres.addSlide({ masterName: 'Title', sectionTitle: 'Opening' })
    s.addImage({ data: flameRed, x: 0.8, y: 0.75, w: 0.36, h: 0.45 })
    T(s, 'eldhall', { x: 1.28, y: 0.73, w: 3, h: 0.5, fontSize: 26, bold: true, color: 'FFFFFF', charSpacing: -1, valign: 'middle' })
    T(s, 'AI SUPPORT COPILOT · MVP', { x: 0.8, y: 2.15, w: 7, h: 0.35, fontSize: 13, bold: true, color: HEX.accent, charSpacing: 2 })
    T(s, [
      { text: 'Підтримка, яка не лише відповідає, а ', options: { color: 'FFFFFF' } },
      { text: 'вирішує', options: { color: HEX.accent } },
    ], { x: 0.8, y: 2.6, w: 7.2, h: 2.2, fontSize: 46, bold: true, charSpacing: -1, lineSpacingMultiple: 0.95 })
    T(s, 'AI розуміє звернення, перевіряє правила бізнесу й виконує дію — після підтвердження людини.', { x: 0.8, y: 4.95, w: 6.8, h: 0.8, fontSize: 16, color: HEX.darkMuted })
    T(s, 'PolyTech Code Fest × SKELAR · 31.10.2026 · [Назва команди · учасники]', { x: 0.8, y: 6.7, w: 8, h: 0.3, fontSize: 11, color: HEX.darkMuted })
    // Flow pills
    const steps = [['LuMessageSquare', 'Звернення'], ['LuBrain', 'AI-аналіз'], ['LuShieldCheck', 'Перевірка правил'], ['LuUserCheck', 'Підтвердження людини'], ['LuCircleCheck', 'Виконана дія']]
    for (const [i, [ic, label]] of steps.entries()) {
      const y = 1.55 + i * 0.98
      card(s, 8.7, y, 3.9, 0.72, { fill: HEX.dark2, line: HEX.darkLine, name: `flow-${i}` })
      s.addImage({ data: await icon(ic, i === 4 ? '4ADE80' : 'F87171'), x: 8.95, y: y + 0.2, w: 0.32, h: 0.32 })
      T(s, label, { x: 9.45, y, w: 3, h: 0.72, fontSize: 15, bold: true, color: 'FFFFFF', valign: 'middle' })
      if (i < 4) arrow(s, 10.65, y + 0.74, 10.65, y + 0.96, HEX.darkLine)
    }
    s.addNotes('Відкриття (0:00–0:20). Представитися, назвати команду. Одне речення: Eldhall — AI-копілот підтримки, який не просто відповідає, а безпечно виконує дії. ▶ Перейти до «Проблема».')
  }

  // 2 — Problem
  pres.addSection({ title: 'Problem' })
  {
    const s = content('Problem', 'ПРОБЛЕМА', 'Чатботи відповідають — вирішують досі люди')
    const items = [
      ['LuRepeat', 'Повторювані звернення', 'Подвійні списання, повернення, перевірка платежів — щодня ті самі сценарії.'],
      ['LuSearch', 'Ручний пошук у білінгу', 'Щоб перевірити один платіж, оператор перемикається між кількома системами.'],
      ['LuFrown', 'Клієнт чекає й злиться', 'Поки кейс у черзі, напруга росте, а разом із нею — ризик ескалації.'],
    ]
    for (const [i, [ic, h, p]] of items.entries()) {
      const x = 0.6 + i * 4.1
      card(s, x, 1.95, 3.85, 2.45, { name: `problem-${i}` })
      await iconTile(s, ic, x + 0.3, 2.25)
      T(s, h, { x: x + 0.3, y: 2.95, w: 3.3, h: 0.4, fontSize: 17, bold: true })
      T(s, p, { x: x + 0.3, y: 3.4, w: 3.3, h: 0.9, fontSize: 14, color: HEX.ink2 })
    }
    // Contrast panel
    card(s, 0.6, 4.7, 5.95, 1.85, { fill: HEX.alt, line: HEX.alt, name: 'bot' })
    T(s, 'Звичайний чатбот', { x: 0.9, y: 4.95, w: 5, h: 0.35, fontSize: 15, bold: true, color: HEX.ink2 })
    T(s, [
      { text: 'Відповідає шаблоном і відсилає до форми', options: { bullet: true, breakLine: true } },
      { text: 'Або нічого не робить, або діє без контролю', options: { bullet: true } },
    ], { x: 0.9, y: 5.38, w: 5.4, h: 1, fontSize: 14, color: HEX.ink2, paraSpaceAfter: 4 })
    soft(s, 6.75, 4.7, 5.95, 1.85, HEX.accent, 'need')
    T(s, 'Що потрібно бізнесу', { x: 7.05, y: 4.95, w: 5, h: 0.35, fontSize: 15, bold: true, color: HEX.accent })
    T(s, [
      { text: 'AI, який сам знаходить дані й пропонує дію', options: { bullet: true, breakLine: true } },
      { text: 'У межах правил і під контролем людини', options: { bullet: true } },
    ], { x: 7.05, y: 5.38, w: 5.4, h: 1, fontSize: 14, color: HEX.ink, paraSpaceAfter: 4 })
    s.addNotes('Проблема (0:20–0:55). Підтримка тоне в однакових грошових зверненнях. Чатбот або відповідає шаблоном, або — що гірше — діє без контролю. Бізнесу потрібен AI, який діє, але в межах правил. Без вигаданої статистики. ▶ «Продукт».')
  }

  // 3 — Product
  pres.addSection({ title: 'Product' })
  {
    const s = content('Product', 'РІШЕННЯ', 'Eldhall Support Copilot')
    T(s, 'AI-копілот, який розуміє звернення, перевіряє дані та правила бізнесу й виконує дію — після підтвердження оператора.', { x: 0.6, y: 1.9, w: 5.6, h: 1.1, fontSize: 17, color: HEX.ink2 })
    const rows = [
      ['LuBrain', 'Розуміє намір і настрій', 'intent, sentiment, терміновість, пріоритет'],
      ['LuDatabase', 'Знаходить дані сам', 'через дозволені інструменти, лише цього клієнта'],
      ['LuShieldCheck', 'Перевіряє правила', 'детермінований policy engine, не модель'],
      ['LuUserCheck', 'Діє з підтвердженням', 'ризиковані дії — тільки після «так» людини'],
    ]
    for (const [i, [ic, h, p]] of rows.entries()) {
      const y = 3.15 + i * 0.88
      await iconTile(s, ic, 0.6, y, 0.5)
      T(s, h, { x: 1.3, y: y - 0.02, w: 4.9, h: 0.3, fontSize: 15, bold: true })
      T(s, p, { x: 1.3, y: y + 0.27, w: 4.9, h: 0.3, fontSize: 13, color: HEX.muted })
    }
    // Console illustration
    const x = 6.75, y = 1.9, w = 5.95
    card(s, x, y, w, 4.75, { shadow: true, name: 'console' })
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h: 0.5, rectRadius: 0.12, fill: { color: HEX.alt }, line: { color: HEX.line, width: 1 }, objectName: 'console-bar' })
    s.addShape(pres.shapes.RECTANGLE, { x: x + 0.02, y: y + 0.3, w: w - 0.04, h: 0.2, fill: { color: HEX.alt }, line: { color: HEX.alt, width: 0 } })
    for (const [i, col] of ['FF5F57', 'FEBC2E', '28C840'].entries()) s.addShape(pres.shapes.OVAL, { x: x + 0.22 + i * 0.22, y: y + 0.18, w: 0.13, h: 0.13, fill: { color: col }, line: { color: col, width: 0 } })
    T(s, 'Eldhall · Operator console', { x: x + 1.0, y: y + 0.1, w: 3, h: 0.3, fontSize: 11, bold: true, color: HEX.ink2, valign: 'middle' })
    T(s, 'ілюстрація · демо-дані', { x: x + w - 2.0, y: y + 0.1, w: 1.8, h: 0.3, fontSize: 10, color: HEX.muted, align: 'right', valign: 'middle' })
    T(s, 'Case · NovaPay Fitness', { x: x + 0.3, y: y + 0.7, w: 3, h: 0.25, fontSize: 10, color: HEX.muted })
    T(s, 'Подвійне списання за жовтень', { x: x + 0.3, y: y + 0.93, w: 4.3, h: 0.35, fontSize: 16, bold: true })
    tag(s, 'P1', x + w - 0.85, y + 0.8, HEX.accent, { w: 0.55 })
    let tx = x + 0.3
    tx += tag(s, 'frustrated', tx, y + 1.42, HEX.warn) + 0.1
    tx += tag(s, 'duplicate_charge', tx, y + 1.42, HEX.info) + 0.1
    card(s, x + 0.3, y + 1.9, 4.8, 0.5, { fill: HEX.alt, name: 'bubble' })
    T(s, 'Ви списали з мене двічі за жовтень!!! Негайно поверніть', { x: x + 0.45, y: y + 1.9, w: 4.6, h: 0.5, fontSize: 11, valign: 'middle' })
    card(s, x + 0.3, y + 2.55, w - 0.6, 1.05, { name: 'policy' })
    T(s, 'Policy check', { x: x + 0.5, y: y + 2.63, w: 3, h: 0.25, fontSize: 11, bold: true })
    for (const [i, t] of ['Платіж належить клієнту', 'Ідентичне списання за 40 с', 'У межах ліміту повернення'].entries()) {
      s.addImage({ data: await icon('LuCheck', HEX.ok), x: x + 0.5, y: y + 2.93 + i * 0.21, w: 0.16, h: 0.16 })
      T(s, t, { x: x + 0.75, y: y + 2.9 + i * 0.21, w: 4.5, h: 0.22, fontSize: 10.5, color: HEX.ink2 })
    }
    soft(s, x + 0.3, y + 3.75, w - 0.6, 0.75, HEX.accent, 'action')
    T(s, 'Proposed action · high risk', { x: x + 0.5, y: y + 3.83, w: 3.5, h: 0.22, fontSize: 10, bold: true, color: HEX.accent })
    T(s, 'refund_payment · 499.00 UAH', { x: x + 0.5, y: y + 4.07, w: 3.5, h: 0.3, fontSize: 13, bold: true })
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + w - 1.6, y: y + 3.92, w: 1.1, h: 0.42, rectRadius: 0.08, fill: { color: HEX.accent }, line: { color: HEX.accent, width: 0 }, objectName: 'approve' })
    T(s, 'Approve', { x: x + w - 1.6, y: y + 3.92, w: 1.1, h: 0.42, fontSize: 12, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' })
    s.addNotes('Продукт (0:55–1:30). Eldhall — копілот, а не чатбот: розуміє намір і настрій, сам знаходить потрібні платежі, перевіряє правила й пропонує конкретну дію. Ризиковані дії виконуються тільки після підтвердження оператора. Праворуч — ілюстрація консолі на демо-даних. ▶ «AI reasoning».')
  }

  // 4 — AI reasoning & context
  pres.addSection({ title: 'How it works' })
  {
    const s = content('How it works', 'AI REASONING & CONTEXT', 'AI думає з контекстом — і лише пропонує')
    const boxes = [
      ['LuKeyRound', 'Контекст із сесії', 'Профіль, останні платежі, політика бізнесу, історія. Особа — з сесії, не з тексту'],
      ['LuCpu', 'LLM + tool call', 'Модель сама викликає lookup_payments (лише читання). ≤ 4 кроки, таймаут'],
      ['LuFileText', 'Типізоване рішення', 'intent · sentiment · відповідь · запропонована дія — за строгою схемою'],
      ['LuShieldCheck', 'Policy engine', 'Детерміновані перевірки: дозволено, потрібне підтвердження чи відхилено'],
    ]
    const bw = 2.78, gap = 0.33
    for (const [i, [ic, h, p]] of boxes.entries()) {
      const x = 0.6 + i * (bw + gap)
      card(s, x, 1.95, bw, 2.75, { name: `ctx-${i}` })
      T(s, String(i + 1).padStart(2, '0'), { x: x + 0.25, y: 2.15, w: 0.6, h: 0.3, fontSize: 11, bold: true, color: HEX.muted })
      await iconTile(s, ic, x + bw - 0.77, 2.1, 0.5)
      T(s, h, { x: x + 0.25, y: 2.75, w: bw - 0.5, h: 0.4, fontSize: 16, bold: true })
      T(s, p, { x: x + 0.25, y: 3.2, w: bw - 0.5, h: 1.35, fontSize: 13, color: HEX.ink2 })
      if (i < 3) arrow(s, x + bw + 0.04, 3.32, x + bw + gap - 0.04, 3.32, HEX.accent)
    }
    card(s, 0.6, 5.0, 3.85, 1.6, { fill: HEX.alt, line: HEX.alt, name: 'providers' })
    await iconTile(s, 'LuSparkles', 0.85, 5.2, 0.45)
    T(s, 'Будь-яка модель', { x: 1.45, y: 5.22, w: 2.9, h: 0.3, fontSize: 14, bold: true })
    T(s, 'OpenAI · Gemini · Claude\nОсновна: [оновити після спайку WS4]', { x: 1.45, y: 5.55, w: 2.95, h: 0.9, fontSize: 12, color: HEX.ink2 })
    card(s, 4.74, 5.0, 3.85, 1.6, { fill: HEX.alt, line: HEX.alt, name: 'fallback' })
    await iconTile(s, 'LuActivity', 4.99, 5.2, 0.45)
    T(s, 'Збій моделі — не катастрофа', { x: 5.59, y: 5.22, w: 2.95, h: 0.3, fontSize: 14, bold: true })
    T(s, 'Детермінований fallback, позначений в інтерфейсі та журналі', { x: 5.59, y: 5.55, w: 2.9, h: 0.9, fontSize: 12, color: HEX.ink2 })
    soft(s, 8.88, 5.0, 3.85, 1.6, HEX.accent, 'nowrite')
    await iconTile(s, 'LuLock', 9.13, 5.2, 0.45)
    T(s, 'LLM не пише в базу', { x: 9.73, y: 5.22, w: 2.9, h: 0.3, fontSize: 14, bold: true, color: HEX.accent })
    T(s, 'Модель лише пропонує дію. Виконує backend — після перевірок', { x: 9.73, y: 5.55, w: 2.9, h: 0.9, fontSize: 12, color: HEX.ink })
    s.addNotes('AI reasoning (1:30–2:10). Контекст будує сервер: хто клієнт — визначає сесія, тому номер чужого платежу в повідомленні нічого не дає. Модель сама викликає інструмент і повертає рішення за строгою схемою. Далі — детермінований policy engine. Модель нічого не записує в базу. Працює з різними LLM; якщо модель впала — є fallback. [Назвати обрану модель після спайку WS4.] ▶ «Реальна дія».')
  }

  // 5 — Real action + human-in-the-loop
  {
    const s = content('How it works', 'РЕАЛЬНА ДІЯ + HUMAN-IN-THE-LOOP', 'Гроші рухаються лише після «так» від людини')
    const nodes = [
      ['Пропозиція', 'refund_payment\n499.00 UAH'],
      ['Перевірки', 'належність · дубль\nліміт · статус'],
      ['Approve', 'прив’язаний до\nконкретної операції'],
      ['Виконання', 'атомарно, одне\nповернення на платіж'],
      ['Результат', 'кейс вирішено,\nаудит, відповідь'],
    ]
    const step = 2.42
    s.addShape(pres.shapes.LINE, { x: 1.1, y: 2.35, w: step * 4, h: 0, line: { color: HEX.line, width: 2 } })
    for (const [i, [h, p]] of nodes.entries()) {
      const cx = 1.1 + i * step
      const human = i === 2
      s.addShape(pres.shapes.OVAL, { x: cx - 0.3, y: 2.05, w: 0.6, h: 0.6, fill: { color: human ? HEX.accent : 'FFFFFF' }, line: { color: human ? HEX.accent : HEX.line, width: 1.5 }, objectName: `node-${i}` })
      s.addImage({ data: await icon(['LuSparkles', 'LuShieldCheck', 'LuUserCheck', 'LuZap', 'LuCircleCheck'][i], human ? 'FFFFFF' : (i === 4 ? HEX.ok : HEX.accent)), x: cx - 0.15, y: 2.2, w: 0.3, h: 0.3 })
      T(s, h, { x: cx - 1.1, y: 2.85, w: 2.2, h: 0.35, fontSize: 16, bold: true, align: 'center', color: human ? HEX.accent : HEX.ink })
      T(s, p, { x: cx - 1.1, y: 3.22, w: 2.2, h: 0.7, fontSize: 12.5, align: 'center', color: HEX.ink2 })
    }
    const g = [
      ['LuKeyRound', 'Точне схвалення', 'Змінилися аргументи — старе схвалення недійсне'],
      ['LuRepeat', 'Без дублів', 'Повторне натискання → 409, друге повернення неможливе'],
      ['LuFlag', 'Чесні результати', 'Провайдер не підтвердив — клієнт так і дізнається'],
      ['LuCreditCard', 'Демо-платежі', 'Симульований провайдер — реальні кошти не рухаються'],
    ]
    for (const [i, [ic, h, p]] of g.entries()) {
      const x = 0.6 + i * 3.08
      card(s, x, 4.3, 2.88, 2.25, { name: `guarantee-${i}` })
      await iconTile(s, ic, x + 0.25, 4.55, 0.48)
      T(s, h, { x: x + 0.25, y: 5.18, w: 2.4, h: 0.35, fontSize: 14.5, bold: true })
      T(s, p, { x: x + 0.25, y: 5.55, w: 2.45, h: 0.9, fontSize: 12.5, color: HEX.ink2 })
    }
    s.addNotes('Реальна дія (2:10–2:45). AI пропонує повернення 499 гривень. Правила перевіряють. Оператор натискає Approve — і схвалення прив’язане саме до цієї операції. Backend виконує атомарно: друге натискання не створить другого повернення. Платіжний провайдер у демо — симульований, говоримо це прямо. ▶ «Sentiment».')
  }

  // 6 — Sentiment & escalation
  {
    const s = content('How it works', 'SENTIMENT & ESCALATION', 'Настрій змінює пріоритет — але не дозволяє гроші')
    const cases = [
      { who: 'Олена · Premium', quote: '«Ви списали з мене двічі за жовтень!!! Негайно поверніть»', tags: [['frustrated', HEX.warn], ['urgency: high', HEX.warn], ['P1', HEX.accent], ['тон: емпатичний', HEX.info]], ok: true, outcome: 'Дубль ✓ · ліміт ✓ → повернення 499 UAH чекає оператора' },
      { who: 'Іван · Annual', quote: '«Ви, ідіоти, двічі списали за річний план!!!»', tags: [['abusive', HEX.accent], ['P1', HEX.accent], ['тон: деескалація', HEX.info]], ok: false, outcome: '3 999 UAH > ліміт 2 000 → відмова → ескалація людині' },
    ]
    for (const [i, c] of cases.entries()) {
      const x = 0.6 + i * 6.15
      card(s, x, 1.95, 5.95, 3.75, { name: `case-${i}` })
      T(s, c.who, { x: x + 0.35, y: 2.2, w: 5, h: 0.3, fontSize: 12, bold: true, color: HEX.muted })
      card(s, x + 0.35, 2.6, 5.25, 0.85, { fill: HEX.alt, line: HEX.alt, name: `quote-${i}` })
      T(s, c.quote, { x: x + 0.55, y: 2.6, w: 4.9, h: 0.85, fontSize: 14, italic: true, valign: 'middle' })
      let tx = x + 0.35
      for (const [t, col] of c.tags) tx += tag(s, t, tx, 3.65, col) + 0.1
      soft(s, x + 0.35, 4.2, 5.25, 1.15, c.ok ? HEX.ok : HEX.accent, `outcome-${i}`)
      s.addImage({ data: await icon(c.ok ? 'LuUserCheck' : 'LuTriangleAlert', c.ok ? HEX.ok : HEX.accent), x: x + 0.6, y: 4.55, w: 0.42, h: 0.42 })
      T(s, c.outcome, { x: x + 1.2, y: 4.2, w: 4.3, h: 1.15, fontSize: 14, bold: true, valign: 'middle', color: c.ok ? '166534' : 'B01A2E' })
    }
    await iconTile(s, 'LuActivity', 0.6, 6.0, 0.45)
    T(s, 'Оператор бачить, чому: груба лексика, капслок, «!!!», маркери терміновості. Роздратований клієнт ≠ зловмисник.', { x: 1.25, y: 6.0, w: 11.4, h: 0.45, fontSize: 13.5, color: HEX.ink2, valign: 'middle' })
    s.addNotes('Sentiment (2:45–3:15). Два клієнти з однаковою проблемою. Олена роздратована — кейс отримує P1 і емпатичний тон, повернення чекає оператора. Іван грубить, і сума понад ліміт — policy відмовляє, кейс одразу йде до людини з тоном деескалації. Настрій впливає на пріоритет і тон, але ніколи не авторизує гроші. ▶ «Демо».')
  }

  // 7 — Demo video slot
  pres.addSection({ title: 'Demo' })
  {
    const s = content('Demo', 'LIVE DEMO', 'Від звернення до вирішення — 44 секунди')
    const w = 8.4, h = w * 9 / 16, x = (W - w) / 2, y = 1.85
    card(s, x, y, w, h, { fill: HEX.alt, shadow: true, name: 'video-frame' })
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h: 0.42, rectRadius: 0.12, fill: { color: 'FFFFFF' }, line: { color: HEX.line, width: 1 }, objectName: 'video-bar' })
    s.addShape(pres.shapes.RECTANGLE, { x: x + 0.02, y: y + 0.25, w: w - 0.04, h: 0.17, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF', width: 0 } })
    for (const [i, col] of ['FF5F57', 'FEBC2E', '28C840'].entries()) s.addShape(pres.shapes.OVAL, { x: x + 0.22 + i * 0.22, y: y + 0.15, w: 0.12, h: 0.12, fill: { color: col }, line: { color: col, width: 0 } })
    T(s, 'eldhall-pitch-uk.mp4', { x: x + 2, y: y + 0.06, w: w - 4, h: 0.3, fontSize: 11, color: HEX.muted, align: 'center', valign: 'middle' })
    s.addShape(pres.shapes.OVAL, { x: x + w / 2 - 0.45, y: y + h / 2 - 0.55, w: 0.9, h: 0.9, fill: { color: HEX.accent }, line: { color: HEX.accent, width: 0 }, objectName: 'play' })
    s.addImage({ data: await icon('LuPlay', 'FFFFFF'), x: x + w / 2 - 0.2, y: y + h / 2 - 0.3, w: 0.42, h: 0.42 })
    T(s, '[ВСТАВИТИ ВІДЕО] Демо 0:44 · 1920×1080 · docs/DEMO_VIDEO.md', { x: x + 0.5, y: y + h / 2 + 0.5, w: w - 1, h: 0.35, fontSize: 13, bold: true, color: HEX.ink2, align: 'center' })
    T(s, 'Вставка › Відео › Цей пристрій — і розтягнути на цю рамку', { x: x + 0.5, y: y + h / 2 + 0.85, w: w - 1, h: 0.3, fontSize: 11, color: HEX.muted, align: 'center' })
    s.addNotes('Демо (3:15–4:05). Запустити відео (44 с) і коротко коментувати: клієнт пише → AI знаходить обидва платежі → оператор бачить аналіз і перевірки → Approve → клієнт отримує підтвердження з референсом. Провайдер симульований. ЯКЩО ВІДЕО НЕ ЗАПУСТИЛОСЯ: див. резервний сценарій у SPEAKER_SCRIPT.md — повернутися на слайд 3 і пройти ілюстрацію консолі словами. ▶ «Архітектура».')
  }

  // 8 — Architecture
  pres.addSection({ title: 'Technology' })
  {
    const s = content('Technology', 'АРХІТЕКТУРА', 'Простий стек, сувора межа між AI і діями')
    // Clients
    const clients = [['LuSmartphone', 'Чат клієнта', 'адаптивний, mobile'], ['LuMonitor', 'Консоль оператора', 'desktop']]
    for (const [i, [ic, h, p]] of clients.entries()) {
      const y = 2.1 + i * 1.65
      card(s, 0.6, y, 2.9, 1.35, { name: `client-${i}` })
      await iconTile(s, ic, 0.85, y + 0.25, 0.45)
      T(s, h, { x: 0.85, y: y + 0.78, w: 2.5, h: 0.3, fontSize: 14, bold: true })
      T(s, p, { x: 0.85, y: y + 1.03, w: 2.5, h: 0.25, fontSize: 11, color: HEX.muted })
    }
    T(s, 'React + TypeScript', { x: 0.6, y: 5.45, w: 2.9, h: 0.3, fontSize: 11, color: HEX.muted, align: 'center' })
    arrow(s, 3.6, 2.78, 4.15, 3.5, HEX.accent)
    arrow(s, 3.6, 4.43, 4.15, 3.75, HEX.accent)
    // Core
    soft(s, 4.25, 1.95, 4.85, 3.85, HEX.accent, 'core')
    T(s, 'Fastify API · Agent Harness', { x: 4.5, y: 2.15, w: 4.4, h: 0.4, fontSize: 16, bold: true })
    const chips = ['Контекст', 'Реєстр tools', 'Policy engine', 'Approvals', 'Виконання', 'Аудит']
    for (const [i, c] of chips.entries()) {
      const cx = 4.5 + (i % 2) * 2.2, cy = 2.75 + Math.floor(i / 2) * 0.88
      card(s, cx, cy, 2.05, 0.68, { name: `chip-${i}` })
      T(s, c, { x: cx, y: cy, w: 2.05, h: 0.68, fontSize: 13, bold: true, align: 'center', valign: 'middle' })
    }
    // Right side
    const right = [['LuCpu', 'LLM', 'OpenAI · Gemini · Claude'], ['LuDatabase', 'PostgreSQL', '[MVP: in-memory → Postgres — оновити]'], ['LuCreditCard', 'Платежі', 'симульований провайдер']]
    for (const [i, [ic, h, p]] of right.entries()) {
      const y = 1.95 + i * 1.33
      arrow(s, 9.2, 3.87, 9.7, y + 0.55, HEX.muted)
      card(s, 9.8, y, 2.9, 1.1, { name: `dep-${i}` })
      await iconTile(s, ic, 10.0, y + 0.3, 0.45)
      T(s, h, { x: 10.6, y: y + 0.2, w: 2.0, h: 0.3, fontSize: 14, bold: true })
      T(s, p, { x: 10.6, y: y + 0.5, w: 2.05, h: 0.5, fontSize: 10.5, color: HEX.muted })
    }
    // Bottom facts
    const facts = [['LuServer', 'Docker Compose · Oracle Cloud ARM64 [статус деплою: оновити]'], ['LuGitBranch', 'CI на кожен PR · 10 критичних сценаріїв у тестах'], ['LuBookOpen', 'Open source · MVP та roadmap розділені чесно']]
    for (const [i, [ic, t]] of facts.entries()) {
      const x = 0.6 + i * 4.1
      s.addImage({ data: await icon(ic, HEX.ink2), x, y: 6.15, w: 0.3, h: 0.3 })
      T(s, t, { x: x + 0.42, y: 6.08, w: 3.55, h: 0.5, fontSize: 12, color: HEX.ink2, valign: 'middle' })
    }
    s.addNotes('Архітектура (4:05–4:30). Два інтерфейси на React — чат клієнта і консоль оператора. Усе рішення — в одному API на Fastify: контекст, реєстр інструментів, policy, approvals, виконання, аудит. Модель — замінна. Провайдер платежів — симульований. Розгортання — Docker Compose на Oracle Cloud. [Оновити: Postgres і статус деплою.] ▶ «Результати».')
  }

  // 9 — Results, roadmap, close
  pres.addSection({ title: 'Close' })
  {
    const s = content('Close', 'РЕЗУЛЬТАТИ ТА ПОТЕНЦІАЛ', 'Що вже працює — і куди рухаємось', true)
    const stats = [
      ['10/10', 'критичних сценаріїв покрито бізнес-тестами', false],
      ['34/34', 'автотести API · станом на 31.10 [оновити перед виступом]', false],
      ['[__ %]', 'точність intent на eval-наборі [WS4]', true],
      ['[__]', 'небезпечних дій на eval-наборі [WS4]', true],
    ]
    for (const [i, [n, l, ph]] of stats.entries()) {
      const x = 0.6 + (i % 2) * 3.25, y = 1.95 + Math.floor(i / 2) * 1.95
      card(s, x, y, 3.05, 1.75, { fill: HEX.dark2, line: ph ? HEX.accent : HEX.darkLine, name: `stat-${i}` })
      T(s, n, { x: x + 0.3, y: y + 0.22, w: 2.6, h: 0.7, fontSize: 36, bold: true, color: ph ? 'F87171' : 'FFFFFF', charSpacing: -1 })
      T(s, l, { x: x + 0.3, y: y + 0.98, w: 2.55, h: 0.65, fontSize: 11.5, color: HEX.darkMuted })
    }
    T(s, 'Далі', { x: 7.4, y: 1.95, w: 5, h: 0.4, fontSize: 18, bold: true, color: 'FFFFFF' })
    const road = [['LuWallet', 'Реальні платіжні провайдери'], ['LuUsers', 'SSO та ролі операторів'], ['LuMail', 'Канали: email, месенджери'], ['LuBookOpen', 'База знань (RAG) для відповідей'], ['LuChartBar', 'Продуктова аналітика (PostHog)']]
    for (const [i, [ic, t]] of road.entries()) {
      const y = 2.5 + i * 0.6
      s.addImage({ data: await icon(ic, 'F87171'), x: 7.4, y: y + 0.06, w: 0.3, h: 0.3 })
      T(s, t, { x: 7.85, y, w: 4.8, h: 0.42, fontSize: 15, color: 'FFFFFF', valign: 'middle' })
    }
    T(s, [
      { text: 'AI пропонує. Правила перевіряють. ', options: { color: 'FFFFFF' } },
      { text: 'Людина вирішує.', options: { color: 'F87171' } },
    ], { x: 0.6, y: 6.05, w: 9, h: 0.5, fontSize: 20, bold: true, valign: 'middle' })
    T(s, 'Дякуємо! Питання?', { x: 9.4, y: 6.05, w: 3.3, h: 0.5, fontSize: 16, bold: true, color: HEX.darkMuted, align: 'right', valign: 'middle' })
    s.addNotes('Результати і завершення (4:30–5:00). Лише виміряне: 10 критичних сценаріїв покрито тестами, автотести зелені. [Вставити цифри eval від WS4 — без них прибрати плитки, а не вигадувати.] Далі — реальні провайдери, ролі, нові канали, база знань, аналітика. Фінальна фраза: AI пропонує, правила перевіряють, людина вирішує. Дякуємо!')
  }

  await pres.writeFile({ fileName: OUT })
  await applyTheme(OUT, THEME)
  console.log('wrote', OUT)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
