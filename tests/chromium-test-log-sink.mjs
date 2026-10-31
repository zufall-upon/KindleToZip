import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// On Windows, GPU subprocesses can append debug.log beside Headless Shell
// despite logging switches, so retain the existing private-copy strategy.
// Linux uses the installed binaries and a separate private runtime instead.
const source = fileURLToPath(new URL('../artifacts/browsers/', import.meta.url));
const fixtures = fileURLToPath(new URL('../artifacts/mvp-tests/', import.meta.url));
// Linux uses Playwright's installed binaries directly. A short private TMPDIR
// also keeps Chromium's Unix-domain socket below the kernel path limit.
if (process.platform === 'linux') process.umask(0o077);
await mkdir(fixtures, { recursive: true });
const runtime = process.platform === 'linux'
  ? await mkdtemp(path.join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'ktz-test-'))
  : await mkdtemp(path.join(fixtures, 'chromium-runtime-'));
process.once('exit', () => {
  try { rmSync(runtime, { recursive: true, force: true }); }
  catch { /* A killed child may leave only this owned fixture for cleanup. */ }
});
if (process.platform === 'linux') {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= source;
  for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) process.env[key] = runtime;
  process.env.CHROME_LOG_FILE = path.join(runtime, 'chrome.log');
} else {
  await cp(source, runtime, { recursive: true, filter: entry => path.basename(entry) !== 'debug.log' });
  process.env.PLAYWRIGHT_BROWSERS_PATH = runtime;
  const { chromium } = await import('playwright');
  const isolatedOptions = options => ({ ...options, executablePath: options?.executablePath ?? path.join(runtime,
    options?.headless === false ? 'chromium-1248/chrome-win64/chrome.exe'
      : 'chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe') });
  const launch = chromium.launch.bind(chromium);
  const persistent = chromium.launchPersistentContext.bind(chromium);
  chromium.launch = options => launch(isolatedOptions(options));
  chromium.launchPersistentContext = (directory, options) => persistent(directory, isolatedOptions(options));
}
