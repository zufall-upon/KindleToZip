// Task-local, anonymous-candidate maintenance, not a general profile updater.
// Caller must have joined its launch. Unknown/in-use owners are never repaired.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFiles, hashFile, safeRelative, verifyBundle } from '../../scripts/linux-distribution.mjs';

const target = '/home/user/KTZ-Portable';
const source = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function anonymousDataSnapshot() {
  const result = [];
  async function walk(directory, relative) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('unsafe_anonymous_update_data');
    if (path.basename(directory) === 'in-use.lock') throw new Error('anonymous_owner_in_use_or_unknown');
    if (info.isDirectory()) {
      for (const name of (await readdir(directory)).sort()) await walk(path.join(directory, name), `${relative}/${name}`);
    } else if (info.isFile() && info.nlink === 1) result.push({ path: relative, bytes: info.size, sha256: await hashFile(directory) });
    else throw new Error('unsafe_anonymous_update_data');
  }
  const data = path.join(target, 'data');
  for (const name of await readdir(data)) {
    // This candidate never receives login/profile data. The only permissible
    // persistent data is minted by our fixed anonymous smoke or empty GUI.
    if (!/^(gui-smoke-[a-zA-Z0-9]{6}|owned-sample|application|anonymous-profile-check)$/.test(name)) throw new Error('not_anonymous_update_candidate');
    if (name === 'application') {
      const entries = await readdir(path.join(data, name));
      if (entries.some(entry => /^(saved|temporary)-/.test(entry) || entry === 'jobs')) throw new Error('existing_user_data_refused');
    }
    await walk(path.join(data, name), name);
  }
  return result;
}

export async function refreshAnonymousPortable() {
  if (await realpath(target) !== target) throw new Error('unsafe_update_target');
  const receipt = await verifyBundle(target);
  // An exclusive maintenance lock is deliberately retained on interruption.
  const lock = await open(path.join(target, 'anonymous-maintenance.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await lock.close();
  const before = await anonymousDataSnapshot();
  const previousReceipt = await hashFile(path.join(target, 'receipt.json'));
  const backup = path.join(target, 'payload-history', randomUUID()); await mkdir(backup, { recursive: true, mode: 0o700 });
  const changed = [];
  const publish = async (relative, bytes, mode) => {
    const file = path.join(target, safeRelative(relative));
    let old;
    try { old = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old) {
      const archived = path.join(backup, relative); await mkdir(path.dirname(archived), { recursive: true, mode: 0o700 });
      await writeFile(archived, old, { flag: 'wx', mode: 0o600 });
    }
    const staged = `${file}.update-${randomUUID()}`;
    await writeFile(staged, bytes, { flag: 'wx', mode }); await rename(staged, file);
  };
  // Only the product's fixed app allowlist may introduce a new code file.
  for (const relative of appFiles) if (!receipt.files.some(item => item.path === relative)) {
    try { await lstat(path.join(target, relative)); throw new Error('unexpected_unlisted_app_file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    receipt.files.push({ path: relative, size: 0, mode: 0o644, sha256: null });
  }
  receipt.files.sort((a, b) => a.path.localeCompare(b.path));
  for (const item of receipt.files) {
    if (!/^(app\/|scripts\/|docs\/)/.test(item.path)) continue;
    const bytes = await readFile(path.join(source, safeRelative(item.path)));
    if (hash(bytes) === item.sha256) continue;
    await publish(item.path, bytes, item.mode);
    item.size = bytes.length; item.sha256 = hash(bytes); changed.push(item.path);
  }
  receipt.appSourceSha256 = hash(JSON.stringify(receipt.files.filter(item => item.path.startsWith('app/'))));
  receipt.updatedAtUtc = new Date().toISOString(); receipt.previousReceiptSha256 = previousReceipt;
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await publish('receipt.json', receiptBytes, 0o644);
  let launcher = await readFile(path.join(source, 'scripts/start-linux-bundle.sh'), 'utf8');
  for (const [key, value] of Object.entries({ NODE_SHA256: receipt.files.find(item => item.path === 'runtime/node').sha256,
    LAUNCH_SHA256: receipt.files.find(item => item.path === 'scripts/linux-bundle-launch.mjs').sha256,
    VERIFY_SHA256: receipt.files.find(item => item.path === 'scripts/linux-distribution.mjs').sha256, RECEIPT_SHA256: hash(receiptBytes) })) launcher = launcher.replace(`@${key}@`, value);
  await publish('start-linux-bundle.sh', Buffer.from(launcher), 0o755);
  await publish('SHA256SUMS.txt', Buffer.from(`${hash(receiptBytes)}  receipt.json\n${hash(Buffer.from(launcher))}  start-linux-bundle.sh\n`), 0o644);
  await verifyBundle(target);
  const after = await anonymousDataSnapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('anonymous_update_data_changed');
  const { unlink } = await import('node:fs/promises'); await unlink(path.join(target, 'anonymous-maintenance.lock'));
  return { changed, beforeReceipt: previousReceipt, afterReceipt: hash(receiptBytes), dataFilesPreserved: before.length,
    dataSnapshotSha256: hash(JSON.stringify(after)), backup: path.relative(target, backup), appSourceSha256: receipt.appSourceSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await refreshAnonymousPortable(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
