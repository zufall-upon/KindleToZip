// Fixed inputs and integrity checks for Linux local and release bundles.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const appFiles = [
  'application.mjs', 'control-window.mjs', 'controller-path.mjs',
  'expected-capture-budget.mjs', 'expected-capture-diagnostic.mjs', 'expected-capture-session.mjs',
  'expected-identity.mjs', 'export-name.mjs', 'linux-gui-smoke.mjs', 'linux-expected-book.mjs', 'linux-expected-capture-paths.mjs',
  'linux-inspect-core.mjs', 'linux-inspect-resume-core.mjs', 'linux-login-core.mjs', 'linux-portable-login.mjs', 'portable-linux-session.mjs', 'portable-linux-reader.mjs', 'portable-linux-site.mjs',
  'portable-reader-site.mjs', 'portable-limited-session.mjs', 'portable-normal-job.mjs', 'portable-limited-claim.mjs', 'portable-limited-failure.mjs', 'portable-limited-pilot.mjs', 'portable-startup-observation.mjs', 'portable-postprocess-ticket.mjs',
  'linux-owned-reader.mjs', 'linux-owned-reader-owner.mjs', 'linux-playwright-expected-observe.mjs',
  'linux-playwright-pipe.mjs', 'linux-reader-probe.mjs', 'main.mjs', 'owned-sample-identity.mjs',
  'owned-sample.mjs', 'owned-session.mjs', 'presets.mjs', 'private-path.mjs', 'reader.mjs', 'reader-chrome-overlay.mjs',
  'sample-reader-config.mjs', 'save-dialog.mjs', 'server.mjs', 'session-preference.mjs',
  'startup-cleanup.mjs', 'startup-error.mjs', 'startup.mjs', 'store-client.mjs', 'visible-candidate.mjs', 'visible-geometry.mjs',
  'stores/index.mjs', 'stores/kindle.mjs', 'ui/index.html', 'ui/i18n.mjs', 'ui/messages.mjs', 'ui/style.css', 'ui/ui.mjs',
].map(name => `app/${name}`);
export const fixtureFiles = ['reader.html', 'reader.js', 'reader.css', 'reader-image-review.html', 'reader-image-review.js',
  'reader-layout.html', 'reader-layout.js', 'reader-layout.css', 'reader-layout-frame.html', 'reader-layout-frame.css',
  'reader-kindle-chrome.html', 'reader-kindle-chrome.css', 'reader-kindle-chrome.js'].map(name => `poc/fixtures/${name}`);
export const packageDirs = ['node_modules/playwright', 'node_modules/playwright-core', 'node_modules/pngjs'];
export const browserDirs = ['chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013'];

export function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0')
      || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid_bundle_path');
  }
  return relative;
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Never follow links below a selected anchor. Source anchor symlinks are resolved
// separately by the builder and never copied into the output.
export async function collectFiles(directory, prefix) {
  const result = [];
  async function walk(current, relative) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`symlink_refused:${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await walk(path.join(current, name), `${relative}/${name}`);
    } else if (info.isFile()) result.push({ source: current, relative: safeRelative(relative), info });
    else throw new Error(`non_regular_file:${relative}`);
  }
  await walk(directory, safeRelative(prefix));
  return result;
}

export async function verifyBundle(root) {
  const receipt = JSON.parse(await readFile(path.join(root, 'receipt.json'), 'utf8'));
  if (!['KindleToZip Linux local anonymous test bundle', 'KindleToZip Ubuntu x64 portable'].includes(receipt.kind) || receipt.schema !== 1
      || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 100000) throw new Error('invalid_receipt');
  const seen = new Set();
  for (const item of receipt.files) {
    const relative = safeRelative(item.path);
    if (seen.has(relative) || relative === 'receipt.json' || relative.startsWith('data/')
        || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)
        || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error('invalid_receipt_entry');
    seen.add(relative);
    const parts = relative.split('/'); let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('unsafe_bundle_entry');
      if (i === parts.length - 1 && (info.size !== item.size || (info.mode & 0o777) !== item.mode
          || await hashFile(current) !== item.sha256)) throw new Error(`bundle_integrity_failed:${relative}`);
    }
  }
  for (const required of ['runtime/node', 'runtime/controller', 'app/main.mjs', 'scripts/linux-bundle-launch.mjs',
    'scripts/linux-bundle-self-check.mjs', 'scripts/linux-distribution.mjs', 'node_modules/playwright/package.json',
    'node_modules/playwright-core/browsers.json', 'node_modules/pngjs/package.json', 'poc/browser/fixture-server.mjs']) {
    if (!seen.has(required)) throw new Error(`bundle_missing:${required}`);
  }
  return receipt;
}
