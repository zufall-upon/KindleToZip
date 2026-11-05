// Fixed dedicated-profile owner. No URL, profile, flag or CDP requests enter IPC.
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import net from 'node:net';
import { linuxLoginRoot, runLinuxLogin, snapLoginPreflight } from './linux-login-core.mjs';
import { closeOwnedInspectionBrowser } from './linux-inspect-resume-core.mjs';
import { loadExpectedBook } from './linux-expected-book.mjs';

const hold = () => { setInterval(() => {}, 60_000); return new Promise(() => {}); };
const send = event => { try { if (process.connected) process.send(event, () => {}); } catch {} };

async function run() {
  const home = userInfo().homedir;
  let started = false, retained = false, closeRequested = !process.connected, releaseRequested = false, waitingRelease = false;
  let wakeClose, wakeRelease, incoming, outgoing;
  process.on('message', message => {
    if (!message || Object.keys(message).length !== 1) return;
    if (message.event === 'retain') { retained = true; wakeClose?.(); wakeRelease?.(); }
    else if (message.event === 'close') { closeRequested = true; wakeClose?.(); }
    else if (message.event === 'release' && waitingRelease) { releaseRequested = true; wakeRelease?.(); }
  });
  process.once('disconnect', () => { closeRequested = true; wakeClose?.(); wakeRelease?.(); });
  try {
    // Identity must already exist before any browser/profile operation.
    await loadExpectedBook(home);
    incoming = new net.Socket({ fd: 4, readable: true, writable: false });
    outgoing = new net.Socket({ fd: 5, readable: false, writable: true });
    incoming.on('error', () => {}); outgoing.on('error', () => {});
    await runLinuxLogin({ root: linuxLoginRoot(home),
      preflight: async () => { await snapLoginPreflight(home); if (retained) throw new Error('owner_retained'); },
      resumeSession: 'last-session', requireExistingProfile: true, requireAbsentSingleton: true, joinUnconfirmedStart: true,
      requiredArgs: ['--remote-debugging-pipe', '--ozone-platform=wayland'],
      beforeRelease: async () => {
        if (retained) await hold();
        if (process.connected) {
          waitingRelease = true;
          const permission = new Promise(resolve => { wakeRelease = resolve; });
          send({ event: 'release-ready' });
          if (retained || releaseRequested || !process.connected) wakeRelease();
          await permission;
          if (retained || process.connected && !releaseRequested) await hold();
          waitingRelease = false;
        }
      },
      launch(executable, args) {
        const env = { ...process.env, DISPLAY: '' };
        delete env.CHROMIUM_FLAGS;
        const child = spawn(executable, [...args, '--ozone-platform=wayland', '--remote-debugging-pipe'], {
          env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        });
        child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
        child.stdio[4].resume(); started = true;
        return child;
      },
      async onStarted(context) {
        if (retained) await hold();
        await context.assertProcessStillOwned();
        const browserIn = context.child.stdio[3], browserOut = context.child.stdio[4];
        incoming.pipe(browserIn, { end: false }); browserOut.pipe(outgoing, { end: false });
        const closing = new Promise(resolve => { wakeClose = resolve; });
        incoming.once('end', () => { closeRequested = true; wakeClose?.(); });
        outgoing.once('error', () => { closeRequested = true; wakeClose?.(); });
        if (closeRequested || retained || !process.connected) wakeClose();
        send({ event: 'ready', kind: 'fixed-expected-reader', browserPid: context.child.pid });
        await Promise.race([closing, context.ended]);
        incoming.unpipe(browserIn); incoming.resume(); browserOut.unpipe(outgoing); browserOut.resume();
        if (retained) await hold();
        try {
          if (browserIn.writableLength) await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('relay_drain_timeout')), 3000);
            browserIn.once('drain', () => { clearTimeout(timer); resolve(); });
          });
          await closeOwnedInspectionBrowser({ ...context, onUnknown: () => { retained = true; send({ event: 'unknown' }); } });
        } catch { retained = true; send({ event: 'unknown' }); await hold(); }
        if (retained) await hold();
      },
    });
    send({ event: 'normal' });
    if (process.connected) process.disconnect();
    incoming.destroy(); outgoing.destroy();
  } catch {
    send({ event: started ? 'unknown' : 'not-started' });
    if (started) await hold();
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    incoming?.destroy(); outgoing?.destroy();
  }
}
if (process.platform !== 'linux' || process.argv.length !== 2 || !process.send || !process.env.WAYLAND_DISPLAY) process.exitCode = 1;
else await run();
