import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, lstat, mkdtemp, rm, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePortableLinuxSession } from '../../app/portable-linux-session.mjs';
import { prepareLinuxLoginProfile } from '../../app/linux-login-core.mjs';

export async function runPilotFixture(t, mode) {
  const checkout = fileURLToPath(new URL('../../', import.meta.url));
  const packagedRoot = process.env.KTZ_TEST_PACKAGED_ROOT;
  if (packagedRoot !== undefined) assert.equal(packagedRoot, '/home/user/KTZ-Portable');
  const project = packagedRoot ?? checkout;
  const base = '/home/user/KTZRC/pilot-20261103';
  await mkdir(base, { recursive: true, mode: 0o700 });
  // Keep the real launcher's Unix socket check intact. Allocate an exclusive
  // short run directory; never adopt or remove an earlier run.
  let root;
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const names = [...alphabet].flatMap(a => [...alphabet].map(b => `${a}${b}`));
  for (const name of names) {
    const candidate = path.join(base, name);
    try { await mkdir(candidate, { mode: 0o700 }); root = candidate; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  assert.ok(root, 'anonymous fixture slots exhausted');
  const blue = mode.startsWith('blue-'), bootstrapCompanion = mode === 'blue-bootstrap-companion', archive = mode === 'archive-positive';
  const normalCapture = mode.startsWith('normal-');
  const cliMode = mode === 'cli-kindle' || mode === 'cli-resume';
  let evidence;
  if (blue && !bootstrapCompanion || mode === 'archive-positive' || ['normal-full', 'normal-restart', 'normal-count162', 'normal-auto'].includes(mode)) {
    const base = path.join(checkout, normalCapture ? 'artifacts/ubuntu-portable/auto-capture-cfc1d04f'
      : 'artifacts/ubuntu-portable/reader-limited/pilot-stop-20261104');
    await mkdir(base, { recursive: true, mode: 0o700 });
    evidence = await mkdtemp(path.join(base, `${mode}-`));
  }
  const data = path.join(root, 'data/application');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const selected = await resolvePortableLinuxSession(data);
  if (mode === 'ambiguous') {
    const second = path.join(data, 'saved-00000000-0000-0000-0000-000000000001');
    await mkdir(second, { mode: 0o700 }); await prepareLinuxLoginProfile(second);
  }
  if (mode.startsWith('saved-review-')) return runSavedReviewFixture(t, mode, root, data, selected);
  const htmlSource = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.html', import.meta.url), 'utf8');
  // The existing finite fixture ends after three visible displays for this
  // case; no Reader, guard, budget or acquisition operation is substituted.
  const html = normalCapture ? htmlSource.replace('max="12" value="7"', 'max="9" value="7"') : htmlSource;
  const css = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.css', import.meta.url));
  const js = await readFile(new URL('../../poc/fixtures/reader-kindle-chrome.js', import.meta.url), 'utf8');
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (bootstrapCompanion && route === '/') res.writeHead(302, { Location: `${other}/bootstrap` }).end();
    else if (route === '/' || route === '/kindle-library') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>匿名本棚</title><a id="chooseAnonymous" ${blue ? 'target="_blank"' : ''} href="/kindle-library/manga-wr/B000TEST04${archive || normalCapture ? '?dynamic=1' : ''}">匿名試料</a>`);
    else if (route === '/kindle-library/manga-wr/B000TEST04' || bootstrapCompanion && route === '/manga/B000TEST04') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    else if (route === '/reader-kindle-chrome.css') res.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    else if (route === '/reader-kindle-chrome.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(archive || normalCapture ? js : `${js}\nnext.addEventListener('click',()=>{position.value=String(Number(position.value)+1);paint(Number(position.value));});`);
    else res.writeHead(404).end();
  });
  // Relocate the already permitted official bootstrap origin, not an unknown
  // third page. This synthetic companion makes no authentication claim.
  const otherServer = http.createServer((req, res) => bootstrapCompanion
    ? res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>匿名bootstrap</title><a id="chooseAnonymous" target="_blank" href="${origin}/manga/B000TEST04">匿名試料</a>`)
    : blue ? res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>匿名の別origin</title>')
      : res.writeHead(404).end());
  for (const instance of [server, otherServer]) await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const instance of [server, otherServer]) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
  });
  const origin = `http://127.0.0.1:${server.address().port}`, other = `http://127.0.0.1:${otherServer.address().port}`;
  const hook = new URL('./portable-limited-pilot-hook.mjs', import.meta.url).href;
  const launch = async phase => {
    const child = spawn(process.execPath, [path.join(project, 'scripts/linux-bundle-launch.mjs'), ...(['normal-count162', 'normal-auto'].includes(mode) ? ['--kindle'] : cliMode ? [mode === 'cli-kindle' ? '--kindle' : '--resume-kindle'] : mode === 'normal' || normalCapture ? [] : ['--portable-limited-pilot'])], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: `--import=${hook}`,
      KTZ_PILOT_FIXTURE_ROOT: root, KTZ_PILOT_FIXTURE_ORIGIN: origin, KTZ_PILOT_FIXTURE_OTHER: other, KTZ_PILOT_FIXTURE_MODE: mode,
      ...(phase ? { KTZ_PILOT_FIXTURE_PHASE: phase } : {}),
      ...(evidence ? { KTZ_PILOT_FIXTURE_EVIDENCE: evidence } : {}) },
    });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const terminal = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    return { output, terminal, pid: child.pid };
  };
  let first = null;
  if (['normal-restart', 'normal-auto', 'normal-result-write-fail'].includes(mode)) {
    first = await launch('first');
    assert.deepEqual(first.terminal, { code: 0, signal: null }, first.output);
    const completed = JSON.parse(await readFile(path.join(root, 'anonymous-normal-first.json'), 'utf8'));
    assert.equal(completed.completed, true, JSON.stringify(completed));
  }
  const run = await launch(first ? 'resume' : null), { terminal } = run;
  const output = (first?.output ?? '') + run.output;
  const raw = /PILOT_SECRET|private\.invalid|credential|\bError:|\n\s+at\s/.test(output);
  if (raw) t.diagnostic?.(JSON.stringify({ anonymousInjection: output.includes('anonymous_injection_missing'),
    syntax: output.includes('SyntaxError'), type: output.includes('TypeError'), module: output.includes('ERR_MODULE_NOT_FOUND'),
    invocation: output.includes('invalid_invocation'), secret: output.includes('PILOT_SECRET'),
    injectionSite: /anonymous_injection_missing:([a-z.-]+\.mjs:\d+)/.exec(output)?.[1] ?? null }));
  assert.equal(raw, false, '匿名secretとraw例外は出力しない');
  const reports = output.split('\n').filter(line => line.startsWith('KTZ_PILOT ')).map(line => JSON.parse(line.slice('KTZ_PILOT '.length)));
  let user = null;
  try { user = JSON.parse(await readFile(path.join(root, mode === 'normal' || normalCapture || cliMode ? 'anonymous-normal.json' : 'anonymous-user.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (packagedRoot && user?.completed) {
    assert.deepEqual(user.packaged, { root: packagedRoot, node: `${packagedRoot}/runtime/node`, controller: `${packagedRoot}/runtime/controller` });
  }
  const lock = await lstat(path.join(selected.root, 'owned/in-use.lock')).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  });
  const temp = await readdir(path.join(root, 'temp')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  let durableMatches = null, recordSecretAbsent = true;
  const startupDir = path.join(data, 'portable-reader-startup');
  const entries = await readdir(startupDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (entries.length === 1) {
    const rawRecord = await readFile(path.join(startupDir, entries[0], 'result.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    recordSecretAbsent = !/PILOT_SECRET|private\.invalid|credential|https?:|stack|message/.test(rawRecord);
    if (rawRecord) {
      const value = JSON.parse(rawRecord), observed = reports.find(report => report.stage === 'stopped')?.startup;
      if (value.outcome === 'failed') durableMatches = observed?.stage === value.failure?.stage
        && observed?.code === value.failure?.code && observed?.initialRejection === (value.initialRejection ?? null);
    }
  }
  const jobCount = async directory => (await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })).length;
  const result = { terminal, reports, user, lock, retainedTemp: temp.length > 0, durableMatches, recordSecretAbsent,
    standardJobs: await jobCount(path.join(data, 'jobs')), outsideJobs: await jobCount(path.join(root, 'jobs')), ...(evidence ? { evidence } : {}) };
  if (first) {
    result.restart = { first: first.terminal, distinctProcesses: first.pid !== run.pid,
      originalRun: JSON.parse(await readFile(path.join(root, 'anonymous-normal-first.json'), 'utf8')) };
  }
  if (blue || mode === 'archive-positive' || normalCapture) {
    for (const name of first ? (['normal-auto', 'normal-result-write-fail'].includes(mode) ? ['anonymous-owner-first.json'] : ['anonymous-owner-first.json', 'anonymous-owner-resume.json']) : ['anonymous-owner.json']) {
      const owners = JSON.parse(await readFile(path.join(root, name), 'utf8'));
      assert.throws(() => process.kill(owners.owner, 0), { code: 'ESRCH' });
      assert.throws(() => process.kill(-owners.browser, 0), { code: 'ESRCH' });
    }
    if (user?.completed === true && terminal.code === 0 && !terminal.signal && !result.retainedTemp && !lock) await rm(root, { recursive: true }); // Keep incomplete fixture evidence for correction.
    if (evidence) t.diagnostic(`匿名停止UI: ${evidence}; 実Kindle・本人操作は未使用`);
    else t.diagnostic('匿名bootstrap準備→明示Readerの有限PNG/Reviewの1caseのみ。実Kindle・本人操作・停止画面の追加撮影なし');
  }
  if (cliMode && user && terminal.code === 0 && !terminal.signal && !result.retainedTemp && !lock) await rm(root, { recursive: true });
  return result;
}

// 保存済み画像の操作automationだけを既存通常CLI fixtureで検査する。
// Reader・capture browserは作らない。PNGは既存Storeの匿名入力で用意する。
async function runSavedReviewFixture(t, mode, root, data, selected) {
  const { PNG } = await import('pngjs');
  const { startApplication } = await import('../../app/server.mjs');
  const { claimPortableLimitedRun } = await import('../../app/portable-limited-claim.mjs');
  const { runSavedReviewControl } = await import('../../artifacts/ubuntu-portable/reader-limited/review-saved-common-reader-20261104-a4-corrected.mjs');
  const running = await startApplication({ dataDir: data }); let job;
  try {
    job = (await running.app.store.call('create_job', { base_dir: data })).snapshot;
    await claimPortableLimitedRun(data, selected, job);
    const image = new PNG({ width: 80, height: 120 });
    for (let i = 0; i < image.data.length; i += 4) { image.data[i] = 80; image.data[i + 1] = 150; image.data[i + 2] = i % 251; image.data[i + 3] = 255; }
    const png = PNG.sync.write(image);
    await running.app.store.call('capture_start'); await running.app.store.call('capture_begin');
    await running.app.store.call('capture_chunk', { capture_id: 1, data_base64: png.toString('base64') });
    await running.app.store.call('capture_commit'); await running.app.store.call('capture_pause');
  } finally { await running.close(); }
  const files = [`${job.job_path}/manifest.json`, `${data}/portable-reader-limited-${job.manifest.job_id}.claim`, `${job.job_path}/originals/000001.png`];
  const hashes = async () => Promise.all(files.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
  const before = await hashes();
  await writeFile(`${root}/anonymous-saved-review.json`, JSON.stringify({ kind: 'anonymous-saved-review', before }), { flag: 'wx', mode: 0o600 });
  const journal = await open(`${root}/anonymous-saved-review-journal.jsonl`, 'wx', 0o600);
  const record = async value => { await journal.writeFile(JSON.stringify(value) + '\n'); await journal.sync(); };
  let control;
  try {
    await record({ phase: 'before', hashes: before });
    control = await runSavedReviewControl({ root, job: job.job_path, fixtureMode: mode, record });
  } finally { await journal.close(); }
  const after = await hashes(), tempEntries = (await readdir(`${root}/temp`)).length;
  const journalEvents = (await readFile(`${root}/anonymous-saved-review-journal.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  let witness = null;
  try { witness = JSON.parse(await readFile(`${root}/anonymous-saved-review-witness.json`, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const normalClose = control.cli.closeRequested && control.cli.terminal.exit === 0 && control.cli.terminal.signal === null;
  if (normalClose && control.helper?.terminal && !tempEntries) t.after(() => rm(root, { recursive: true }));
  return { control, before, after, journalEvents, witness, tempEntries };
}
