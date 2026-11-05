// Private owner retains the newly spawned browser and pipe on unknown exit.
import { userInfo } from 'node:os';
import { linuxLoginRoot, snapLoginPreflight } from './linux-login-core.mjs';
import { runPlaywrightOwner } from './linux-playwright-resume-core.mjs';

if (process.platform !== 'linux' || process.argv.length !== 2 || !process.send) process.exitCode = 1;
else {
  const home = userInfo().homedir;
  const send = message => { try { if (process.connected) process.send(message, () => {}); } catch { /* retain ownership */ } };
  send({ event: 'owner-ready', pid: process.pid });
  await runPlaywrightOwner({ root: linuxLoginRoot(home),
    expectedOrigin: new URL('https://read.amazon.co.jp/').origin, preflight: () => snapLoginPreflight(home),
    notify: value => send({ event: 'result', result: value }) });
  if (process.connected) process.disconnect();
}
