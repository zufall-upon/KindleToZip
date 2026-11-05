// Linux-only test supervisor primitives. No process is owned merely by UID.
import { readFile, readdir, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

const runtimeName = /^ktz-test-[A-Za-z0-9]{6}$/;
const missing = async file => {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const privateDirectory = info => info?.isDirectory() && !info.isSymbolicLink()
  && info.uid === BigInt(process.geteuid()) && (info.mode & 0o7777n) === 0o700n;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Same inherited/pre-existing protections and dev/ino/realpath checks as the
// previously corrected artifacts/linux-port/ux/diagnostics/runtime-cleanup.mjs.
export async function createRuntimeCleanup({ bases = ['/tmp/opencode', '/tmp'], inherited = process.env.TMPDIR } = {}) {
  const protectedPaths = new Set(inherited ? [path.resolve(inherited)] : []);
  for (const base of bases) {
    let names;
    try { names = await readdir(base); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names) if (runtimeName.test(name)) protectedPaths.add(path.join(base, name));
  }
  const runtimes = new Map();
  return {
    paths: () => [...runtimes.keys()],
    async observe(file) {
      if (!file || !bases.includes(path.dirname(file)) || !runtimeName.test(path.basename(file)) || protectedPaths.has(file)) return false;
      const info = await missing(file);
      if (!info) return false;
      if (!privateDirectory(info)) fail('runtime_ownership_unconfirmed');
      let resolved;
      try { resolved = await realpath(file); }
      catch (error) {
        // A worker's normal exit hook may remove its runtime after lstat.
        // Disappearance needs no cleanup; all other identity/IO failures remain fatal.
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      if (resolved !== file) fail('runtime_ownership_unconfirmed');
      const previous = runtimes.get(file);
      if (previous && (previous.dev !== info.dev || previous.ino !== info.ino)) fail('runtime_identity_changed');
      runtimes.set(file, { dev: info.dev, ino: info.ino }); return true;
    },
    async cleanup(onRemove) {
      for (const [file, original] of runtimes) {
        const info = await missing(file);
        if (!info) continue;
        if (!privateDirectory(info) || info.dev !== original.dev || info.ino !== original.ino || await realpath(file) !== file) fail('runtime_identity_changed');
        onRemove(file); await rm(file, { recursive: true });
      }
    },
  };
}

export async function processIdentity(pid) {
  try {
    const base = `/proc/${pid}`;
    if ((await lstat(base)).uid !== process.geteuid()) return null;
    const stat = await readFile(`${base}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z') return null;
    let env = [];
    try { env = (await readFile(`${base}/environ`, 'utf8')).split('\0'); }
    catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
    const args = (await readFile(`${base}/cmdline`, 'utf8')).split('\0');
    const executable = path.basename(args[0] || '');
    const role = /xvfb/i.test(executable) ? 'xvfb' : /chrom(e|ium)/i.test(executable) ? 'chromium'
      : /controller/i.test(executable) ? 'controller' : /node/i.test(executable) ? 'node'
        : /npm/i.test(executable) ? 'npm' : 'other';
    const candidate = value => typeof value === 'string' && path.isAbsolute(value)
      && runtimeName.test(path.basename(value)) ? value : null;
    const temp = candidate(env.find(item => item.startsWith('TMPDIR='))?.slice(7))
      ?? args.map(arg => candidate(arg.match(/^--user-data-dir=(\/.*?\/ktz-test-[A-Za-z0-9]{6})(?:\/|$)/)?.[1])).find(Boolean);
    return { pid: Number(pid), ppid: Number(fields[1]), starttime: fields[19], role, env,
      temp: temp ?? null };
  } catch (error) { if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return null; throw error; }
}

export function createOwnerTracker(token) {
  const known = new Map();
  const key = record => `${record.pid}:${record.starttime}`;
  async function scan() {
    const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
    const records = (await Promise.all(pids.map(processIdentity))).filter(Boolean);
    const matched = new Map(records.filter(item => item.env.includes(`KTZ_TEST_DIAGNOSTIC_OWNER=${token}`)
      || known.has(key(item))).map(item => [item.pid, item]));
    let changed;
    do {
      changed = false;
      for (const item of records) if (!matched.has(item.pid) && matched.has(item.ppid)) { matched.set(item.pid, item); changed = true; }
    } while (changed);
    return [...matched.values()].map(({ env, ...item }) => { known.set(key(item), item); return item; });
  }
  async function signal(record, signalName) {
    if (!known.has(key(record))) return false;
    const current = await processIdentity(record.pid);
    if (!current || current.starttime !== record.starttime) return false;
    try { process.kill(record.pid, signalName); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  return { scan, signal };
}

export async function removeOwnedFixtures(root, initialNames, fixtures, onRemove) {
  for (const [name, original] of fixtures) {
    if (!/^workflow-[A-Za-z0-9]{6}$/.test(name) || initialNames.has(name)) fail('fixture_ownership_unconfirmed');
    const file = path.join(root, name), info = await missing(file);
    if (!info) continue;
    if (!privateDirectory(info) || String(info.dev) !== original.dev || String(info.ino) !== original.ino
      || await realpath(file) !== file) fail('fixture_identity_changed');
    onRemove(name); await rm(file, { recursive: true });
  }
}
