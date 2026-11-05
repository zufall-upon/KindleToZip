// Anonymous-only relocation of the fixed installation and fixed Reader site.
// The product launcher, main, GUI, owner, and capture code remain the entry.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.KTZ_PILOT_FIXTURE_ROOT, origin = process.env.KTZ_PILOT_FIXTURE_ORIGIN;
const other = process.env.KTZ_PILOT_FIXTURE_OTHER, mode = process.env.KTZ_PILOT_FIXTURE_MODE;
const phase = process.env.KTZ_PILOT_FIXTURE_PHASE;
const normalCapture = mode?.startsWith('normal-');
const cliMode = mode === 'cli-kindle' || mode === 'cli-resume';
const packagedRoot = process.env.KTZ_TEST_PACKAGED_ROOT;
if (packagedRoot !== undefined && packagedRoot !== '/home/user/KTZ-Portable') throw new Error('anonymous_only');
const project = packagedRoot ?? fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const controller = packagedRoot ? path.join(project, 'runtime/controller') : path.resolve(process.env.KTZ_CONTROLLER_PATH || path.join(project, 'artifacts/rust-target/debug/ktz-g02-controller'));
if (!/^\/home\/user\/KTZRC\/pilot-20261103\/[A-Za-z0-9]{2}$/.test(root ?? '')
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? '') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(other ?? '')) throw new Error('anonymous_only');
globalThis.__pilotVerifyBundle = async value => {
  if (value !== root) throw new Error('anonymous_only');
  if (packagedRoot) {
    const { verifyBundle } = await import(pathToFileURL(path.join(project, 'scripts/linux-distribution.mjs')).href);
    await verifyBundle(project); // Verify the actual payload before relocating only anonymous data.
  }
};
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.startsWith('file:') || !url.endsWith('.mjs')) return result;
  let source = result.source.toString();
  let injectionIndex = 0;
  const replace = (needle, value) => {
    injectionIndex++;
    if (!source.includes(needle)) throw new Error(`anonymous_injection_missing:${path.basename(url)}:${injectionIndex}`);
    source = source.replace(needle, value);
  };
  if (url.endsWith('/scripts/linux-bundle-launch.mjs')) {
    replace(source.split('\n').find(line => line.startsWith('const root = fileURLToPath(')), `const root = ${JSON.stringify(root)};`);
    replace("root !== '/home/user/KTZ-Portable'", `root !== ${JSON.stringify(root)}`);
    replace('await verifyBundle(root);', 'await globalThis.__pilotVerifyBundle(root);');
    replace("path.join(root, 'runtime/controller')", JSON.stringify(controller));
    replace("path.join(root, 'artifacts/browsers')", `path.join(${JSON.stringify(project)}, 'artifacts/browsers')`);
    replace("path.join(root, 'app/main.mjs')", `path.join(${JSON.stringify(project)}, 'app/main.mjs')`);
  }
  if (url.endsWith('/app/portable-linux-site.mjs')) {
    replace("const selectedBundle = '/home/user/KTZ-Portable';", `const selectedBundle = ${JSON.stringify(root)};`);
    replace(source.split('\n').find(line => line.startsWith('const ownRoot = fileURLToPath(')), `const ownRoot = ${JSON.stringify(root)};`);
    // Historic read-only fixtures retain their anonymous-only v2 permission.
    // The new archive-positive case exercises the unmodified ticket boundary.
    if (mode !== 'archive-positive' && !normalCapture && !cliMode) replace('await consumePortableArchiveCapture(path.dirname(selected.root), job, selected.id);', '/* anonymous legacy read-only grant */');
  }
  if (mode !== 'archive-positive' && !normalCapture && !cliMode && url.endsWith('/app/main.mjs'))
    replace('portableArchiveTrial: limitedPilot', 'portableArchiveTrial: false');
  if (mode !== 'archive-positive' && !normalCapture && !cliMode && url.endsWith('/app/application.mjs')) {
    replace('limitedSite && !limited && await portableArchiveAvailable(this.dataDir, job, this.portableArchiveTrial)', 'limitedSite && !limited');
    replace("if (this.portableArchiveTrial && portableLimitedAvailable(this.dataDir) && this.portableArchiveJob !== this.job?.manifest.job_id)\n              throw new AppError('portable_postprocess_unavailable');", '/* anonymous legacy read-only grant, no archive ticket */');
    replace('const normal = portableNormalAvailable(this.dataDir) && !this.portableArchiveTrial;', 'const normal = false; // historic anonymous limited fixture');
  }
  if (mode === 'normal-bytes' && url.endsWith('/app/application.mjs')) {
    // Exercise the byte-ceiling branch without allocating 2 GiB. Only the
    // ceiling is reduced; Store, guard, PNG accounting and UI remain real.
    replace('const normalJobBytes = 2 * 1024 * 1024 * 1024;', 'const normalJobBytes = 1;');
  }
  if (mode === 'normal-result-write-fail' && url.endsWith('/app/portable-normal-job.mjs')) {
    // Fail only the terminal record; leave the real start record and capture intact.
    replace('async function writeRecord(file, value) {', "async function writeRecord(file, value) { if (file.endsWith('.stop.pending')) throw new Error('anonymous_result_write_failure');");
  }
  if (url.endsWith('/app/portable-limited-pilot.mjs')) {
    replace("const installed = '/home/user/KTZ-Portable';", `const installed = ${JSON.stringify(root)};`);
    replace(source.split('\n').find(line => line.startsWith('const ownRoot = fileURLToPath(')), `const ownRoot = ${JSON.stringify(root)};`);
    replace("waiting?.({ stage: 'waiting', code: 'user_action_required', images: 0, sends: 0, sameJob: true });",
      "waiting?.({ stage: 'waiting', code: 'user_action_required', images: 0, sends: 0, sameJob: true }); globalThis.__anonymousPilotUser?.();");
    replace("return { stage: 'archive', code: 'completed'", "await globalThis.__anonymousUserDone; return { stage: 'archive', code: 'completed'");
    replace("if (!archiveTrial) return { stage: 'review', code: 'completed'", "if (!archiveTrial) { await globalThis.__anonymousUserDone; return { stage: 'review', code: 'completed'");
    replace('previewMatches: previewDigest && value.firstDigest ? previewDigest === value.firstDigest : null };\n        if (!postprocess)', 'previewMatches: previewDigest && value.firstDigest ? previewDigest === value.firstDigest : null }; }\n        if (!postprocess)');
    if (mode === 'base-dir-race') replace("await click('create', view);",
      "await page.locator('#baseDir').fill(process.env.KTZ_PILOT_FIXTURE_ROOT); await click('create', view);");
    if (mode === 'pending-base-dir-return') replace("await click('create', view);", `
      await page.evaluate(() => {
        document.querySelector('#create').addEventListener('click', () => {
          const input = document.querySelector('#baseDir'), before = input.value;
          input.value = 'PILOT_SECRET_PENDING_BASE'; input.dispatchEvent(new Event('input', { bubbles: true }));
          input.value = before; input.dispatchEvent(new Event('input', { bubbles: true }));
        }, { once: true });
      });
      await click('create', view);
      await page.waitForFunction(() => ['cancelled', 'success', 'failure'].includes(document.querySelector('#operationStatus')?.dataset.status));
      refuse('state_changed');`);
    if (mode === 'race') replace("await click('preparePortableSession', view);", "app.invalidate('target_changed'); await click('preparePortableSession', view);");
    if (mode === 'stage-race') replace("await click('preparePortableSession', view);",
      "await page.locator('#stageTools > summary').click(); await page.locator('[data-stage-target=\"capture\"]').click(); await click('preparePortableSession', view);");
  }
  if (url.endsWith('/app/portable-reader-site.mjs')) {
    replace("'--remote-debugging-pipe'", "'--remote-debugging-pipe', '--disable-background-networking', '--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'");
  }
  if (url.endsWith('/app/portable-limited-session.mjs') || url.endsWith('/app/stores/kindle.mjs')) {
    source = source.replaceAll('https://read.amazon.co.jp', mode === 'origin' && url.endsWith('/portable-limited-session.mjs') ? other : origin);
  }
  if (mode === 'origin' && url.endsWith('/app/portable-limited-session.mjs'))
    replace('page.goto(`${origin}/`,', `page.goto(${JSON.stringify(`${origin}/`)},`);
  if (url.endsWith('/app/portable-limited-session.mjs')) {
    replace("value.protocol === 'https:'", "value.protocol === 'http:'");
    if (mode === 'blue-bootstrap-companion') {
      // Preserve the product's existing official-bootstrap exception verbatim
      // in role; relocate only its hosts to the second anonymous loopback site.
      replace("new Set(['https://www.amazon.co.jp', 'https://amazon.co.jp'])", `new Set([${JSON.stringify(other)}])`);
    }
  }
  return { ...result, source };
} });

