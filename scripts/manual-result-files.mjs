import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

export async function manualResultFiles() {
  const root = 'artifacts/poc-runs';
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^sample-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const file = path.join(root, entry.name, 'manual-receipt.json');
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('manual_receipt_not_regular');
      files.push(file.replaceAll('\\', '/'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files.sort();
}
