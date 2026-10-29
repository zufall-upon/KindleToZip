import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLatestPortable } from './portable-reports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2).filter(argument => argument !== '--');
// Some Windows npm/PowerShell combinations consume an option after the
// separator instead of forwarding it. With no positional argument, selecting
// the latest explicitly reported Portable build is the safe, deterministic
// default; exact EXE paths remain supported.
const latestRequested = args.length === 0 || args.length === 1 && args[0] === '--latest-portable';
const smokeStartedAt = Date.now();
assert.ok(latestRequested || args.length === 1, 'Usage: node scripts/test-distribution.mjs <exact-portable-exe> | --latest-portable');

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

const selected = latestRequested
  ? await selectLatestPortable(root)
  : (() => ({ executable: path.resolve(root, args[0]), reportPath: path.resolve(root, args[0].replace(/\.exe$/i, '.json')) }))();
const executable = selected.executable;
assert.ok(executable.toLowerCase().endsWith('.exe'), 'pass the exact Portable Windows EXE path');
const report = selected.report ?? JSON.parse(await readFile(selected.reportPath, 'utf8'));
assert.equal(report.portable, true, 'selected package must be an explicitly reported Portable EXE');
assert.equal(report.cleanWindowsTested, false, 'packaged fixture test is not clean-Windows validation');
assert.equal(await stat(executable).then(info => info.isFile()), true);
const executableHash = await sha256(executable);
assert.equal(executableHash, report.executableSha256, 'exact selected EXE must match its build report');