if (/\/app\/linux-owned-reader-owner\.mjs$/.test(process.argv[1] ?? '')) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    if (executable !== '/snap/bin/chromium' || args.at(-1) !== 'about:blank' || !args.includes('--remote-debugging-pipe')
        || args.some(arg => ['--no-sandbox', '--disable-setuid-sandbox', '--password-store=basic'].includes(arg))) throw new Error('anonymous_launch_refused');
    if (mode === 'owner-unknown') throw Object.assign(new Error('PILOT_SECRET https://private.invalid/credential'), { code: 'ENOENT' });
    const child = spawn(executable, args, options);
    if (mode.startsWith('blue-') || mode === 'archive-positive' || normalCapture) fs.writeFileSync(path.join(root, phase ? `anonymous-owner-${phase}.json` : 'anonymous-owner.json'), JSON.stringify({ owner: process.pid, browser: child.pid }), { flag: 'wx', mode: 0o600 });
    return child;
  };
  syncBuiltinESMExports();
}

if (/\/scripts\/linux-bundle-launch\.mjs$/.test(process.argv[1] ?? '')) {
  // This test preloads Application to observe the anonymous GUI; bind its
  // import-time default before loading it, exactly as the real launcher does.
  process.env.KTZ_USER_DATA_DIR = path.join(root, 'data/application');
  if (mode === 'normal-resource') {
    // Fault only the filesystem capacity observation after the first commit;
    // the actual Store, owner, Reader and guard are unchanged.
    const statfs = fs.promises.statfs; let observations = 0;
    fs.promises.statfs = async (...args) => ++observations >= 3 ? { bavail: 1n, bsize: 1n } : statfs(...args);
    syncBuiltinESMExports();
  }
  if (mode === 'normal-time') {
    // Advance the monotonic elapsed observation only after a real original is
    // committed. Do not wait two hours or replace the acquisition operation.
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { value() {
      const jobs = path.join(root, 'data/application/jobs');
      const committed = fs.existsSync(jobs) && fs.readdirSync(jobs).some(id => {
        const originals = path.join(jobs, id, 'originals');
        return fs.existsSync(originals) && fs.readdirSync(originals).some(name => name.endsWith('.png'));
      });
      return now() + (committed ? 2 * 60 * 60 * 1000 : 0);
    } });
  }
  const fork = childProcess.fork;
  childProcess.fork = (file, args, options) => file.endsWith('/app/linux-owned-reader-owner.mjs')
    ? fork(file, args, { ...options, execArgv: [`--import=${import.meta.url}`] }) : fork(file, args, options);
  syncBuiltinESMExports();
  const { Application } = await import(pathToFileURL(path.join(project, 'app/application.mjs')).href);
  if (mode.startsWith('saved-review-')) {
    const command = Application.prototype.command, actions = [];
    Application.prototype.command = async function (action, ...args) {
      actions.push(action);
      const value = await command.call(this, action, ...args);
      fs.writeFileSync(path.join(root, 'anonymous-saved-review-witness.json'), JSON.stringify({
        actions, state: value.state, images: value.job?.manifest.images.length ?? 0,
        manifestState: value.job?.manifest.state, exports: value.job?.manifest.exports.length ?? 0,
        browserOpen: value.browserOpen, limited: value.portableLimitedJob,
      }), { mode: 0o600 });
      return value;
    };
  }
  const { Reader } = await import(pathToFileURL(path.join(project, 'app/reader.mjs')).href);
  const { chromium } = packagedRoot ? await import(pathToFileURL(path.join(project, 'node_modules/playwright/index.mjs')).href) : await import('playwright');
  const { withPublicDisclosures } = await import('../../poc/browser/public-ui-controls.mjs');
  let app, control;
  const blue = mode.startsWith('blue-'), scaleChecks = [];
  const snapshot = Application.prototype.snapshot;
  Application.prototype.snapshot = async function (...args) { app = this; return snapshot.apply(this, args); };
  if (mode === 'close-unknown' || mode === 'blue-close-unknown') {
    const close = Reader.prototype.close;
    Reader.prototype.close = async function (...args) { await close.apply(this, args); throw new Error('PILOT_SECRET https://private.invalid/credential'); };
  }
  if (blue) {
    const scale = Reader.prototype.setCaptureScale;
    Reader.prototype.setCaptureScale = async function (...args) {
      const selected = this.explicitPage;
      const result = await scale.apply(this, args);
      scaleChecks.push({ explicit: Boolean(selected), sameExplicit: selected === this.explicitPage,
        samePage: this.page === (selected ?? this.page), member: this.context.pages().includes(this.page),
        pages: this.context.pages().length, scale: result });
      return result;
    };
  }
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
    const browser = await launch(options), newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      context.on('page', page => {
        control = page;
        if (normalCapture) page.once('domcontentloaded', () => { void (async () => {
           const result = { completed: false, ...(packagedRoot ? { packaged: { root: project, node: process.execPath, controller } } : {}) };
          const wait = async predicate => {
            const end = Date.now() + 30_000; let state;
            do { state = await app.snapshot(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
            throw new Error(`anonymous_wait:${state?.state}:${state?.reason}`);
          };
          const command = (action, input = {}) => page.evaluate(async ({ action, input }) => {
            const response = await fetch('/api/command', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('ktzLocalUiKey')}`,
              'Content-Type': 'application/json', Origin: location.origin }, body: JSON.stringify({ action, input }) });
            return { status: response.status, body: await response.json() };
          }, { action, input });
           const call = async (action, input = {}) => {
            const value = await command(action, input);
            if (value.status !== 200) throw new Error(`anonymous_command:${action}:${value.body.code}`);
             return value.body;
           };
           const ui = withPublicDisclosures(page);
           const positiveUi = ['normal-full', 'normal-restart', 'normal-count162', 'normal-auto'].includes(mode);
           const previewThroughUi = async () => {
             // Let the public UI consume the completed stop (and its automatic
             // Review navigation) before the user explicitly returns to Capture.
             await page.waitForFunction(() => !document.querySelector('#readerTab').disabled);
             await ui.locator('[data-stage-target="capture"]').first().click();
             await ui.locator('#quickPreview').click();
             try { await page.waitForFunction(() => !document.querySelector('#approval').disabled, null, { timeout: 6000 }); }
             catch {
               const current = await app.snapshot();
               throw new Error(`anonymous_ui_preview:${JSON.stringify({ state: current.state, reason: current.reason,
                 inspection: current.displayInspection, ready: current.previewReady, message: await page.locator('#message').textContent() })}`);
             }
           };
           const approveThroughUi = async (limit, resume = false) => {
             await ui.locator('[data-stage-target="capture"]').first().click();
             await ui.locator('#maxCaptures').fill(limit === null ? '' : String(limit));
             await ui.locator('#previewConfirmed').check();
             if (resume) await ui.locator('#resumeConfirmed').check();
             await ui.locator('#approve').click();
             await wait(s => s.state === 'Ready' && !s.busy);
             await page.waitForFunction(() => !document.querySelector('#start').disabled);
             if (mode === 'normal-full') {
               for (const language of ['en', 'zh-CN', 'ja']) {
                 await ui.locator('#language').selectOption(language);
                 if (language !== 'ja' && /[ぁ-んァ-ヶ]/.test(await ui.locator('#sourceIdentity').textContent())) throw new Error('anonymous_untranslated_normal_source');
                 if (!(await ui.locator('#previewConfirmed').isChecked()) || !(await ui.locator('#start').isEnabled())) throw new Error('anonymous_language_changed_approval');
               }
             }
           };
           const screenshot = async name => {
             if (process.env.KTZ_PILOT_FIXTURE_EVIDENCE) {
               if (name.includes('approved')) await page.locator('#approval').scrollIntoViewIfNeeded();
               await page.screenshot({ path: path.join(process.env.KTZ_PILOT_FIXTURE_EVIDENCE, name) });
             }
           };
          const archiveEntries = bytes => {
            const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
            if (end < 0) throw new Error('anonymous_archive_end');
            let offset = bytes.readUInt32LE(end + 16); const output = [];
            for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
              const local = bytes.readUInt32LE(offset + 42), size = bytes.readUInt32LE(offset + 24);
              const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
              output.push(createHash('sha256').update(bytes.subarray(start, start + size)).digest('hex'));
              offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
            }
            return output;
          };
          try {
             await page.waitForFunction(() => document.querySelector('#state')?.textContent === '待機');
             const recovering = ['normal-restart', 'normal-auto', 'normal-result-write-fail'].includes(mode) && phase === 'resume';
             const previous = recovering ? JSON.parse(fs.readFileSync(path.join(root, 'anonymous-restart-state.json'), 'utf8')) : null;
              if (recovering) await call('recover', { path: previous.jobPath });
               // On Linux --kindle opens the ordinary GUI, not a job. Exercise
               // the same explicit public create action used by the caller;
               // a launch flag alone is never creation or capture consent.
              else if (mode === 'normal-count162' || mode === 'normal-auto') {
                 await page.waitForFunction(() => document.querySelector('#decisionButton')?.dataset.action === 'create'
                   && !document.querySelector('#decisionButton').disabled);
                 await ui.locator('#decisionButton').click();
                 await wait(s => Boolean(s.job) && !s.busy);
               } else await call('create');
             if (['normal-auto', 'normal-result-write-fail'].includes(mode) && recovering) {
               const recovered = await wait(s => Boolean(s.job) && !s.busy);
               await ui.locator('[data-stage-target="review"]').first().click();
               await page.waitForFunction(() => !document.querySelector('#normalCaptureResult').hidden);
               result.recovered = { result: recovered.portableNormalResult, images: recovered.job.manifest.images.length,
                 range: recovered.job.manifest.range_confirmed, ui: await page.locator('#normalCaptureResult').textContent() };
               result.completed = true;
               return;
             }
             const { resolvePortableLinuxSession } = await import(pathToFileURL(path.join(project, 'app/portable-linux-session.mjs')).href);
            const selected = await resolvePortableLinuxSession(app.dataDir);
            await call('preparePortableKindle', { session: selected.id });
            const forged = await command('openBrowser', { mode: 'kindle', session: selected.id, normal: true });
            result.forged = { status: forged.status, code: forged.body.code };
            await call('openBrowser', { mode: 'kindle', session: selected.id });
            const reader = app.reader, guard = reader.ownedSessionGuard;
            await reader.page.locator('#chooseAnonymous').click();
             await reader.page.waitForURL(`${origin}/kindle-library/manga-wr/B000TEST04?dynamic=1`);
             if (recovering) {
               await reader.page.mouse.move(20, 1);
               await reader.page.locator('#next').click(); // Anonymous user's explicit position adjustment, before preview.
               await reader.page.locator('#readerChromeTitle').waitFor({ state: 'visible' });
             }
            const tab = reader.tabs()[0];
            await call('selectReaderTab', { id: tab.id });
             if (positiveUi) await previewThroughUi();
             else await call('quickPreview', { mode: 'visible' });
             if (positiveUi) await page.waitForFunction(() => document.querySelector('#trafficNotice').textContent.includes('公式認証先')
               && !document.querySelector('#trafficNotice').textContent.includes('匿名の自作試料'));
            result.preview = { images: (await app.snapshot()).job.manifest.images.length, budget: guard.singleRunBudget.snapshot().phase };
            if (mode === 'normal-full') {
              await reader.page.locator('#readerChromeTitle').evaluate(node => { const before = node.textContent; node.textContent = '異なる匿名対象'; node.textContent = before; });
              const refused = await command('approve', { confirmed: true, maxCaptures: 2 });
              result.targetRefusal = { status: refused.status, code: refused.body.code, images: (await app.snapshot()).job.manifest.images.length };
              result.targetRefusalRecordAbsent = !fs.readdirSync(app.dataDir).some(name => name.includes('.result-'));
               await previewThroughUi();
            }
             if (mode === 'normal-restart') {
               result.resume = recovering ? (await app.snapshot()).resumePlan?.mode : null;
               await approveThroughUi(recovering ? 4 : 2, recovering);
              } else if (mode === 'normal-count162' || mode === 'normal-auto') {
                await approveThroughUi(mode === 'normal-auto' ? null : 162);
                if (mode === 'normal-auto') {
                  await ui.locator('#maxCaptures').fill('2');
                  await page.waitForFunction(() => document.querySelector('#start').disabled);
                  await ui.locator('#maxCaptures').fill('');
                  await page.waitForFunction(() => document.querySelector('#start').disabled);
                  result.changedLimitRevoked = true;
                  await approveThroughUi(null);
                }
                result.approval = { input: await ui.locator('#maxCaptures').inputValue(),
                  application: (await app.snapshot()).approvedMaxCaptures, budget: guard.singleRunBudget.snapshot().approved };
                if (mode === 'normal-auto') {
                  await page.waitForFunction(() => document.querySelector('#approvalModeStatus').textContent.includes('承認済み：自動取得'));
                  result.approvedUi = await page.locator('#approvalModeStatus').textContent();
                }
              } else await call('approve', { confirmed: true, maxCaptures: mode === 'normal-result-write-fail' ? null : mode === 'normal-unknown' ? 3 : 2 });
             let preflightClicks = 0;
             if (mode.startsWith('normal-preflight-')) {
               const click = reader.page.mouse.click.bind(reader.page.mouse);
               reader.page.mouse.click = async (...args) => { preflightClicks++; return click(...args); };
               const bound = reader.requireBound.bind(reader);
               reader.requireBound = async navigation => {
                 if (navigation && mode === 'normal-preflight-bound') throw new Error('anonymous_preflight_bound');
                 const state = await bound(navigation);
                 if (navigation && mode === 'normal-preflight-trial') {
                   const handle = await state.next.elementHandle();
                   handle.click = async options => {
                     if (options?.trial === true) throw new Error('anonymous_preflight_trial');
                     throw new Error('unexpected_nontrial_click');
                   };
                   const next = state.next;
                   state.next = new Proxy(next, { get(target, key) {
                     if (key === 'elementHandle') return async () => handle;
                     const value = Reflect.get(target, key);
                     return typeof value === 'function' ? value.bind(target) : value;
                   } });
                 }
                 return state;
               };
             } else if (mode === 'normal-unknown') {
              const click = reader.page.mouse.click.bind(reader.page.mouse);
              reader.page.mouse.click = async (...args) => { await click(...args); throw new Error('anonymous_response_loss'); };
            } else if (mode === 'normal-full') {
              // A matching-shaped guard is not the owner-minted guard. This is
              // a negative boundary probe; capture below uses the real guard.
              reader.ownedSessionGuard = { ...guard };
              const refused = await command('start', { confirmed: true });
              result.guardRefusal = { status: refused.status, code: refused.body.code, images: (await app.snapshot()).job.manifest.images.length };
              reader.ownedSessionGuard = guard;
               await previewThroughUi();
               await approveThroughUi(2);
             }
              if (positiveUi) {
               await screenshot(recovering ? 'normal-resume-approved.png' : 'normal-approved.png');
               await ui.locator('#start').click();
             } else await call('start', { confirmed: true });
            let stopped = await wait(s => ['Review', 'NeedsAttention'].includes(s.state) && !s.busy);
             result.first = { state: stopped.state, reason: stopped.reason, images: stopped.job.manifest.images.length,
               dispatch: stopped.job.manifest.checkpoint?.dispatch, range: stopped.job.manifest.range_confirmed };
             if (['normal-resource', 'normal-time', 'normal-bytes'].includes(mode)) result.stopResult = stopped.portableNormalResult;
             const original = stopped.job.manifest.images.length ? await app.image(1, true) : null;
              if (mode.startsWith('normal-preflight-')) {
                result.stopResult = stopped.portableNormalResult;
                result.preflight = { clicks: preflightClicks, originalUnchanged: original.equals(await app.image(1, true)),
                  phase: guard.singleRunBudget.snapshot().phase };
              } else if (mode === 'normal-result-write-fail') {
               result.recordFailure = { result: stopped.portableNormalResult, failure: stopped.lastFailure?.code,
                 originalUnchanged: original.equals(await app.image(1, true)) };
               fs.writeFileSync(path.join(root, 'anonymous-restart-state.json'), JSON.stringify({ jobPath: stopped.job.job_path }), { flag: 'wx', mode: 0o600 });
             } else if (mode === 'normal-bytes') {
               result.originalAbsent = stopped.job.manifest.images.length === 0;
             } else if (mode === 'normal-resource' || mode === 'normal-time') {
               result.originalUnchanged = original.equals(await app.image(1, true));
             } else if (mode === 'normal-restart' && !recovering) {
               const digests = await Promise.all([1, 2].map(async id => createHash('sha256').update(await app.image(id, true)).digest('hex')));
               fs.writeFileSync(path.join(root, 'anonymous-restart-state.json'), JSON.stringify({ jobPath: stopped.job.job_path, digests }), { flag: 'wx', mode: 0o600 });
               result.originalDigests = digests;
             } else if (mode === 'normal-unknown') {
               result.stopResult = stopped.portableNormalResult;
              await reader.page.locator('#readerChromeTitle').waitFor({ state: 'visible' });
              await call('quickPreview', { mode: 'visible' });
              const rejected = await command('approve', { confirmed: true, resumeConfirmed: true, maxCaptures: 2 });
              result.unknown = { plan: (await app.snapshot()).resumePlan?.mode, status: rejected.status, code: rejected.body.code,
                originalUnchanged: original.equals(await app.image(1, true)) };
            } else {
                if (!recovering && !['normal-count162', 'normal-auto'].includes(mode)) {
                 await previewThroughUi();
                 result.resume = (await app.snapshot()).resumePlan?.mode;
                 await approveThroughUi(4, true);
                 await ui.locator('#start').click();
                 stopped = await wait(s => ['Review', 'NeedsAttention'].includes(s.state) && !s.busy);
               }
               result.end = { state: stopped.state, reason: stopped.reason, images: stopped.job.manifest.images.length,
                  range: stopped.job.manifest.range_confirmed, sameGuard: reader.ownedSessionGuard === guard };
               if (stopped.state !== 'Review') result.stopDiagnostic = { failureCode: stopped.lastFailure?.code ?? null,
                 failureStage: stopped.lastFailure?.stage ?? null, dispatch: stopped.job.manifest.checkpoint?.dispatch ?? null,
                 budgetPhase: guard.singleRunBudget.snapshot().phase };
               if (recovering) {
                 const digests = await Promise.all([1, 2].map(async id => createHash('sha256').update(await app.image(id, true)).digest('hex')));
                 result.restartOriginalsUnchanged = JSON.stringify(digests) === JSON.stringify(previous.digests);
               }
                await ui.locator('[data-stage-target="review"]').first().click();
                await page.waitForFunction(() => document.querySelector('#images article img')?.naturalWidth > 0
                  && document.querySelector('#state').textContent === '画像点検' && !document.querySelector('#resumeCapture').disabled);
               await screenshot('normal-review.png');
              await call('review', { ids: [3, 1] });
              await call('crop', { id: 1, x: 0, y: 0, width: 300, height: 200 });
              const expected = await Promise.all([3, 1].map(async id => createHash('sha256').update(await app.image(id)).digest('hex')));
              result.archives = {};
              for (const format of ['zip', 'cbz']) {
                const destination = path.join(root, `normal-anonymous.${format}`);
                await call('export', { destination, format, rangeConfirmed: false });
                result.archives[format] = JSON.stringify(archiveEntries(fs.readFileSync(destination))) === JSON.stringify(expected);
              }
               result.originalUnchanged = original.equals(await app.image(1, true));
               if (mode === 'normal-auto') {
                 result.stopResult = (await app.snapshot()).portableNormalResult;
                 const records = fs.readdirSync(app.dataDir).filter(name => name.includes('.result-'));
                 result.recordPrivacy = records.length === 2 && records.every(name => !/PILOT_SECRET|private\.invalid|credential|https?:|stack|title/i.test(fs.readFileSync(path.join(app.dataDir, name), 'utf8')));
                 fs.writeFileSync(path.join(root, 'anonymous-restart-state.json'), JSON.stringify({ jobPath: stopped.job.job_path }), { flag: 'wx', mode: 0o600 });
               }
            }
            await call('closeBrowser');
            result.readerClosed = !app.reader && !app.readerReleasePending;
            result.noTrialMarkers = !fs.readdirSync(app.dataDir).some(name => name.endsWith('.claim') || name.endsWith('.ticket'));
            result.completed = true;
          } catch (error) { result.error = String(error?.message ?? 'anonymous_failure').replace(/https?:\/\/\S+/g, '[anonymous]'); }
          finally {
              fs.writeFileSync(path.join(root, ['normal-restart', 'normal-auto', 'normal-result-write-fail'].includes(mode) && phase === 'first' ? 'anonymous-normal-first.json' : 'anonymous-normal.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
            await page.close();
          }
        })(); });
        if (mode === 'normal' || cliMode) page.once('domcontentloaded', () => { void (async () => {
          try {
            await page.waitForFunction(() => document.querySelector('#state')?.textContent === '待機');
            const ui = withPublicDisclosures(page);
            if (!cliMode) await ui.locator('#create').click();
            const end = Date.now() + 15_000;
            let value;
            do { value = await app.snapshot(); if ((cliMode || value.job) && !value.busy) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
            fs.writeFileSync(path.join(root, 'anonymous-normal.json'), JSON.stringify({ created: Boolean(value?.job),
              images: value?.job?.manifest?.images?.length ?? 0, browser: Boolean(value?.browserOpen) }), { flag: 'wx', mode: 0o600 });
          } catch { fs.writeFileSync(path.join(root, 'anonymous-user-error'), 'anonymous_user_failed', { flag: 'wx', mode: 0o600 }); }
          finally { await page.close(); }
        })(); });
      });
      return context;
    };
    return browser;
  };
  let userDone;
  // Old failure cases now acknowledge the fixed stop screen using only the
  // normal control-window close. Their refusal/cleanup assertions stay intact.
  const hold = Application.prototype.holdPortablePilotStop;
  Application.prototype.holdPortablePilotStop = async function (...args) {
    const result = await hold.apply(this, args);
    if (!blue) void (async () => {
      await control.waitForFunction(() => document.body.dataset.portablePilotStop && document.body.dataset.portablePilotStop !== 'pending');
      await control.close();
    })();
    return result;
  };
  globalThis.__anonymousUserDone = new Promise(resolve => { userDone = resolve; });
  globalThis.__anonymousPilotUser = () => { void (async () => {
    const wait = async predicate => {
      const end = Date.now() + 30_000;
      do { const s = await app.snapshot(); if (predicate(s)) return s; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
      throw new Error('anonymous_wait_failed');
    };
    try {
      // Let the unchanged production pilot observe a genuine user-wait interval.
      await new Promise(resolve => setTimeout(resolve, 1200));
      const before = await app.snapshot(), budget = app.reader.ownedSessionGuard.singleRunBudget.snapshot();
      const result = { waiting: { selected: before.readerTabConfirmed, preview: before.previewReady,
        approved: before.previewApproved, images: before.job.manifest.images.length, sends: budget.sends } };
      if (blue) {
        const reader = app.reader, library = reader.page, context = reader.context, browser = context.browser();
        const id = app.job.manifest.job_id, claim = path.join(app.dataDir, `portable-reader-limited-${id}.claim`);
        const manifest = path.join(app.job.job_path, 'manifest.json'), claimBytes = fs.readFileSync(claim), manifestBytes = fs.readFileSync(manifest);
        const popup = library.waitForEvent('popup');
        await library.locator('#chooseAnonymous').click({ noWaitAfter: true });
        const chosen = await popup; await chosen.waitForLoadState('domcontentloaded');
        await chosen.locator('canvas').waitFor({ state: 'visible' });
        await control.waitForFunction(() => ['captureStage', 'selectReaderTab'].includes(document.querySelector('#decisionButton').dataset.action)
          && !document.querySelector('#decisionButton').disabled);
        if (await control.locator('#decisionButton').getAttribute('data-action') === 'captureStage') await control.locator('#decisionButton').click();
        const tab = reader.pageLabels.get(chosen).id;
        await control.waitForFunction(id => [...document.querySelector('#readerTab').options].some(option => option.value === id), tab);
        await control.locator('#readerTab').selectOption(tab);
        await control.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'selectReaderTab' && !document.querySelector('#decisionButton').disabled);
        await control.locator('#decisionButton').click();
        await wait(s => s.readerTabConfirmed && !s.busy);
        result.selected = { explicit: reader.explicitPage === chosen, page: reader.page === chosen, pages: context.pages().length,
          viewport: chosen.viewportSize(), scale: await chosen.evaluate(() => devicePixelRatio), requestedScale: app.job.manifest.capture_settings.capture_scale };
        if (mode === 'blue-bootstrap-companion') {
          result.preparation = { selected: reader.explicitPage === chosen && reader.page === chosen,
            selectedMember: context.pages().includes(chosen), selectedClosed: chosen.isClosed(),
            candidateCount: reader.candidatePages().length, selectedAccepted: reader.adapter.acceptsUrl(chosen.url()),
            initialAcceptedAsTarget: reader.adapter.acceptsUrl(library.url()),
            initialIsRelocatedBootstrap: new URL(library.url()).origin === other,
            selectedPublicRoute: /^\/manga\/[A-Z0-9]{10}$/.test(new URL(chosen.url()).pathname) };
          const screenshot = reader.screenshotVisibleClip.bind(reader);
          result.screenshotTargets = [];
          reader.screenshotVisibleClip = async (...args) => {
            result.screenshotTargets.push(reader.page === chosen && reader.explicitPage === chosen);
            return screenshot(...args);
          };
        } else if (mode !== 'blue-preview') {
          const extra = await context.newPage(); await extra.goto(other, { waitUntil: 'commit' }); // Controlled unknown origin; no product guard is bypassed.
        }
        await control.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'preview' && !document.querySelector('#decisionButton').disabled);
        await control.locator('#decisionButton').click();
        if (mode === 'blue-bootstrap-companion') {
          const preview = await wait(s => s.previewReady && !s.busy), guard = reader.ownedSessionGuard;
          const previewHash = createHash('sha256').update(app.previewImage).digest('hex');
          result.preview = { ready: preview.previewReady, approved: preview.previewApproved,
            images: preview.job.manifest.images.length, budget: guard.singleRunBudget.snapshot() };
          const ui = withPublicDisclosures(control);
          await ui.locator('#maxCaptures').fill('2'); await ui.locator('#previewConfirmed').check();
          await control.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'approve' && !document.querySelector('#decisionButton').disabled);
          await control.locator('#decisionButton').click();
          const approved = await wait(s => s.previewApproved && !s.busy);
          result.beforeStart = { approved: approved.previewApproved, images: approved.job.manifest.images.length,
            budget: guard.singleRunBudget.snapshot() };
          await control.waitForFunction(() => document.querySelector('#decisionButton').dataset.action === 'start' && !document.querySelector('#decisionButton').disabled);
          await control.locator('#decisionButton').click(); // A separate explicit start, never approval as start.
          const review = await wait(s => s.state === 'Review' && !s.busy);
          const originals = path.join(review.job.job_path, 'originals'), files = fs.readdirSync(originals);
          result.review = { state: review.state, images: review.job.manifest.images.length, exports: review.job.manifest.exports.length,
            budget: guard.singleRunBudget.snapshot(), firstMatches: review.job.manifest.images[0]?.sha256 === previewHash,
            pngs: files.length, pngOnly: files.every(name => name.endsWith('.png')
              && fs.readFileSync(path.join(originals, name)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))),
            firstBytesMatch: files.some(name => createHash('sha256').update(fs.readFileSync(path.join(originals, name))).digest('hex') === previewHash),
            companionStillNonTarget: reader.page === chosen && reader.explicitPage === chosen && !reader.candidatePages().includes(library) };
          result.scaleChecks = scaleChecks;
          result.claimUnchanged = claimBytes.equals(fs.readFileSync(claim));
          fs.writeFileSync(path.join(root, 'anonymous-user.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
          return; // The existing pilot alone performs its ordinary success shutdown.
        }
        if (mode === 'blue-preview') {
          const preview = await wait(s => s.previewReady && !s.busy);
          result.preview = { ready: preview.previewReady, approved: preview.previewApproved, images: preview.job.manifest.images.length };
          // A controlled post-preview document event ends this anonymous run;
          // no approval/start is exercised or invented for this UX regression.
          await library.goto(other, { waitUntil: 'commit' });
        }
        const stopped = await wait(s => s.portablePilotStop && s.portablePilotStop.readerClose !== 'pending');
        result.fixed = stopped.portablePilotStop;
        await control.waitForFunction(() => ['confirmed', 'unconfirmed'].includes(document.body.dataset.portablePilotStop));
        result.readerDisconnected = !browser.isConnected();
        result.controlAlive = !control.isClosed();
        result.disabled = await control.locator('button, input, select, textarea').evaluateAll(nodes => nodes.every(node => node.disabled));
        result.text = await control.locator('.workflow-bar').innerText();
        result.scaleChecks = scaleChecks;
        result.forbidden = [];
        for (const action of ['quickPreview', 'preview', 'selectReaderTab', 'approve', 'start', 'openBrowser', 'create', 'finishBook', 'recover', 'export']) {
          result.forbidden.push(await control.evaluate(async action => {
            const response = await fetch('/api/command', { method: 'POST', headers: { Authorization: `Bearer ${sessionStorage.getItem('ktzLocalUiKey')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input: {} }) });
            return { status: response.status, code: (await response.json()).code };
          }, action));
        }
        result.recordsUnchanged = claimBytes.equals(fs.readFileSync(claim)) && manifestBytes.equals(fs.readFileSync(manifest));
        await control.screenshot({ path: path.join(process.env.KTZ_PILOT_FIXTURE_EVIDENCE, 'stopped.png') });
        fs.writeFileSync(path.join(root, 'anonymous-user.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(path.join(process.env.KTZ_PILOT_FIXTURE_EVIDENCE, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
        if (mode === 'blue-close-unknown') process.emit('SIGINT'); // Same native signal shutdown handler; no browser kill.
        else await control.close();
        return;
      }
      await app.reader.page.locator('#chooseAnonymous').click();
      await control.waitForFunction(() => document.querySelector('#readerTab')?.options.length > 1);
      const ui = withPublicDisclosures(control);
      await ui.locator('#readerTab').selectOption({ index: 1 });
      await ui.locator('#selectReaderTab').click(); await wait(s => s.readerTabConfirmed && !s.busy);
      await ui.locator('#quickPreview').click(); await wait(s => s.previewReady && !s.busy);
      await new Promise(resolve => setTimeout(resolve, 500));
      await ui.locator('#maxCaptures').fill('2'); await ui.locator('#previewConfirmed').check();
      await ui.locator('#approve').click();
      const approved = await wait(s => s.previewApproved && !s.busy);
      const captureGuard = app.reader.ownedSessionGuard;
      result.beforeStart = { approved: approved.previewApproved, images: approved.job.manifest.images.length,
        sends: app.reader.ownedSessionGuard.singleRunBudget.snapshot().sends };
      await ui.locator('#start').click();
      const review = await wait(s => s.state === 'Review' && !s.busy);
      result.review = { images: review.job.manifest.images.length, exports: review.job.manifest.exports.length,
        sends: captureGuard.singleRunBudget.snapshot().sends };
      if (mode === 'archive-positive') {
        result.controller = app.store.child.spawnfile;
        result.editable = review.portableArchiveEditable; result.readerClosed = !review.browserOpen;
        const claimFile = path.join(app.dataDir, `portable-reader-limited-${review.job.manifest.job_id}.claim`);
        const claimBytes = fs.readFileSync(claimFile);
        const originals = review.job.manifest.images.map(i => fs.readFileSync(path.join(review.job.job_path, i.path)));
        await control.waitForFunction(() => document.body.dataset.archiveEditable === 'true' && !document.querySelector('#crop').disabled);
        await ui.locator('#images article').first().getByRole('button', { name: '原本を点検・クロップ', exact: true }).click();
        const first = review.job.manifest.images[0];
        await ui.locator('#cropX').fill('2'); await ui.locator('#cropY').fill('2');
        await ui.locator('#cropWidth').fill(String(first.width - 4)); await ui.locator('#cropHeight').fill(String(first.height - 4));
        await ui.locator('#crop').click(); await wait(s => s.job.manifest.images[0].crop && !s.busy);
        await ui.locator('#order').fill('2,1'); await ui.locator('#saveOrder').click();
        await wait(s => s.job.manifest.selected_capture_ids.join(',') === '2,1' && !s.busy);
        await ui.locator('#destination').fill(path.join(root, 'anonymous.cbz'));
        await ui.locator('#format').selectOption('cbz');
        await ui.locator('#export').click(); const saved = await wait(s => s.job.manifest.exports.length === 1 && !s.busy);
        result.saved = { exports: saved.job.manifest.exports.length, order: saved.job.manifest.selected_capture_ids,
          crop: Boolean(saved.job.manifest.images[0].crop), originalBytes: saved.job.manifest.images.every((i, index) => originals[index].equals(fs.readFileSync(path.join(saved.job.job_path, i.path)))),
          claimBytes: claimBytes.equals(fs.readFileSync(claimFile)), readerClosed: !saved.browserOpen };
        await control.waitForFunction(() => document.querySelector('#nextAction').textContent.includes('追加の取得はできません'));
        await control.screenshot({ path: path.join(process.env.KTZ_PILOT_FIXTURE_EVIDENCE, 'anonymous-archive.png') });
        fs.writeFileSync(path.join(process.env.KTZ_PILOT_FIXTURE_EVIDENCE, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      }
      fs.writeFileSync(path.join(root, 'anonymous-user.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      fs.writeFileSync(path.join(root, 'anonymous-user-error'), 'anonymous_user_failed', { flag: 'wx', mode: 0o600 });
      if (blue && process.env.KTZ_PILOT_FIXTURE_EVIDENCE) fs.writeFileSync(path.join(process.env.KTZ_PILOT_FIXTURE_EVIDENCE, 'fixture-error.json'), JSON.stringify({ message: error.message, stack: error.stack }), { flag: 'wx', mode: 0o600 });
      await control?.close();
    }
    finally { userDone(); }
  })(); };
}
