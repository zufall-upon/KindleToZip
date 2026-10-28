import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';

// GPU subprocesses can append debug.log beside Headless Shell despite logging
// switches. Run the same fixed binaries from a private test copy, never mutate
// the declared browser input. Keep normal launch flags and all capture checks.
const source = fileURLToPath(new URL('../artifacts/browsers/', import.meta.url));
const fixtures = fileURLToPath(new URL('../artifacts/mvp-tests/', import.meta.url));
await mkdir(fixtures, { recursive: true });
const runtime = await mkdtemp(path.join(fixtures, 'chromium-runtime-'));
process.once('exit', () => {
  try { rmSync(runtime, { recursive: true, force: true }); }
  catch { /* A killed child may leave only this owned fixture for cleanup. */ }
});
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