const runsRoot = path.join(root, 'artifacts/distribution-tests');
await mkdir(runsRoot, { recursive: true });
const runDirectory = path.join(runsRoot, `run-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
await mkdir(runDirectory);
const sourcePortable = path.join(runDirectory, 'Portable 試験 with spaces');
const movedPortable = path.join(runDirectory, '移動後 Portable with spaces');
const deniedPortable = path.join(runDirectory, '書込拒否 Portable with spaces');
const redirect = path.join(runDirectory, '外部保存先は禁止');
const legacyHome = path.join(redirect, 'legacy-portable-home');
const legacyData = path.join(redirect, 'legacy-user-data');
const legacyTemp = path.join(redirect, 'legacy-app-temp');
const legacyRuntime = path.join(redirect, 'legacy-runtime');
const fakeLocalAppData = path.join(redirect, 'local-app-data');
const fakeAppData = path.join(redirect, 'roaming-app-data');
const fakeProfile = path.join(redirect, 'user-profile');
const fakeTemp = path.join(redirect, 'windows-temp');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const system32 = path.join(systemRoot, 'System32');
for (const directory of [fakeLocalAppData, fakeAppData, fakeProfile, fakeTemp]) await mkdir(directory, { recursive: true });

const env = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'RUSTUP_HOME', 'CARGO_HOME', 'RUSTUP_TOOLCHAIN', 'CARGO_TARGET_DIR', 'KTZ_CONTROLLER_PATH', 'PLAYWRIGHT_BROWSERS_PATH']) delete env[key];
env.PATH = system32;
env.KTZ_PORTABLE_HOME = legacyHome;
env.KTZ_USER_DATA_DIR = legacyData;
env.KTZ_TEMP_DIR = legacyTemp;
env.KTZ_RUNTIME_DIR = legacyRuntime;
env.LOCALAPPDATA = fakeLocalAppData;
env.APPDATA = fakeAppData;
env.USERPROFILE = fakeProfile;
env.HOME = fakeProfile;
env.TEMP = fakeTemp;
env.TMP = fakeTemp;
env.TMPDIR = fakeTemp;
env.PLAYWRIGHT_BROWSERS_PATH = path.join(redirect, 'external-browsers');

function launch(exe, childArgs, { cwd = runDirectory, timeoutMs = 300_000 } = {}) {
  const child = spawn(exe, childArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', error = null;
  const waiters = [];
  const append = (which, text) => {
    if (which === 'stdout') stdout = (stdout + text).slice(-256_000);
    else stderr = (stderr + text).slice(-256_000);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(stdout, stderr)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve({ stdout, stderr });
      }
    }
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => append('stdout', text));
  child.stderr.on('data', text => append('stderr', text));
  child.once('error', cause => { error = cause; });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    const taskkill = path.join(system32, 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.unref();
    child.kill();
  }, timeoutMs);
  const closed = new Promise(resolve => child.once('close', code => {
    clearTimeout(timeout);
    resolve({ code, timedOut, error, stdout, stderr });
  }));
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    waitForOutput(predicate, waitMs = 45_000) {
      if (predicate(stdout, stderr)) return Promise.resolve({ stdout, stderr });
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for packaged output.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, waitMs) };
        waiters.push(waiter);
      });
    },
    wait: () => closed,
  };
}

async function run(exe, childArgs) {
  const session = launch(exe, childArgs);
  return await session.wait();
}

function smokeResult(output, phase) {
  const line = output.split(/\r?\n/).find(value => value.startsWith('KTZ_SMOKE_RESULT:'));
  assert.ok(line, `${phase} fixture result missing\n${output}`);
  const result = JSON.parse(line.slice('KTZ_SMOKE_RESULT:'.length));
  assert.equal(result.result, 'pass');
  assert.equal(result.developerPathToolsAvailable, false);
  return result;
}

async function assertRedirectsUnused() {
  for (const directory of [legacyHome, legacyData, legacyTemp, legacyRuntime, path.join(redirect, 'external-browsers')]) {
    await assert.rejects(stat(directory), { code: 'ENOENT' }, `legacy_redirect_was_not_created:${path.basename(directory)}`);
  }
  for (const directory of [fakeLocalAppData, fakeAppData, fakeProfile, fakeTemp]) {
    assert.deepEqual(await readdir(directory), [], `app_did_not_write_outside_portable_tree:${path.basename(directory)}`);
  }
}

async function runIcacls(parameters) {
  const icacls = path.join(system32, 'icacls.exe');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(icacls, parameters, { cwd: runDirectory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, `icacls ${parameters[1]} failed\n${result.stdout}\n${result.stderr}`);
}

async function assertPrivatePortablePaths(portable) {
  // Windows PowerShell may initialize its own module-analysis cache. Keep this
  // observer separate from the fake profiles used to detect EXE side effects.
  const probeHome = path.join(runDirectory, 'acl-observer-home');
  await mkdir(probeHome, { recursive: true });
  const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach ($name in @('runtime','temp')) { $p=Join-Path $env:KTZ_ACL_TEST_ROOT $name; $acl=Get-Acl -LiteralPath $p; if (-not $acl.AreAccessRulesProtected) { throw 'private root inherits shared ACL' }; foreach ($item in @(Get-Item -LiteralPath $p) + @(Get-ChildItem -LiteralPath $p -Recurse -Force)) { $rules=@((Get-Acl -LiteralPath $item.FullName).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq Allow); if ($rules.Count -eq 0 -or @($rules | Where-Object { $_.IdentityReference.Value -ne $sid }).Count) { throw ('non-private ACL: '+$item.FullName) } } }`;
  let result;
  try { result = await new Promise((resolve, reject) => {
    const child = spawn(path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', script], {
      cwd: runDirectory, env: {
        ...env, PSModulePath: path.join(system32, 'WindowsPowerShell/v1.0/Modules'), KTZ_ACL_TEST_ROOT: portable,
        USERPROFILE: probeHome, HOME: probeHome, LOCALAPPDATA: probeHome, APPDATA: probeHome, TEMP: probeHome, TMP: probeHome,
      }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stderr = '';
    child.stdout.resume(); child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
    child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
  }); } finally { await rm(probeHome, { recursive: true, force: true }); }
  assert.equal(result.code, 0, `runtime/temp must remain current-user-only even under a shared parent\n${result.stderr}`);
}

let denialSid;
let reportPath;
let succeeded = false;
try {
  const copiedExe = path.join(sourcePortable, path.basename(executable));
  await mkdir(sourcePortable);
  await copyFile(executable, copiedExe);
  assert.equal(await sha256(copiedExe), executableHash, 'test copy keeps the exact selected EXE');

  const initialProcess = await run(copiedExe, ['--distribution-smoke']);
  assert.equal(initialProcess.code, 0, `packaged Portable first launch failed (exit=${initialProcess.code})\nstdout:\n${initialProcess.stdout}\nstderr:\n${initialProcess.stderr}`);
  assert.equal(initialProcess.timedOut, false);
  const first = smokeResult(initialProcess.stdout, 'first-launch');
  assert.deepEqual(first.publicImageFlow.map(({ screenshots, ...result }) => result), ['png', 'jpeg'].map(imageFormat => ({
    imageFormat, coverSingle: true, images: 2, crop: [560, 800], originalKept: true, zipAndCbzReopened: true, selection: 'public',
    autoCropComparedAppliedCancelledRestored: true, splitOrderAndPixelsVerified: true,
  })));
  for (const result of first.publicImageFlow) for (const screenshot of result.screenshots) {
    assert.match(screenshot, /^fixture-(cover|preview|page|review|auto)-(png|jpeg)\.(png|jpg)$/);
    assert.ok((await stat(path.join(runDirectory, screenshot))).size > 0, 'anonymous packaged screen evidence retained');
  }
  assert.equal(first.phase, 'created');
  assert.equal(first.headlessOnly, true);
  const initialHidden = first.publicPreviews.find(preview => preview.mode === 'kindle-initial-hidden');
  assert.ok(initialHidden, 'packaged public selection must exercise persistent initial hidden, not only post-next hiding');
  const { elapsedMs, ...hiddenState } = initialHidden;
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs < 8000, 'public hidden failure must terminate within the bound');
  assert.deepEqual(hiddenState, { mode: 'kindle-initial-hidden', field: 'identity', cause: 'hidden', stage: 'preview_visibility_wait',
    approved: false, capturedImages: 0, png: false, configuredFields: 4, tabs: 2, recovery: 'explicit-fixture-only-same-nodes' });
  const successfulPreviews = first.publicPreviews.filter(preview => preview.mode !== 'kindle-initial-hidden');
  assert.deepEqual(successfulPreviews.map(({ publicFlow, ...preview }) => preview), ['kindle-preset', 'automatic', 'picker'].map(mode => ({
    mode, dimensions: [1120, 720], approved: false, capturedImages: 0,
  })), 'bundled public UI must render automatic and ordinary-picker previews without capture');
  assert.deepEqual(successfulPreviews[0].publicFlow, { presetSelected: true, approved: true, explicitlyStarted: true,
    safetyStopped: true, zipReopened: true, entryDimensions: [1120, 720] }, 'public preset flow must continue through actual safety stop and verified ZIP save');
  const twoBook = first.publicTwoBookFlow;
  assert.ok(twoBook, 'packaged public UI must prove the same-application two-book path');
  const { firstJobId, secondJobId, dynamicHiddenFailureStage, reviewResumeZipEntries, ...twoBookResults } = twoBook;
  assert.equal(dynamicHiddenFailureStage, 'advance_confirmation');
  assert.ok(reviewResumeZipEntries >= 2, 'Review resume must export and reopen the original and newly committed PNGs');
  assert.match(firstJobId, /^[a-f0-9]{32}$/);
  assert.match(secondJobId, /^[a-f0-9]{32}$/);
  assert.notEqual(secondJobId, firstJobId, 'the second book must have a distinct job identity');
  assert.deepEqual(twoBookResults, {
    sameApplicationProcess: true, sameProfile: true, firstZipEntries: 1, secondZipEntries: 1,
    delayedPriorOperationSafelyCancelled: true, profileCookieReused: true, firstArchiveRetained: true,
    firstOriginalRetained: true, allZipPngsReopened: true, narrowStickyButtonsVisible: true,
    wideStickyButtonsVisible: true, reloadKeepsSecondBook: true,
  }, 'the packaged public three-button flow must safely complete A then B without losing A or the saved profile');
  assert.equal(first.capturedImages, 2);
  assert.equal(first.cbzEntries, 4);
  assert.equal(first.zipEntries, 4);
  assert.equal(first.temporaryReaderProfileRemoved, true);
  assert.equal(first.savedHarmlessSampleProfile, true);
  assert.deepEqual(first.portableDirectories, ['runtime', 'data', 'temp']);
  assert.equal(path.resolve(first.jobPathAtCreation), path.join(sourcePortable, 'data', 'jobs', first.jobId));
  for (const name of ['runtime', 'data', 'temp']) assert.equal((await stat(path.join(sourcePortable, name))).isDirectory(), true);
  await assertPrivatePortablePaths(sourcePortable);
  await assertRedirectsUnused();

  await rename(sourcePortable, movedPortable);
  await assert.rejects(stat(sourcePortable), { code: 'ENOENT' }, 'old_executable_and_data_tree_is_no_longer_present');
  const movedExe = path.join(movedPortable, path.basename(executable));
  assert.equal(await sha256(movedExe), executableHash);
  const runtimeVersion = (await readdir(path.join(movedPortable, 'runtime'))).find(name => !name.startsWith('.'));
  const movedRuntime = path.join(movedPortable, 'runtime', runtimeVersion);
  const sourceMatched = [];
  async function compareSource(relative) {
    const source = path.join(root, relative);
    if ((await stat(source)).isDirectory()) {
      for (const name of await readdir(source)) {
        if (relative === 'poc/fixtures' && name === 'RIGHTS.md') continue;
        await compareSource(`${relative}/${name}`);
      }
    } else {
      assert.equal(await sha256(path.join(movedRuntime, relative)), await sha256(source), `bundled source matches: ${relative}`);
      sourceMatched.push(relative);
    }
  }
  for (const relative of ['app', 'poc/fixtures', 'poc/browser/fixture-server.mjs', 'poc/browser/public-ui-controls.mjs', 'poc/launcher/smoke.mjs']) await compareSource(relative);
  assert.equal(await sha256(path.join(movedRuntime, 'controller/ktz-g02-controller.exe')),
    await sha256(path.join(root, 'artifacts/rust-target/release/ktz-g02-controller.exe')));
  const retainedTemp = path.join(movedPortable, 'temp', 'harmless-retained-state.txt');
  await writeFile(retainedTemp, 'retain harmless state');
  // Model existing/copied objects carrying an explicit broad grant. Startup
  // must replace those ACLs as well as disabling inheritance on private roots.
  await runIcacls([path.join(movedRuntime, 'app/main.mjs'), '/grant', '*S-1-1-0:M']);
  await runIcacls([retainedTemp, '/grant', '*S-1-1-0:M']);
  const resumedProcess = await run(movedExe, ['--distribution-resume-smoke', first.jobId, first.savedProfileId]);
  assert.equal(resumedProcess.code, 0, `packaged Portable reopen after whole-folder move failed (exit=${resumedProcess.code})\nstdout:\n${resumedProcess.stdout}\nstderr:\n${resumedProcess.stderr}`);
  assert.equal(resumedProcess.timedOut, false);
  const resumed = smokeResult(resumedProcess.stdout, 'after-move');
  assert.equal(resumed.phase, 'resumed-after-move');
  assert.equal(resumed.jobPathAfterMove, path.join(movedPortable, 'data', 'jobs', first.jobId));
  assert.equal(resumed.savedProfileCookieReused, true);
  assert.equal(resumed.automaticResumeOrCapture, false);
  assert.equal(resumed.cbzEntries, 4);
  assert.equal(resumed.zipEntries, 4);
  assert.equal(await readFile(retainedTemp, 'utf8'), 'retain harmless state');
  await assertPrivatePortablePaths(movedPortable);
  await assertRedirectsUnused();

  for (const directory of ['node', 'app', 'node_modules/playwright-core/lib']) {
    const inside = path.join(movedRuntime, directory);
    const outside = path.join(runDirectory, 'junction-target');
    await rename(inside, outside);
    const marker = path.join(outside, 'untouched-security-fixture.txt');
    await writeFile(marker, 'outside remains untouched');
    await symlink(outside, inside, 'junction');
    try {
      const rejected = await run(movedExe, ['--distribution-lock-probe']);
      assert.notEqual(rejected.code, 0, `runtime ${directory} junction must be rejected before running Node`);
      assert.match(rejected.stderr, /安全でない既存パス/);
      assert.match(rejected.stderr, /通常フォルダへEXEと付随フォルダごと移/);
      assert.equal(rejected.stdout.includes('KTZ_LOCK_PROBE_RESULT:'), false);
      assert.equal(await readFile(marker, 'utf8'), 'outside remains untouched');
    } finally {
      await rm(inside);
      await rm(marker);
      await rename(outside, inside);
    }
  }

  const holder = launch(movedExe, ['--distribution-lock-hold'], { timeoutMs: 90_000 });
  const ready = await holder.waitForOutput((stdout) => stdout.includes('KTZ_LOCK_READY:'), 45_000);
  assert.ok(ready.stdout.includes(`KTZ_LOCK_READY:${path.join(movedPortable, 'data')}`));
  try {
    const probe = await run(movedExe, ['--distribution-lock-probe']);
    assert.equal(probe.code, 0, `exclusive data lock probe failed\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`);
    assert.ok(probe.stdout.includes('KTZ_LOCK_PROBE_RESULT:job_busy'), 'second process must be rejected by the existing exclusive data lock');
  } finally {
    holder.child.stdin.write('release\n');
    const released = await holder.wait();
    assert.equal(released.code, 0, `data-lock holder did not release cleanly\n${released.stdout}\n${released.stderr}`);
  }

  await mkdir(deniedPortable);
  const deniedExe = path.join(deniedPortable, path.basename(executable));
  await copyFile(executable, deniedExe);
  const whoami = await new Promise((resolve, reject) => {
    const child = spawn(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { cwd: runDirectory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(whoami.code, 0, `cannot resolve current Windows user SID\n${whoami.stdout}\n${whoami.stderr}`);
  denialSid = whoami.stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
  assert.ok(denialSid, 'current Windows user SID must be observed for the isolated write-denial test');
  // Deny writes only on the test root, not on its executable file. The EXE
  // must remain readable/executable so it can report the intended write
  // denial before creating runtime/data/temp.
  await runIcacls([deniedPortable, '/deny', `*${denialSid}:(W)`]);
  let deniedAclRemoved = false;
  try {
    const denied = await run(deniedExe, ['--distribution-smoke']);
    assert.notEqual(denied.code, 0, 'write-denied Portable root must not fall back and continue');
    assert.match(denied.stderr, /Portable版の保存先へ書き込めません/);
    assert.match(denied.stderr, /書き込み可能な通常フォルダへEXEと付随フォルダごと移/);
    for (const name of ['runtime', 'data', 'temp']) await assert.rejects(stat(path.join(deniedPortable, name)), { code: 'ENOENT' });
  } finally {
    await runIcacls([deniedPortable, '/remove:d', `*${denialSid}`]);
    deniedAclRemoved = true;
    denialSid = undefined;
  }
  assert.equal(deniedAclRemoved, true);
  await assertRedirectsUnused();

  const receipt = {
    command: latestRequested ? 'npm run dist:smoke -- --latest-portable' : `node scripts/test-distribution.mjs "${path.relative(root, executable).replaceAll('\\', '/')}"`,
    selection: latestRequested ? '--latest-portable' : 'exact-portable-exe',
    executable: path.relative(root, executable).replaceAll('\\', '/'),
    executableSha256: executableHash,
    firstLaunch: first,
    sourceMatched,
    wholeFolderMove: {
      from: path.relative(root, sourcePortable).replaceAll('\\', '/'),
      to: path.relative(root, movedPortable).replaceAll('\\', '/'),
      oldTreeAbsentOnRestart: true,
      resumed,
    },
    exclusiveDataLock: 'second process rejected with job_busy while first process held the lock',
    writeDenied: 'isolated current-user ACL denial rejected launch with Japanese move-the-folder guidance',
    runtimeAndTempCurrentUserOnly: true,
    existingExplicitSharedGrantsRemovedOnReuse: true,
    intermediateRuntimeJunctionsRejected: ['node', 'app', 'node_modules/playwright-core/lib'],
    redirectPathsUnused: true,
    developerPathToolsAvailable: false,
    cleanWindowsTested: false,
    exitCode: 0,
    elapsedSeconds: Math.round((Date.now() - smokeStartedAt) / 10) / 100,
    observedAtUtc: new Date().toISOString(),
  };
  reportPath = path.join(runDirectory, 'smoke-result.json');
  await writeFile(reportPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  succeeded = true;
  console.log('Packaged Portable first-launch, whole-folder move/reuse, exclusive-lock and write-denial checks passed (exit 0).');
  console.log(`EXE: ${receipt.executable}`);
  console.log(`SHA-256: ${receipt.executableSha256}`);
  console.log(`Runtime: Node ${first.nodeVersion}, Playwright ${first.playwrightVersion}, Chromium revision ${first.chromiumRevision}; developer PATH tools unavailable.`);
  console.log(`First run: ${first.capturedImages} sample images, crop, order ${first.selectedCaptureIds.join(',')}, ZIP/CBZ ${first.zipEntries}/${first.cbzEntries} entries.`);
  console.log(`Moved tree: ${receipt.wholeFolderMove.to}; saved job, relative image/crop paths, review order, saved sample profile and archives reopened.`);
  console.log('Safety: redirected legacy/profile/temp paths untouched; concurrent start rejected; write denial explained in Japanese.');
  console.log(`Smoke evidence: ${path.relative(root, reportPath).replaceAll('\\', '/')}`);
  console.log(`Elapsed: ${receipt.elapsedSeconds} seconds.`);
  console.log('Clean-Windows test: not performed.');
} finally {
  if (denialSid && await stat(deniedPortable).then(() => true, () => false)) {
    // Do not leave the test-only explicit deny ACE behind if an assertion
    // failed between ACL application and its normal cleanup branch.
    const acl = await new Promise(resolve => {
      const child = spawn(path.join(system32, 'icacls.exe'), [deniedPortable, '/remove:d', `*${denialSid}`], { cwd: runDirectory, env, stdio: 'ignore', windowsHide: true });
      child.once('close', code => resolve(code)); child.once('error', () => resolve(-1));
    });
    if (acl !== 0 && succeeded) throw new Error('Unable to remove the test-only write-denial ACL.');
  }
  if (succeeded) {
    for (const directory of [sourcePortable, movedPortable, deniedPortable, redirect]) await rm(directory, { recursive: true, force: true });
  } else {
    console.error(`Portable test workspace retained for diagnosis: ${path.relative(root, runDirectory).replaceAll('\\', '/')}`);
  }
}
