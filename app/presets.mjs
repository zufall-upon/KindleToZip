import { lstat, readFile, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from './store-client.mjs';
import { kindleChromeConfig } from './stores/kindle.mjs';

// Definitions contain selectors, not scripts, URLs, authentication or book data.
export const initialPresets = () => ({ version: 1, selected: 'kindle-visible', presets: [
  { id: 'kindle-reader-chrome', name: 'Kindle — タイトル・位置バー付き読書画面', mode: 'selectors', config: { ...kindleChromeConfig } },
  { id: 'kindle-visible', name: '汎用 Kindle — 表示中の読書画面（自動検査）', mode: 'visible', config: null },
] });
export function validatePresets(value) {
  if (value?.version !== 1 || !Array.isArray(value.presets) || !value.presets.length || value.presets.length > 100
    || !value.presets.some(p => p.id === value.selected)) throw new AppError('invalid_presets');
  const ids = new Set();
  for (const p of value.presets) {
    if (!/^[a-z0-9-]{1,80}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100
      || !['visible', 'selectors'].includes(p.mode)) throw new AppError('invalid_presets');
    ids.add(p.id);
    if (p.mode === 'selectors') {
      if (!p.config || ['frame', 'reader', 'identity', 'position', 'next'].some(k => typeof p.config[k] !== 'string'
        || p.config[k].length > 400 || k !== 'frame' && !p.config[k].trim())) throw new AppError('invalid_presets');
      if (p.config.frames && Object.entries(p.config.frames).some(([k, v]) => !['reader', 'identity', 'position', 'next'].includes(k) || typeof v !== 'string' || v.length > 400)) throw new AppError('invalid_presets');
    }
  }
  return value;
}
async function check(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512_000
      || path.resolve(await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new AppError('unsafe_presets');
    return true;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function readPresets(directory) {
  const file = path.join(directory, 'reader-presets.json');
  if (!await check(file)) return initialPresets();
  try { return validatePresets(JSON.parse(await readFile(file, 'utf8'))); }
  catch { throw new AppError('invalid_presets'); }
}
export async function savePresets(directory, value) {
  validatePresets(value);
  const file = path.join(directory, 'reader-presets.json');
  await check(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 512_000) throw new AppError('invalid_presets');
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return value;
}
