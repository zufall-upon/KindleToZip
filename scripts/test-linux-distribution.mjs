// Exercise the actual extracted archive with no source-tree module fallback.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyBundle } from './linux-distribution.mjs';

assert.equal(process.platform, 'linux');
const [archive, commit] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.match(commit, /^[a-f0-9]{40}$/);
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
assert.ok(entries.length > 100);
assert.equal(new Set(entries).size, entries.length);
for (const entry of entries) {
  assert.ok(entry.startsWith('KindleToZip/') && !entry.split('/').includes('..'), entry);
  assert.doesNotMatch(entry, /^KindleToZip\/(?:data|temp|\.git|tests)\//);
}
// Keep Chromium's Unix socket path shorter than sockaddr_un.
const directory = await mkdtemp('/tmp/ktz-dist-');
try {
  execFileSync('tar', ['-xzf', path.resolve(archive), '--no-same-owner', '-C', directory]);
  const bundle = path.join(directory, 'KindleToZip');
  const receipt = await verifyBundle(bundle);
  assert.equal(receipt.controller.type, 'fresh offline release build');
  const metadata = JSON.parse(await readFile(path.join(bundle, 'build-metadata.json'), 'utf8'));
  assert.equal(metadata.sourceCommit, commit);
  assert.equal(metadata.tag, `v${receipt.appVersion}`);
  assert.ok((await readdir(path.join(bundle, 'third-party-notices'))).includes('jpeg-encoder-0.6.1'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:KTZ_|NODE_|PLAYWRIGHT_|LD_)/.test(key) || ['DEBUG', 'PWDEBUG', 'CHROMIUM_FLAGS'].includes(key)) delete env[key];
  }
  execFileSync(path.join(bundle, 'start-linux-bundle.sh'), ['--headless-self-check'], { cwd: directory, env, stdio: 'inherit', timeout: 120_000 });
  console.log('Linux extracted release: integrity, metadata, anonymous capture, crop and ZIP passed.');
} finally { await rm(directory, { recursive: true }); }
