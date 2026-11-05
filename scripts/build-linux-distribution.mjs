#!/usr/bin/env node
// Offline local candidate or explicitly requested Ubuntu portable build.
// Neither mode installs packages, downloads, publishes or overwrites outputs.
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFiles, browserDirs, collectFiles, fixtureFiles, hashFile, packageDirs, safeRelative, verifyBundle } from './linux-distribution.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const args = process.argv.slice(2);
const fail = message => { throw new Error(message); };
const copyBuffer = Buffer.allocUnsafe(1024 * 1024);

async function buildPortableController() {
  const targetRoot = path.join(root, 'artifacts/rust-target');
  await mkdir(targetRoot, { recursive: true });
  const target = await mkdtemp(path.join(targetRoot, 'ubuntu-portable-'));
  const source = [await inputFile('poc/controller/Cargo.toml'), await inputFile('poc/controller/Cargo.lock'),
    ...await collectFiles(path.join(root, 'poc/controller/src'), 'poc/controller/src')];
  const fingerprints = async () => Promise.all(source.map(async item => ({ path: item.relative, sha256: await hashFile(item.source) })));
  const before = await fingerprints();
  const cargoHome = process.env.CARGO_HOME || path.join(root, 'artifacts/toolchains/cargo');
  const rustupHome = process.env.RUSTUP_HOME || path.join(root, 'artifacts/toolchains/rustup');
  const cargo = path.join(cargoHome, 'bin/cargo');
  const rustc = path.join(cargoHome, 'bin/rustc');
  const env = { HOME: process.env.HOME, USER: process.env.USER, PATH: '/usr/bin:/bin',
    CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome,
    RUSTUP_TOOLCHAIN: '1.99.1-x86_64-unknown-linux-gnu', CARGO_NET_OFFLINE: 'true', CARGO_INCREMENTAL: '0' };
  const version = executable => execFileSync(executable, ['--version'], { env, encoding: 'utf8' }).trim();
  const cargoVersion = version(cargo), rustcVersion = version(rustc);
  if (!/^rustc 1\.99\.1 /.test(rustcVersion)) fail('incompatible_rust_toolchain');
  const arguments_ = ['build', '--offline', '--locked', '--release', '--manifest-path', path.join(root, 'poc/controller/Cargo.toml'), '--target-dir', target];
  const started = Date.now();
  execFileSync(cargo, arguments_, { cwd: root, env, stdio: 'inherit', timeout: 240_000 });
  if (JSON.stringify(before) !== JSON.stringify(await fingerprints())) fail('controller_source_changed_during_build');
  return { type: 'fresh offline release build', sourceBuildVerified: true, cargoVersion, rustcVersion,
    command: `cargo build --offline --locked --release --manifest-path poc/controller/Cargo.toml --target-dir ${path.relative(root, target)}`,
    elapsedMs: Date.now() - started, sourceFiles: before, source: `${path.relative(root, target)}/release/ktz-g02-controller` };
}

async function inputFile(relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail(`symlink_refused:${relative}`);
  }
  const info = await lstat(current);
  if (!info.isFile()) fail(`non_regular_file:${relative}`);
  return { source: current, relative, info };
}

