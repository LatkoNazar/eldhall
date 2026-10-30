import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'assets', 'manifest.json'), 'utf8'));
for (const item of manifest.files) {
  const bytes = await fs.readFile(path.join(root, item.path));
  if (bytes.subarray(0, 100).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error(`${item.path} is an LFS pointer. Run git lfs pull from the repository, then retry.`);
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== item.sha256 || bytes.length !== item.bytes) throw new Error(`Asset integrity mismatch: ${item.path}`);
}
console.log(`Verified ${manifest.files.length} bundled assets, including the unchanged approved MP4/SRT.`);
