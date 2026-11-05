// Private owner process only; keeps the actual pipe on an unknown terminal.
import { userInfo } from 'node:os';
import { linuxLoginRoot, snapLoginPreflight } from './linux-login-core.mjs';
import { runResumeOwner } from './linux-inspect-resume-core.mjs';

const resumeSession = 'last-session';
if (process.platform !== 'linux' || process.argv.length !== 2 || !process.send) {
  process.exitCode = 1;
} else {
  const home = userInfo().homedir;
  const send = message => { try { if (process.connected) process.send(message, () => {}); } catch { /* retain pipe ownership */ } };
  send({ event: 'owner-ready', pid: process.pid });
  await runResumeOwner({ root: linuxLoginRoot(home),
    expectedOrigin: new URL('https://read.amazon.co.jp/').origin,
    preflight: () => snapLoginPreflight(home), resumeSession,
    notify: value => send({ event: 'result', result: value }) });
  if (process.connected) process.disconnect();
}
