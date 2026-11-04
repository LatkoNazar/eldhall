import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkBytes, checkProbe, safePath, verify, verifyArchives, root } from './verify.mjs'
const bytes = Buffer.from('wOF2synthetic test font')
const asset = { kind: 'font', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${asset.sha256}\nsize ${asset.size}\n`)
test('source mode accepts exact pointers, full mode requires bytes', () => {
  assert.equal(checkBytes(pointer, asset, true), 'pointer')
  assert.throws(() => checkBytes(pointer, asset, false), /Materialize/)
  assert.throws(() => checkBytes(pointer, { ...asset, size: 1 }, true), /receipt/)
})
test('materialized assets must match size, hash and font signature', () => {
  assert.equal(checkBytes(bytes, asset, false), 'materialized')
  assert.throws(() => checkBytes(Buffer.from('corrupt'), asset, true), /receipt/)
  const bad = Buffer.from('not a font')
  assert.throws(() => checkBytes(bad, { ...asset, size: bad.length, sha256: crypto.createHash('sha256').update(bad).digest('hex') }, false), /WOFF2/)
})
test('paths cannot escape the package', () => {
  for (const p of ['../x', '/x', 'C:/x', 'assets/../x', 'assets\\x', 'https://x', './x']) assert.throws(() => safePath(root, p), /Unsafe/)
})
test('media metadata enforces duration, dimensions and 30fps export', () => {
  const info = { format: { duration: '44' }, streams: [{ codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30/1', avg_frame_rate: '30/1' }] }
  checkProbe(info, 1920, 1080, 44, 30)
  assert.throws(() => checkProbe(info, 1600, 900, 44), /dimensions/)
  assert.throws(() => checkProbe(info, 1920, 1080, 45), /shorter/)
  assert.throws(() => checkProbe(info, 1920, 1080, 44, 60), /frame rate/)
})
test('archival preservation checks each original and rejects altered bytes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eldhall-pitch-archives-'))
  try {
    const receipt = JSON.parse(await fs.readFile(path.resolve(root, '../../../deliverables/pitch/archive-files.json')))
    for (const file of receipt.files) {
      await fs.writeFile(path.join(temp, file.path), bytes)
      file.size = asset.size
      file.sha256 = asset.sha256
    }
    await fs.writeFile(path.join(temp, 'archive-files.json'), JSON.stringify(receipt))
    assert.equal(await verifyArchives(temp), 5)
    await fs.writeFile(path.join(temp, receipt.files[0].path), 'changed')
    await assert.rejects(verifyArchives(temp), /Preserved archival file changed/)
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
test('real source checkout validates with LFS pointers and rejects missing assets, stale timing and malformed JSON', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eldhall-pitch-'))
  try {
    await fs.cp(root, temp, { recursive: true, filter: p => !p.split(path.sep).some(x => ['node_modules', '.cache', '.hyperframes'].includes(x)) })
    const manifest = JSON.parse(await fs.readFile(path.join(temp, 'archive-assets.json')))
    for (const a of manifest.assets) await fs.writeFile(path.join(temp, a.path), `version https://git-lfs.github.com/spec/v1\noid sha256:${a.sha256}\nsize ${a.size}\n`)
    assert.equal((await verify(temp, { sourceOnly: true })).pointers, 16)
    await assert.rejects(verify(temp), /Materialize/)
    const last = path.join(temp, manifest.assets.at(-1).path)
    const saved = await fs.readFile(last)
    await fs.unlink(last)
    await assert.rejects(verify(temp, { sourceOnly: true }), /ENOENT/)
    await fs.writeFile(last, saved)
    const timing = JSON.parse(await fs.readFile(path.join(temp, 'scene-timing.json')))
    await fs.writeFile(path.join(temp, 'scene-timing.json'), JSON.stringify({ ...timing, duration: 1 }))
    await assert.rejects(verify(temp, { sourceOnly: true }), /Stale/)
    await fs.writeFile(path.join(temp, 'scenes/pitch.json'), '{')
    await assert.rejects(verify(temp, { sourceOnly: true }), SyntaxError)
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
