// The owner constructs the site locally. Its portable start receives only an
// opaque relative ID and the application's data directory, not an HTTP-supplied
// URL, profile, flags or CDP message. IPC carries only lifetime signals.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, lstat, realpath, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { runLinuxLogin, snapLoginPreflight } from './linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from './linux-inspect-resume-core.mjs';
import { startOwnedSample, ownedSampleOptions } from './owned-sample.mjs';
import { privateMetadata, samePath } from './private-path.mjs';
import { anonymousExpectedBook } from './owned-sample-identity.mjs';
import { fileURLToPath } from 'node:url';
import { resolveExistingPortableLinuxSession } from './portable-linux-session.mjs';
import { startPortableReaderSite } from './portable-linux-site.mjs';
import { portableStartupFailure } from './portable-limited-failure.mjs';

const hold = () => { setInterval(() => {}, 60_000); return new Promise(() => {}); };
const send = event => { try { if (process.connected) process.send(event, () => {}); } catch {} };

async function run(portableId = null) {
  const home = userInfo().homedir;
  const ownRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
  // Only the verified Portable launcher sets this exact root; the source-mode
  // owner keeps its established location and never adopts another path.
  const base = process.env.KTZ_PORTABLE_ROOT === ownRoot
    ? path.join(ownRoot, 'data/owned-sample') : path.join(home, 'snap/chromium/common/kindle-to-zip-owned-sample');
  let sample, site, started = false, unknown = false, incoming, outgoing, retainRequested = false, releaseRequested = false, waitingRelease = false, closeRequested = !process.connected, wakeClose, wakeRelease, checkOwner;
  let startupStage = 'owner_check';
  // Install before preflight: the parent may disconnect before Chromium has
  // started. A timeout explicitly requests retention instead of normal close.
  process.on('message', message => {
    if (message?.event === 'check' && Object.keys(message).length === 2 && Number.isSafeInteger(message.id) && message.id > 0) {
      void Promise.resolve().then(() => { if (!checkOwner || closeRequested || retainRequested || unknown) throw new Error('owner_unavailable'); return checkOwner(); })
        .then(() => send({ event: 'checked', id: message.id }), () => { unknown = true; retainRequested = true; send({ event: 'unknown' }); wakeClose?.(); });
      return;
    }
    if (!message || Object.keys(message).length !== 1) return;
    if (message.event === 'retain') { retainRequested = true; wakeClose?.(); wakeRelease?.(); }
    else if (message.event === 'close') { closeRequested = true; wakeClose?.(); }
    else if (message.event === 'release' && waitingRelease) { releaseRequested = true; wakeRelease?.(); }
  });
  process.once('disconnect', () => { closeRequested = true; wakeClose?.(); wakeRelease?.(); });
  try {
    await snapLoginPreflight(home);
    let root;
    if (portableId) {
      // Resolve by explicit relative ID again in the owner, not a profile path
      // supplied over HTTP or a prior preparation's stale metadata.
      const selected = await resolveExistingPortableLinuxSession(process.env.KTZ_PORTABLE_READER_DATA, portableId);
      root = selected.root;
      site = await startPortableReaderSite();
    } else {
      await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(base);
      if (!info.isDirectory() || info.isSymbolicLink() || !privateMetadata(info, true) || !samePath(await realpath(base), base)) throw new Error('unsafe_sample_root');
      // mkdtemp creates an empty directory that this owner, not IPC, chooses.
      root = await mkdtemp(path.join(base, 'run-'));
      sample = await startOwnedSample();
      const options = ownedSampleOptions(sample);
      const flags = [...options.args, `--proxy-server=${options.proxy.server}`,
        `--proxy-bypass-list=${options.proxy.bypass}`, '--remote-debugging-pipe'];
      site = { url: `${sample.url}?asin=${anonymousExpectedBook.asin}`, flags, close: () => sample.close() };
    }
    const flags = site.flags;
    incoming = new net.Socket({ fd: 4, readable: true, writable: false });
    outgoing = new net.Socket({ fd: 5, readable: false, writable: true });
    incoming.on('error', () => {}); outgoing.on('error', () => {});
    await runLinuxLogin({ root, url: site.url, resumeSession: site.resumeSession ?? false, requireExistingProfile: Boolean(portableId),
      preflight: async () => { await snapLoginPreflight(home); if (retainRequested) throw new Error('owner_retained'); },
      // Chromium sometimes rewrites its argv into one process-title string.
      // The shared verifier splits that string on spaces, so verify the one
      // multiword resolver argument separately without weakening the others.
      requiredArgs: flags.filter(flag => !flag.includes(' ')), requireAbsentSingleton: true, joinUnconfirmedStart: true,
      beforeRelease: async () => {
        if (retainRequested) await hold();
        // A connected controller must stop its unknown deadline before we
        // remove the lock. Ordinary parent disconnect still joins normally;
        // a preceding explicit retain always wins and keeps ownership.
        if (process.connected) {
          waitingRelease = true;
          const permission = new Promise(resolve => { wakeRelease = resolve; });
          send({ event: 'release-ready' });
          if (retainRequested || releaseRequested || !process.connected) wakeRelease();
          await permission;
          if (retainRequested || process.connected && !releaseRequested) await hold();
          waitingRelease = false;
        }
      },
      launch(executable, args) {
        startupStage = 'browser_launch';
        const env = { ...process.env, DISPLAY: '' };
        delete env.CHROMIUM_FLAGS;
        const child = spawn(executable, [...args.slice(0, -1), ...flags, args.at(-1)], {
          env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        });
        child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
        // If startup is unconfirmed, runLinuxLogin may remain waiting for the
        // real process. Do not let an undrained browser output pipe fill.
        child.stdio[4].resume();
        started = true;
        return child;
      },
      async onStarted(context) {
        startupStage = 'owner_verify';
        if (retainRequested) await hold();
        const assertProcessStillOwned = async () => {
          await context.assertProcessStillOwned();
          const args = (await readFile(`/proc/${context.child.pid}/cmdline`)).toString().split('\0').filter(Boolean);
          const resolver = flags.find(flag => flag.startsWith('--host-resolver-rules='));
          if (resolver) {
            const adjacent = `${resolver} ${flags.find(flag => flag.startsWith('--proxy-server=')) ?? site.url}`;
            if (!(args.includes(resolver) || args.length === 1 && args[0].includes(adjacent))) throw new Error('resolver_unconfirmed');
          }
          await context.assertStillOwned();
          if (retainRequested) throw new Error('owner_retained');
        };
        await assertProcessStillOwned();
        checkOwner = assertProcessStillOwned;
        const browserIn = context.child.stdio[3], browserOut = context.child.stdio[4];
        incoming.pipe(browserIn, { end: false });
        browserOut.pipe(outgoing, { end: false });
        const closing = new Promise(resolve => { wakeClose = resolve; });
        incoming.once('end', () => { closeRequested = true; wakeClose?.(); });
        outgoing.once('error', () => { closeRequested = true; wakeClose?.(); });
        if (closeRequested || retainRequested || !process.connected) wakeClose();
        send(site.expectedReader ? { event: 'ready', kind: 'fixed-expected-reader', browserPid: context.child.pid }
          : { event: 'ready', url: site.url });
        await Promise.race([closing, context.ended]);
        incoming.unpipe(browserIn); incoming.resume();
        browserOut.unpipe(outgoing); browserOut.resume();
        if (retainRequested) await hold();
        try {
          if (browserIn.writableLength) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('relay_drain_timeout')), 3000);
            browserIn.once('drain', () => { clearTimeout(timer); resolve(); });
          });
          await closeOwnedInspectionBrowser({ ...context, assertProcessStillOwned, onUnknown: () => { unknown = true; send({ event: 'unknown' }); } });
        } catch {
          unknown = true; send({ event: 'unknown' }); await hold();
        }
        // Once unknown is published, do not let a late browser exit turn it
        // into a normal result or release the owner's resources.
        if (unknown || retainRequested) await hold();
      },
    });
    await site.close();
    send({ event: 'normal' });
    if (process.connected) process.disconnect();
    incoming.destroy(); outgoing.destroy();
  } catch (error) {
    send({ event: started ? 'unknown' : 'not-started', startupFailure: portableStartupFailure(error, startupStage) });
    if (started) await hold();
    if (site) await site.close().catch(() => {});
    else await sample?.close().catch(() => {});
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    incoming?.destroy(); outgoing?.destroy();
  }
}

const portableId = process.argv.length === 4 && process.argv[2] === '--portable-session'
  && /^saved-[a-f0-9-]{36}$/.test(process.argv[3]) && path.isAbsolute(process.env.KTZ_PORTABLE_READER_DATA ?? '')
  ? process.argv[3] : null;
if (process.platform !== 'linux' || !process.send || !(process.argv.length === 2 || portableId)) process.exitCode = 1;
else await run(portableId);