async function copyChecked(item, destination, mode) {
  // Reuse only hash-verified immutable payload on the same filesystem. Never
  // link data/temp or chmod/write a shared inode; app/source files are copied.
  if (item.expectedSha && item.info.dev === (await lstat(path.dirname(destination))).dev
      && (item.info.mode & 0o777) === mode) {
    await link(item.source, destination);
    const current = await lstat(destination);
    if (!current.isFile() || current.dev !== item.info.dev || current.ino !== item.info.ino
        || current.size !== item.info.size || await hashFile(destination) !== item.expectedSha) fail(`reuse_input_changed:${item.relative}`);
    return item.expectedSha;
  }
  // Open the original inode without following a final symlink; validate it
  // again through the descriptor so a replacement is never copied by path.
  const source = await open(item.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.dev !== item.info.dev || before.ino !== item.info.ino
        || before.size !== item.info.size || before.mtimeMs !== item.info.mtimeMs) fail(`input_changed:${item.relative}`);
    target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const hash = createHash('sha256');
    const buffer = copyBuffer; let copied = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      for (let offset = 0; offset < bytesRead;) {
        const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, null);
        if (!bytesWritten) fail(`copy_incomplete:${item.relative}`);
        offset += bytesWritten;
      }
      copied += bytesRead;
    }
    const after = await source.stat();
    if (copied !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) fail(`input_changed:${item.relative}`);
    await target.chmod(mode);
    return hash.digest('hex');
  } finally { await target?.close(); await source.close(); }
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 22
      || ![2, 3, 4].includes(args.length) || args[0] !== '--output' || !path.isAbsolute(args[1])
      || path.resolve(args[1]) !== args[1] || args.length === 3 && args[2] !== '--ubuntu-portable'
      || args.length === 4 && (args[2] !== '--reuse-ubuntu-portable' || !path.isAbsolute(args[3]) || path.resolve(args[3]) !== args[3])) {
    fail('usage: node scripts/build-linux-distribution.mjs --output /absolute/new-directory [--ubuntu-portable | --reuse-ubuntu-portable /absolute/existing-bundle]');
  }
  const reuse = args.length === 4;
  const portable = args.length >= 3;
  if (portable && process.versions.node !== '22.22.1') fail('incompatible_node_runtime');
  const output = args[1], parent = path.dirname(output);
  if (output === root || output.startsWith(`${root}/`) || await realpath(parent) !== parent) fail('unsafe_output_parent');
  try { await lstat(output); fail('output_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const pw = JSON.parse(await readFile(path.join(root, 'node_modules/playwright/package.json'), 'utf8'));
  const core = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/package.json'), 'utf8'));
  const png = JSON.parse(await readFile(path.join(root, 'node_modules/pngjs/package.json'), 'utf8'));
  const browsers = JSON.parse(await readFile(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  if (pw.version !== '1.64.1' || core.version !== pw.version || png.version !== '7.0.0') fail('incompatible_installed_packages');
  for (const [name, revision] of [['chromium', '1248'], ['chromium-headless-shell', '1248'], ['ffmpeg', '1013']]) {
    if (browsers.browsers.find(item => item.name === name)?.revision !== revision) fail('incompatible_browser_manifest');
  }
  const inputs = [];
  for (const name of [...appFiles, ...fixtureFiles, 'poc/browser/fixture-server.mjs', 'package.json', 'LICENSE', ...(portable ? ['docs/ubuntu-portable.ja.md', 'docs/linux-login.ja.md'] : []),
    'scripts/linux-distribution.mjs', 'scripts/linux-bundle-launch.mjs', 'scripts/linux-bundle-self-check.mjs']) inputs.push(await inputFile(name));
  let reusedReceipt;
  if (reuse) {
    const previous = args[3];
    if (await realpath(previous) !== previous) fail('unsafe_reuse_bundle');
    reusedReceipt = await verifyBundle(previous);
    if (reusedReceipt.kind !== 'KindleToZip Ubuntu x64 portable' || !['fresh offline debug build', 'fresh offline release build'].includes(reusedReceipt.controller?.type)
        || reusedReceipt.controller.sourceBuildVerified !== true || reusedReceipt.node !== process.versions.node
        || reusedReceipt.playwright !== pw.version || reusedReceipt.pngjs !== png.version
        || JSON.stringify(reusedReceipt.browserRevisions) !== JSON.stringify(browserDirs)) fail('incompatible_reuse_bundle');
    const source = [await inputFile('poc/controller/Cargo.toml'), await inputFile('poc/controller/Cargo.lock'),
      ...await collectFiles(path.join(root, 'poc/controller/src'), 'poc/controller/src')];
    const current = await Promise.all(source.map(async item => ({ path: item.relative, sha256: await hashFile(item.source) })));
    if (JSON.stringify(current) !== JSON.stringify(reusedReceipt.controller.sourceFiles)) fail('controller_source_mismatch');
    if (!/^artifacts\/rust-target\/ubuntu-portable-[A-Za-z0-9]+\/(?:debug|release)\/ktz-g02-controller$/.test(safeRelative(reusedReceipt.controller.source))) fail('controller_source_path_mismatch');
    const controllerRecord = reusedReceipt.files.find(item => item.path === 'runtime/controller');
    if (!controllerRecord || await hashFile(path.join(root, reusedReceipt.controller.source)) !== controllerRecord.sha256) fail('controller_build_mismatch');
    const prefixes = [...packageDirs.map(name => `${name}/`), ...browserDirs.map(name => `artifacts/browsers/${name}/`)];
    const chosen = reusedReceipt.files.filter(item => prefixes.some(prefix => item.path.startsWith(prefix))
      || ['runtime/node', 'runtime/controller', 'licenses/node-LICENSE'].includes(item.path));
    for (const item of chosen) {
      const sourcePath = path.join(previous, item.path), info = await lstat(sourcePath);
      if (!info.isFile() || info.isSymbolicLink()) fail(`unsafe_reuse_file:${item.path}`);
      inputs.push({ source: sourcePath, relative: item.path, info, expectedSha: item.sha256 });
    }
    for (const prefix of prefixes) if (!chosen.some(item => item.path.startsWith(prefix))) fail(`missing_reuse_payload:${prefix}`);
    for (const name of ['runtime/node', 'runtime/controller', 'licenses/node-LICENSE']) if (!chosen.some(item => item.path === name)) fail(`missing_reuse_payload:${name}`);
  } else {
    for (const directory of packageDirs) {
      const source = path.join(root, directory);
      if (await realpath(source) !== source) fail(`symlink_refused:${directory}`);
      inputs.push(...await collectFiles(source, directory));
    }
    // These two pre-existing root links are explicit trusted source anchors. No
    // links below their resolved targets are followed or copied.
    const browsersRoot = await realpath(path.join(root, 'artifacts/browsers'));
    for (const directory of browserDirs) inputs.push(...await collectFiles(path.join(browsersRoot, directory), `artifacts/browsers/${directory}`));
  }
  for (const required of ['artifacts/browsers/chromium-1248/chrome-linux64/chrome',
    'artifacts/browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell',
    'artifacts/browsers/ffmpeg-1013/ffmpeg-linux', ...browserDirs.map(name => `artifacts/browsers/${name}/INSTALLATION_COMPLETE`)]) {
    const entry = inputs.find(item => item.relative === required);
    if (!entry || !required.endsWith('/INSTALLATION_COMPLETE') && !(entry.info.mode & 0o111)) fail(`missing_browser_payload:${required}`);
  }
  if (!reuse) {
    const node = await realpath(process.execPath);
    const nodeInfo = await lstat(node);
    if (!nodeInfo.isFile()) fail('missing_node_runtime');
    inputs.push({ source: node, relative: 'runtime/node', info: nodeInfo });
    const nodeLicense = path.join(path.dirname(path.dirname(node)), 'LICENSE');
    const licenseInfo = await lstat(nodeLicense);
    if (!licenseInfo.isFile() || licenseInfo.isSymbolicLink()) fail('missing_node_license');
    inputs.push({ source: nodeLicense, relative: 'licenses/node-LICENSE', info: licenseInfo });
  }
  // Check capacity before invoking Cargo as well as before copying payloads.
  if (portable && !reuse) {
    await mkdir(path.join(root, 'artifacts/rust-target'), { recursive: true });
    const outputFs = await statfs(parent, { bigint: true });
    const targetFs = await statfs(await realpath(path.join(root, 'artifacts/rust-target')), { bigint: true });
    if (outputFs.bavail * outputFs.bsize < 2n * 1024n ** 3n || targetFs.bavail * targetFs.bsize < 2n * 1024n ** 3n) fail('insufficient_build_space');
  }
  const controllerInfo = reuse ? { ...reusedReceipt.controller, reusedFromReceiptSha256: await hashFile(path.join(args[3], 'receipt.json')) }
    : portable ? await buildPortableController() : { type: 'pre-existing debug', source: 'artifacts/rust-target/debug/ktz-g02-controller', sourceBuildVerified: false };
  if (!reuse) {
    const controllerRoot = await realpath(path.join(root, 'artifacts/rust-target'));
    const controller = await collectFiles(portable ? path.join(root, controllerInfo.source) : path.join(controllerRoot, 'debug/ktz-g02-controller'), 'runtime/controller');
    inputs.push(...controller);
  }
  if (new Set(inputs.map(item => item.relative)).size !== inputs.length) fail('duplicate_input');
  const size = inputs.reduce((sum, item) => sum + item.info.size, 0);
  const filesystem = await statfs(parent, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const needed = BigInt(size) + BigInt(Math.ceil(size * 0.2)) + 256n * 1024n * 1024n;
  console.log(`入力 ${inputs.length} files / ${size} bytes; 出力先空き ${available} bytes; 必要余裕 ${needed} bytes`);
  if (available < needed) fail('insufficient_output_space');
  await mkdir(output, { mode: 0o700 }); // exclusively creates a new output; never removes an incomplete one
  const records = [];
  for (const item of inputs.sort((a, b) => a.relative.localeCompare(b.relative))) {
    const destination = path.join(output, item.relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const mode = item.info.mode & 0o111 ? 0o755 : 0o644;
    const sha256 = await copyChecked(item, destination, mode);
    if (item.expectedSha && sha256 !== item.expectedSha) fail(`reuse_input_changed:${item.relative}`);
    records.push({ path: item.relative, size: item.info.size, mode, sha256 });
  }
  const appRecords = records.filter(item => item.path.startsWith('app/'));
  const appSourceSha256 = createHash('sha256').update(JSON.stringify(appRecords)).digest('hex');
  const receipt = { schema: 1, kind: portable ? 'KindleToZip Ubuntu x64 portable' : 'KindleToZip Linux local anonymous test bundle', published: false, cleanUbuntuTested: false,
    appVersion: pkg.version, baseCommit: null, appSourceDirty: null, sourceRevisionNote: 'Git not inspected; exact copied app hashes are recorded', appSourceSha256,
    node: process.versions.node, playwright: pw.version, pngjs: png.version,
    browserRevisions: browserDirs, controller: controllerInfo, createdAtUtc: new Date().toISOString(), payloadBytes: size, files: records };
  const receiptPath = path.join(output, 'receipt.json');
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  let launcher = await readFile(path.join(root, 'scripts/start-linux-bundle.sh'), 'utf8');
  for (const [key, value] of Object.entries({ NODE_SHA256: records.find(item => item.path === 'runtime/node').sha256,
    LAUNCH_SHA256: records.find(item => item.path === 'scripts/linux-bundle-launch.mjs').sha256,
    VERIFY_SHA256: records.find(item => item.path === 'scripts/linux-distribution.mjs').sha256,
    RECEIPT_SHA256: await hashFile(receiptPath) })) launcher = launcher.replace(`@${key}@`, value);
  const startPath = path.join(output, 'start-linux-bundle.sh');
  await writeFile(startPath, launcher, { flag: 'wx', mode: 0o755 });
  await chmod(startPath, 0o755);
  const sums = `${await hashFile(receiptPath)}  receipt.json\n${await hashFile(startPath)}  start-linux-bundle.sh\n`;
  await writeFile(path.join(output, 'SHA256SUMS.txt'), sums, { flag: 'wx', mode: 0o644 });
  console.log(`${portable ? '未公開Ubuntu x64 Portable' : '未公開Linuxローカル試験バンドル'}: ${output}\nreceipt SHA-256: ${await hashFile(receiptPath)}\nsource SHA-256: ${appSourceSha256}`);
}

try { await main(); }
catch (error) {
  const reason = error?.code === 'ENOENT' ? `不足または親未存在: ${error.path ?? 'unknown'}` : error?.code ?? error?.message ?? 'unknown';
  console.error(`Linuxバンドル作成失敗: ${reason}`); process.exitCode = 1;
}
