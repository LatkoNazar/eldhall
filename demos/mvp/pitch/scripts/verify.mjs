// Source mode accepts exact LFS pointers; full mode requires the actual archived bytes.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const requireThat = (condition, message) => { if (!condition) throw new Error(message) }
export function safePath(base, relative) {
  requireThat(typeof relative === 'string' && /^[a-zA-Z0-9_./-]+$/.test(relative) && !relative.split('/').some(x => !x || x === '.' || x === '..') && !path.isAbsolute(relative), 'Unsafe asset path')
  return path.join(base, relative)
}
export function checkBytes(bytes, asset, sourceOnly) {
  const text = bytes.toString('utf8')
  if (text.startsWith('version https://git-lfs.github.com/spec/v1')) {
    requireThat(text === `version https://git-lfs.github.com/spec/v1\noid sha256:${asset.sha256}\nsize ${asset.size}\n`, 'LFS pointer does not match archival receipt')
    requireThat(sourceOnly, 'Materialize pitch assets with git lfs before full verification')
    return 'pointer'
  }
  requireThat(bytes.length === asset.size && hash(bytes) === asset.sha256, 'Asset bytes do not match archival receipt')
  if (asset.kind === 'font') requireThat(bytes.subarray(0, 4).toString('ascii') === 'wOF2', 'Invalid WOFF2 signature')
  return 'materialized'
}
export function checkProbe(info, width, height, minimumDuration, fps) {
  const video = info.streams?.find(stream => stream.codec_type === 'video')
  requireThat(video?.width === width && video?.height === height, 'Wrong media dimensions')
  requireThat(Number.isFinite(Number(info.format?.duration)) && Number(info.format.duration) + 0.01 >= minimumDuration, 'Media is shorter than storyboard')
  if (fps) requireThat(video.r_frame_rate === `${fps}/1` && video.avg_frame_rate === `${fps}/1`, 'Wrong final export frame rate')
}
export async function verifyArchives(base = path.resolve(root, '../../../deliverables/pitch')) {
  const receipt = JSON.parse(await fs.readFile(path.join(base, 'archive-files.json'), 'utf8'))
  const expected = ['Eldhall-Pitch-ARCHIVE-2026-10-31.pdf', 'Eldhall-Pitch-ARCHIVE-2026-10-31.pptx', 'Eldhall-Pitch-v2-ARCHIVE-2026-10-31.pptx', 'PITCH_TEXT-ARCHIVE-2026-10-31.md', 'SPEAKER_SCRIPT-ARCHIVE-2026-10-31.md']
  requireThat(receipt.format === 1 && receipt.snapshotDate === '2026-10-31' && JSON.stringify(receipt.files.map(x => x.path).sort()) === JSON.stringify(expected.sort()), 'Unexpected archival file set')
  for (const file of receipt.files) {
    const bytes = await fs.readFile(safePath(base, file.path))
    requireThat(bytes.length === file.size && hash(bytes) === file.sha256, 'Preserved archival file changed')
  }
  return receipt.files.length
}
export async function verify(base = root, { sourceOnly = false } = {}) {
  const json = async relative => JSON.parse(await fs.readFile(safePath(base, relative), 'utf8'))
  const def = await json('scenes/pitch.json')
  requireThat(def.id === 'eldhall-pitch' && def.fps === 30 && def.width === 1920 && def.height === 1080 && def.locale === 'uk', 'Unexpected pitch output contract')
  requireThat(def.capture.width === 1600 && def.capture.height === 900 && Array.isArray(def.scenes), 'Invalid capture contract')
  const captions = await json('locales/uk.json')
  const geometry = await json('scenes/geometry.json')
  const timing = await json('scene-timing.json')
  const ledger = await json('assets/ledger.json')
  const evidence = await json('capture/evidence.json')
  const receipt = await json('archive-assets.json')
  requireThat(receipt.format === 1 && receipt.snapshotDate === '2026-10-31' && Array.isArray(receipt.assets), 'Invalid archival receipt')
  requireThat(evidence.ok === true && evidence.at.startsWith('2026-10-31T') && evidence.model.every(x => x.provider === 'rules' && x.status === 'ok'), 'Archived capture evidence differs')
  requireThat(captions.disclaimer.includes('без LLM') && captions.disclaimer.includes('симульований'), 'Missing honest demo disclaimer')
  const ids = new Set(), slots = new Set()
  let duration = 0
  for (const scene of def.scenes) {
    requireThat(typeof scene.id === 'string' && !ids.has(scene.id) && ['title', 'capture'].includes(scene.type), 'Duplicate or invalid scene')
    ids.add(scene.id)
    const effective = { ...scene, ...geometry[scene.id] }
    requireThat(Number.isFinite(effective.duration) && effective.duration > 0, 'Invalid scene duration')
    duration += effective.duration
    if (scene.type === 'capture') {
      safePath(base, scene.slot)
      requireThat(!slots.has(scene.slot) && typeof captions[scene.id] === 'string' && captions[scene.id].length > 0, 'Missing caption or duplicate slot')
      slots.add(scene.slot)
      const entry = ledger.footage.find(x => x.id === scene.id)
      requireThat(entry?.slot === scene.slot && entry.playbackRate === 1 && entry.mediaStart === (effective.mediaStart ?? 0), 'Capture ledger differs from storyboard')
      requireThat(receipt.assets.some(x => x.path === scene.slot && x.kind === 'capture' && x.sha256 === entry.sha256), 'Unbound capture receipt')
    }
  }
  requireThat(slots.size === 7 && ledger.built === 'final' && ledger.placeholders.length === 0 && ledger.footage.length === 7, 'Incomplete final ledger')
  requireThat(timing.fps === 30 && Math.abs(timing.duration - duration) < 0.001 && timing.draft === false, 'Stale generated timing')
  const css = await fs.readFile(safePath(base, 'styles.css'), 'utf8')
  const fontPaths = [...css.matchAll(/url\((assets\/fonts\/[^)]+)\)/g)].map(x => x[1])
  requireThat(fontPaths.length === 8 && new Set(fontPaths).size === 8 && fontPaths.every(p => receipt.assets.some(x => x.path === p && x.kind === 'font')), 'Font receipt coverage differs')
  const pkg = await json('package.json')
  requireThat(pkg.scripts.render.includes('--fps 30 ') && pkg.scripts.render.endsWith('--output exports/eldhall-pitch-uk.mp4'), 'Render command differs from output contract')
  for (const required of ['main.js', 'index.html', 'assets/vendor/gsap.min.js', 'exports/eldhall-pitch-uk.srt']) await fs.access(safePath(base, required))
  requireThat(receipt.assets.length === 16 && new Set(receipt.assets.map(x => x.path)).size === 16, 'Incomplete asset receipt')
  let pointers = 0
  for (const asset of receipt.assets) {
    requireThat(['font', 'capture', 'export'].includes(asset.kind) && /^[a-f0-9]{64}$/.test(asset.sha256) && Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid asset receipt entry')
    const file = safePath(base, asset.path)
    const state = checkBytes(await fs.readFile(file), asset, sourceOnly)
    if (state === 'pointer') pointers++
    if (!sourceOnly && asset.kind !== 'font') {
      const info = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate', '-of', 'json', file], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }))
      if (asset.kind === 'capture') {
        const scene = def.scenes.find(x => x.slot === asset.path)
        const effective = { ...scene, ...geometry[scene.id] }
        checkProbe(info, 1600, 900, effective.duration + 0.4 + (effective.mediaStart ?? 0))
      } else checkProbe(info, 1920, 1080, duration, 30)
    }
  }
  return { mode: sourceOnly ? 'source-only' : 'full-media', assets: receipt.assets.length, pointers, duration }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireThat(process.argv.slice(2).every(x => x === '--source-only') && process.argv.length <= 3, 'Usage: node scripts/verify.mjs [--source-only]')
    const result = await verify(root, { sourceOnly: process.argv.includes('--source-only') })
    console.log(JSON.stringify({ ...result, archivalFiles: await verifyArchives() }))
  } catch (error) { console.error(`Pitch verification failed: ${error.message}`); process.exitCode = 1 }
}
