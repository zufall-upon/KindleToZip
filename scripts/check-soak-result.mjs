import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PNG } from 'pngjs';
import { inspectSoakResult } from './soak-result.mjs';

const index = JSON.parse(await readFile('artifacts/soak-current.json', 'utf8'));
if (!/^artifacts\/soak-runs\/[0-9a-f-]{36}\/receipt\.json$/.test(index.receipt)) throw new Error('invalid_receipt_reference');
const result = JSON.parse(await readFile(index.receipt, 'utf8'));
const summary = inspectSoakResult(result);
if (!/^artifacts\/poc-runs\/sample-[A-Za-z0-9]+$/.test(result.imageRoot)) throw new Error('invalid_image_reference');
const rootStat = await lstat(result.imageRoot);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid_image_directory');
for (const image of result.captures) {
  const file = path.join(result.imageRoot, image.file);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== image.bytes) throw new Error('image_changed');
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('image_changed');
  const png = PNG.sync.read(bytes, { checkCRC: true });
  if (png.width !== 600 || png.height !== 480) throw new Error('image_dimensions_changed');
}
console.log(JSON.stringify(summary));
