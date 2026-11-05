// Package only receipt-listed immutable payload and generated public notices.
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFiles, fixtureFiles, browserDirs, packageDirs, hashFile, verifyBundle } from './linux-distribution.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [bundle, tag, sourceCommit, workflowRun] = process.argv.slice(2);
assert.equal(process.argv.length, 6);
assert.ok(path.isAbsolute(bundle ?? '') && /^v\d+\.\d+\.\d+$/.test(tag ?? '')
  && /^[a-f0-9]{40}$/.test(sourceCommit ?? '') && /^\d+$/.test(workflowRun ?? ''));
const receipt = await verifyBundle(bundle);
assert.equal(receipt.kind, 'KindleToZip Ubuntu x64 portable');
assert.equal(tag, `v${receipt.appVersion}`);
assert.equal(receipt.controller.sourceBuildVerified, true);
for (const file of receipt.controller.sourceFiles) assert.equal(await hashFile(path.join(root, file.path)), file.sha256);
const exact = new Set([...appFiles, ...fixtureFiles, 'poc/browser/fixture-server.mjs', 'package.json', 'LICENSE',
  'docs/ubuntu-portable.ja.md', 'docs/linux-login.ja.md', 'scripts/linux-distribution.mjs',
  'scripts/linux-bundle-launch.mjs', 'scripts/linux-bundle-self-check.mjs', 'runtime/node', 'runtime/controller', 'licenses/node-LICENSE']);
const prefixes = [...packageDirs, ...browserDirs.map(name => `artifacts/browsers/${name}`)].map(name => `${name}/`);
for (const file of receipt.files) assert.ok(exact.has(file.path) || prefixes.some(prefix => file.path.startsWith(prefix)), file.path);
const sums = await readFile(path.join(bundle, 'SHA256SUMS.txt'), 'utf8');
assert.equal(sums, `${await hashFile(path.join(bundle, 'receipt.json'))}  receipt.json\n${await hashFile(path.join(bundle, 'start-linux-bundle.sh'))}  start-linux-bundle.sh\n`);
const output = path.join(root, 'release-linux');
await mkdir(output); // Never overwrite an earlier candidate.
const stage = await mkdtemp(path.join(tmpdir(), 'ktz-notices-'));
try {
  const additional = [];
  const add = async (name, bytes) => {
    await mkdir(path.dirname(path.join(stage, name)), { recursive: true });
    await writeFile(path.join(stage, name), bytes, { flag: 'wx' }); additional.push(name);
  };
  await add('README.md', await readFile(path.join(bundle, 'docs/ubuntu-portable.ja.md')));
  await add('build-metadata.json', JSON.stringify({ repository: 'zufall-upon/KindleToZip', tag, sourceCommit,
    workflowRun, platform: 'linux-x64', receiptSha256: await hashFile(path.join(bundle, 'receipt.json')) }, null, 2) + '\n');
  const lock = await readFile(path.join(root, 'poc/controller/Cargo.lock'), 'utf8');
  const registry = path.join(process.env.CARGO_HOME || path.join(root, 'artifacts/toolchains/cargo'), 'registry/src');
  const registries = await readdir(registry);
  for (const match of lock.matchAll(/\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"\r?\nsource = "registry\+/g)) {
    const crate = `${match[1]}-${match[2]}`;
    const sources = [];
    for (const index of registries) {
      const candidate = path.join(registry, index, crate);
      try { if ((await lstat(candidate)).isDirectory()) sources.push(candidate); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.equal(sources.length, 1, `crate_source:${crate}`);
    for (const name of await readdir(sources[0])) {
      if (/^(LICENSE|NOTICE|COPYING|COPYRIGHT)([._-]|$)/.test(name) && (await lstat(path.join(sources[0], name))).isFile()) {
        await add(`third-party-notices/${crate}/${name}`, await readFile(path.join(sources[0], name)));
      }
    }
    if (match[1] === 'jpeg-encoder') {
      const source = await readFile(path.join(sources[0], 'src/fdct.rs'), 'utf8');
      const header = /^\/\*[\s\S]*?(?=\s*\* This file contains a slower)/.exec(source)?.[0];
      assert.ok(header?.includes('Independent JPEG Group'));
      await add(`third-party-notices/${crate}/IJG-NOTICE.txt`,
        `this software is based in part on the work of the Independent JPEG Group.\n\n${header.trimEnd()}\n */\n`);
    }
  }
  const list = path.join(stage, 'payload-list');
  await writeFile(list, [...receipt.files.map(file => file.path), 'receipt.json', 'SHA256SUMS.txt', 'start-linux-bundle.sh'].join('\0') + '\0');
  const filename = `KindleToZip-Portable-${tag}-linux-x64.tar.gz`;
  execFileSync('tar', ['-czf', path.join(output, filename), '--owner=0', '--group=0', '--numeric-owner', '--transform=s,^,KindleToZip/,',
    '-C', bundle, '--null', '--verbatim-files-from', '-T', list, '-C', stage, ...additional], { timeout: 180_000 });
  await writeFile(path.join(output, 'SHA256SUMS-linux.txt'), `${await hashFile(path.join(output, filename))}  ${filename}\n`, { flag: 'wx' });
  // Small, standalone attestation subject; only the archive is a download asset.
  await copyFile(path.join(bundle, 'runtime/controller'), path.join(output, 'ktz-g02-controller'));
  console.log(`Linux release package verified: ${filename}`);
} finally { await rm(stage, { recursive: true }); }
