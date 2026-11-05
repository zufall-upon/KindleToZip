// Actual installed runtime/core + normal Snap, using only newly owned anonymous
// old/new profiles and a fixture .desktop entry. Never launches the real entry.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, lstat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { hashFile, verifyBundle } from '../../scripts/linux-distribution.mjs';

export async function profileMigrationIntegration() {
  const bundle = '/home/user/KTZ-Portable'; const receipt = await verifyBundle(bundle);
  for (const file of ['linux-profile-copy.mjs', 'linux-profile-migration.mjs', 'linux-portable-migration.mjs']) {
    assert.equal(await hashFile(path.join(bundle, 'app', file)), await hashFile(fileURLToPath(new URL(`../../app/${file}`, import.meta.url))));
  }
  const runtime = path.join(bundle, 'runtime/node');
  assert.equal(await hashFile(runtime), receipt.files.find(item => item.path === 'runtime/node').sha256);
  const { migrateLinuxLogin, confirmLinuxLoginMigration, rollbackLinuxLoginMigration } = await import(pathToFileURL(path.join(bundle, 'app/linux-profile-migration.mjs')));
  const { fingerprintLinuxProfile } = await import(pathToFileURL(path.join(bundle, 'app/linux-profile-copy.mjs')));
  const { resolvePortableLinuxSession } = await import(pathToFileURL(path.join(bundle, 'app/portable-linux-session.mjs')));
  const base = '/home/user/KTZ-Migration-Tests'; await mkdir(base, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(path.join(base, 'txn-'));
  const old = path.join(run, 'old'), target = path.join(run, 'new');
  for (const directory of [old, target, path.join(target, 'data'), path.join(target, 'data/anonymous-profile-check')]) await mkdir(directory, { mode: 0o700 });
  const moduleUrl = pathToFileURL(path.join(bundle, 'app/linux-portable-login.mjs')).href;
  const program = `import{writeFileSync}from'node:fs';import{runPortableLinuxLogin}from${JSON.stringify(moduleUrl)};const root=process.argv[1];const log=console.log;console.log=s=>{if(String(s).startsWith('匿名Portable profile確認: '))writeFileSync(root+'/last-result.json',String(s).slice('匿名Portable profile確認: '.length),{mode:0o600});};await runPortableLinuxLogin(root,{anonymous:true});`;
  for (const directory of [old, target]) await writeFile(path.join(directory, 'start.sh'),
    `#!/bin/sh\nset -eu\n[ "$#:$*" = '1:--login' ] || exit 1\ndirectory=\${0%/*}\nexec '${runtime}' --input-type=module -e '${program.replaceAll("'", "'\\''")}' "$directory"\n`, { flag: 'wx', mode: 0o700 });
  const shortcut = path.join(run, 'anonymous-login.desktop');
  const originalShortcut = Buffer.from(`[Desktop Entry]\nType=Application\nName=KindleToZip anonymous migration fixture\nExec="${old}/start.sh" --login\nPath=${old}\nTerminal=false\n`);
  await writeFile(shortcut, originalShortcut, { flag: 'wx', mode: 0o700 });
  const driver = fileURLToPath(new URL('./launch-migration-fixture.py', import.meta.url));
  const launch = () => {
    const result = spawnSync('/usr/bin/python3', [driver, shortcut], { encoding: 'utf8', timeout: 45000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  };
  launch();
  const originalResult = JSON.parse(await readFile(path.join(old, 'last-result.json'), 'utf8'));
  assert.equal(originalResult.retained, false); assert.equal(originalResult.sandbox, true);
  const oldData = path.join(old, 'data/anonymous-profile-check');
  const source = await resolvePortableLinuxSession(oldData);
  const before = await fingerprintLinuxProfile(source.profile);
  const options = { sourceRoot: source.root, dataDirectory: path.join(target, 'data/anonymous-profile-check'), shortcut, launcher: path.join(target, 'start.sh') };
  const migrated = await migrateLinuxLogin(options);
  const copied = await resolvePortableLinuxSession(options.dataDirectory);
  assert.equal(copied.id, migrated.session);
  assert.notEqual((await lstat(source.profile)).ino, (await lstat(copied.profile)).ino);
  const confirmed = await confirmLinuxLoginMigration(options, { verifyTarget: async destination => {
    assert.equal(destination, copied.root); launch();
    const result = JSON.parse(await readFile(path.join(target, 'last-result.json'), 'utf8'));
    assert.equal(result.retained, true); assert.equal(result.sandbox, true); assert.equal(result.readerSameProfile, true); assert.equal(result.id, copied.id);
  } });
  assert.equal(confirmed.phase, 'confirmed');
  assert.deepEqual(await fingerprintLinuxProfile(source.profile), before, 'copy/restart must not mutate original bytes or attributes');
  await rollbackLinuxLoginMigration(options);
  assert.deepEqual(await readFile(shortcut), originalShortcut);
  await assert.rejects(lstat(path.join(options.dataDirectory, 'kindle-session.json')), { code: 'ENOENT' });
  assert.deepEqual(await fingerprintLinuxProfile(source.profile), before);
  launch();
  const restored = JSON.parse(await readFile(path.join(old, 'last-result.json'), 'utf8'));
  assert.equal(restored.retained, true); assert.equal(restored.sandbox, true); assert.equal(restored.id, source.id);
  const result = { kind: 'installed-core-anonymous-profile-migration', originalRetained: true, distinctCopyInode: true,
    shortcutGioSwitchAndRollback: true, sameSnapSandbox: true, copiedCookieRetained: true, readerRelativeIdentity: true,
    originalBytesAndAttributesUnchanged: true, rolledBackCookieRetained: true, actualProfileUsed: false,
    fixture: path.basename(run), receiptSha256: await hashFile(path.join(bundle, 'receipt.json')), appSourceSha256: receipt.appSourceSha256 };
  const reports = 'artifacts/ubuntu-portable/migration-results'; await mkdir(reports, { recursive: true, mode: 0o700 });
  const report = `${reports}/${path.basename(run)}.json`; await writeFile(report, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { ...result, report };
}
