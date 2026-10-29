import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { guardExecutable } from '../poc/browser/rust-guard.mjs';

const root = fileURLToPath(new URL('../artifacts/mvp-tests/', import.meta.url));

function png(width, height, pixel) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (width * y + x) * 4;
      image.data[offset] = pixel(x, y)[0];
      image.data[offset + 1] = pixel(x, y)[1];
      image.data[offset + 2] = pixel(x, y)[2];
      image.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

function request(id, kind, payload = {}) {
  return JSON.stringify({ version: 1, id, command: { kind, ...payload } }) + '\n';
}

function run(commands) {
  const result = spawnSync(guardExecutable, [], {
    input: commands.join(''), encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined, result.error?.message);
  return result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
}

function expectOk(response) {
  assert.equal(response.ok, true, response.code);
  return response.payload;
}

function expectError(response, code) {
  assert.equal(response.ok, false);
  assert.equal(response.code, code);
}

test('送りの不明状態は送信前に永続化し再起動後も未送信へ戻さない', async t => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'advance-checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const created = expectOk(run([request(1, 'create_job', { base_dir: directory }), request(2, 'close')])[0]).snapshot;
  const image = png(80, 80, (x, y) => x > y ? [220, 120, 30] : [20, 70, 120]);
  const result = run([
    request(1, 'open_job', { path: created.job_path }), request(2, 'capture_start'), request(3, 'capture_begin'),
    request(4, 'capture_chunk', { capture_id: 1, data_base64: image.toString('base64') }),
    request(5, 'capture_commit', { position: '134' }),
    request(6, 'record_advance', { capture_id: 1, dispatch: 'sent' }),
    request(7, 'record_advance', { capture_id: 1, dispatch: 'unknown' }), request(8, 'close'),
  ]);
  expectOk(result[4]); expectError(result[5], 'invalid_advance_checkpoint'); expectOk(result[6]);
  const reopened = expectOk(run([request(1, 'open_job', { path: created.job_path }), request(2, 'close')])[0]).snapshot;
  assert.deepEqual(reopened.manifest.checkpoint, { capture_id: 1, position: '134', dispatch: 'unknown' });
  assert.equal(reopened.manifest.images.length, 1);
  assert.deepEqual(await readFile(path.join(created.job_path, 'originals/000001.png')), image);
});

function liveClient() {
  const child = spawn(guardExecutable, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stdin.on('error', () => {});
  let buffer = '';
  const waiting = [];
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', text => {
    buffer += text;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      waiting.shift()?.(JSON.parse(line));
    }
  });
  return {
    child,
    closed,
    call(id, kind, payload = {}) {
      return new Promise((resolve, reject) => {
        waiting.push(resolve);
        child.stdin.write(request(id, kind, payload), error => { if (error) reject(error); });
      });
    },
  };
}

function parseStoredZip(bytes) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = bytes.lastIndexOf(endSignature);
  assert.notEqual(endOffset, -1, 'EOCD signature exists');
  const count = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('ascii');
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: bytes.subarray(dataOffset, dataOffset + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('Rust local-store IPC: create, exclusive PNG commit, resume, review, crop and verified CBZ export', async t => {
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'local-store-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sessionPath = path.join(workspace, 'session');
  const output = path.join(workspace, 'review.cbz');
  const color = png(4, 3, (x, y) => x === 0 && y === 0 ? [0, 0, 0] : [40 + x * 20, 70 + y * 15, 150]);
  const white = png(4, 3, () => [255, 255, 255]);
  const chunks = data => {
    const result = [];
    for (let offset = 0; offset < data.length; offset += 32_768) {
      result.push(data.subarray(offset, offset + 32_768));
    }
    return result;
  };
  const commands = [
    request(1, 'job_info'),
    request(2, 'create_job', { base_dir: workspace }),
    request(3, 'create_session_directory', { path: sessionPath }),
    request(4, 'capture_start'),
  ];
  let id = 5;
  const appendCapture = (captureId, data) => {
    commands.push(request(id++, 'capture_begin'));
    for (const chunk of chunks(data)) commands.push(request(id++, 'capture_chunk', { capture_id: captureId, data_base64: chunk.toString('base64') }));
    commands.push(request(id++, 'capture_commit'));
  };
  appendCapture(1, color);
  appendCapture(2, white);
  appendCapture(3, white);
  commands.push(request(id++, 'capture_pause'));
  commands.push(request(id++, 'resume_confirm', { last_capture_id: 3, target_confirmed: true }));
  commands.push(request(id++, 'capture_start'));
  commands.push(request(id++, 'capture_stop'));
  commands.push(request(id++, 'set_review_order', { capture_ids: [3, 1] }));
  commands.push(request(id++, 'crop_image', { capture_id: 1, x: 0, y: 0, width: 1, height: 1 }));
  commands.push(request(id++, 'export', { destination: output, format: 'cbz' }));
  commands.push(request(id++, 'export', { destination: output, format: 'cbz' }));
  commands.push(request(id++, 'close_job'));
  // The job id is returned from create_job and used for a new process-style open below.
  const responses = run(commands);
  expectError(responses[0], 'job_not_open');
  const created = expectOk(responses[1]).snapshot;
  expectOk(responses[2]);
  expectOk(responses[3]);
  assert.equal(expectOk(responses[4]).capture_id, 1);
  assert.equal(expectOk(responses[6]).capture.capture_id, 1);
  assert.equal(expectOk(responses[7]).capture_id, 2);
  assert.equal(expectOk(responses[9]).capture.capture_id, 2);
  assert.equal(expectOk(responses[10]).capture_id, 3);
  const thirdCapture = expectOk(responses[12]).capture;
  assert.equal(thirdCapture.capture_id, 3);
  assert.equal(thirdCapture.blank_candidate, true);
  assert.equal(thirdCapture.duplicate_candidate, true);
  assert.equal(expectOk(responses.at(-5)).snapshot.manifest.selected_capture_ids.join(','), '3,1');
  assert.equal(expectOk(responses.at(-4)).crop.width, 1);
  const exported = expectOk(responses.at(-3)).export;
  assert.equal(exported.range_confirmed, false, 'output integrity is independent from confirmed capture range');
  assert.equal(exported.entry_count, 2);
  expectError(responses.at(-2), 'output_exists');
  await stat(sessionPath);
  const archive = await readFile(output);
  assert.equal(archive.length, exported.bytes);
  assert.equal(createHash('sha256').update(archive).digest('hex'), exported.sha256);
  const entries = parseStoredZip(archive);
  assert.deepEqual(entries.map(entry => entry.name), ['000001.png', '000002.png']);
  const exportedWhite = PNG.sync.read(entries[0].data);
  const exportedCrop = PNG.sync.read(entries[1].data);
  assert.deepEqual([[exportedWhite.width, exportedWhite.height], [exportedCrop.width, exportedCrop.height]], [[4, 3], [1, 1]]);
  assert.deepEqual([...exportedWhite.data.subarray(0, 3)], [255, 255, 255]);
  assert.deepEqual([...exportedCrop.data.subarray(0, 3)], [0, 0, 0], 'a deliberately selected black crop remains exportable');
  const original = await readFile(path.join(created.job_path, 'originals', '000001.png'));
  assert.deepEqual(original, color, 'crop and export leave the confirmed original PNG unchanged');
  assert.equal(created.manifest.schema_version, 1);
  const reopen = run([
    request(1, 'open_job', { path: created.job_path }),
    request(2, 'job_info'),
    request(3, 'close_job'),
  ]);
  const reopened = expectOk(reopen[0]).snapshot;
  assert.equal(reopened.manifest.state, 'review');
  assert.deepEqual(reopened.manifest.selected_capture_ids, [3, 1]);
  assert.deepEqual(reopened.manifest.excluded_capture_ids, [2]);
  assert.equal(reopened.manifest.images.length, 3, 'excluded and duplicate images remain stored');
  assert.equal(createHash('sha256').update(original).digest('hex'), reopened.manifest.images[0].sha256);
  assert.equal(reopened.manifest.exports.length, 1);
  assert.equal(expectOk(reopen[1]).snapshot.issues.length, 0);
  expectOk(reopen[2]);
});

test('Rust local-store IPC: split spread preserves deliberate black crops and remains editable after a rejected narrow crop', async t => {
  for (const rejectNarrowFirst of [false, true]) await t.test(rejectNarrowFirst ? '幅1拒否後の再編集' : '本人指定の黒いクロップ', async t => {
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(path.join(root, 'split-crop-contract-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const original = png(4, 2, x => x < 2 ? [0, 0, 0] : [100, 150, 200]);
    let id = 0;
    const commands = [];
    const add = (kind, payload = {}) => { commands.push(request(++id, kind, payload)); return commands.length - 1; };
    const create = add('create_job', { base_dir: workspace });
    add('set_capture_settings', { capture_settings: { capture_scale: 1, page_output_mode: 'split_spread', reading_direction: 'right_to_left' } });
    add('capture_start'); add('capture_begin');
    add('capture_chunk', { capture_id: 1, data_base64: original.toString('base64') }); add('capture_commit');
    add('capture_stop'); add('set_review_order', { capture_ids: [1] });
    const before = add('job_info');
    let narrow, afterNarrow;
    if (rejectNarrowFirst) {
      narrow = add('crop_image', { capture_id: 1, x: 0, y: 0, width: 1, height: 2 });
      afterNarrow = add('job_info');
    }
    const crop = add('crop_image', { capture_id: 1, x: 0, y: 0, width: 2, height: 2 });
    const cropped = add('job_info');
    const zipPath = path.join(workspace, 'black-split.zip'), cbzPath = path.join(workspace, 'black-split.cbz');
    const zip = add('export', { destination: zipPath, format: 'zip' });
    const cbz = add('export', { destination: cbzPath, format: 'cbz' });
    const reset = add('crop_image', { capture_id: 1, x: 0, y: 0, width: 4, height: 2 });
    const afterReset = add('job_info'); add('close_job');
    const responses = run(commands);
    const created = expectOk(responses[create]).snapshot;
    const initial = expectOk(responses[before]).snapshot;
    if (rejectNarrowFirst) {
      expectError(responses[narrow], 'spread_width_too_small');
      const rejected = expectOk(responses[afterNarrow]).snapshot;
      assert.deepEqual(rejected.manifest, initial.manifest, '拒否した編集は設定・採用順・出力情報を変更しない');
      assert.deepEqual(rejected.orphan_files, [], '分割不可能な幅では派生ファイルを作らない');
    }
    assert.equal(expectOk(responses[crop]).crop.width, 2, '単一画像と同様、本人指定の黒い派生クロップを受理する');
    const image = expectOk(responses[cropped]).snapshot.manifest.images[0];
    assert.equal(image.split.first_page, 'right');
    assert.deepEqual([image.split.left.width, image.split.right.width, image.split.source_width], [1, 1, 2]);
    for (const side of ['left', 'right']) {
      const page = PNG.sync.read(await readFile(path.join(created.job_path, image.split[side].path)));
      assert.deepEqual([page.width, page.height, ...page.data.subarray(0, 3)], [1, 2, 0, 0, 0]);
    }
    for (const [index, output] of [[zip, zipPath], [cbz, cbzPath]]) {
      assert.equal(expectOk(responses[index]).export.entry_count, 2);
      const entries = parseStoredZip(await readFile(output));
      assert.deepEqual(entries.map(entry => entry.name), ['000001.png', '000002.png']);
      for (const entry of entries) {
        const page = PNG.sync.read(entry.data);
        assert.deepEqual([page.width, page.height, ...page.data.subarray(0, 3)], [1, 2, 0, 0, 0]);
      }
    }
    assert.equal(expectOk(responses[reset]).crop.width, 4, '失敗や黒いクロップの後も全原寸へ戻せる');
    assert.deepEqual(expectOk(responses[afterReset]).snapshot.issues, []);
    assert.deepEqual(await readFile(path.join(created.job_path, 'originals/000001.png')), original);
    const reopened = expectOk(run([request(1, 'open_job', { path: created.job_path }), request(2, 'close_job')])[0]).snapshot;
    assert.deepEqual(reopened.issues, []);
    assert.equal(reopened.manifest.images[0].split.source_width, 4);
    assert.equal(reopened.manifest.exports.length, 2);
  });
});

test('Rust local-store IPC: 自動余白候補は非破壊で古い候補を拒否しページ順を保持する', async t => {
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'auto-margin-contract-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const client = liveClient(); let seq = 0;
  t.after(async () => { client.child.kill(); await client.closed; });
  const call = (kind, payload = {}) => client.call(++seq, kind, payload);
  const created = expectOk(await call('create_job', { base_dir: workspace })).snapshot;
  const images = [255, 0, 128].map(background => png(100, 100, (x, y) =>
    x >= 20 && x < 80 && y >= 20 && y < 80 ? [90, 130, 170] : [background, background, background]));
  expectOk(await call('capture_start'));
  for (const [index, bytes] of images.entries()) {
    expectOk(await call('capture_begin'));
    expectOk(await call('capture_chunk', { capture_id: index + 1, data_base64: bytes.toString('base64') }));
    expectOk(await call('capture_commit'));
  }
  expectOk(await call('capture_stop')); expectOk(await call('set_review_order', { capture_ids: [2, 1] }));
  expectOk(await call('set_page_layout', { capture_id: 1, mode: 'split_spread', first_page: 'left' }));
  const before = expectOk(await call('job_info')).snapshot.manifest;
  const old = expectOk(await call('suggest_margin_crop', { capture_id: 1 })).candidate;
  assert.deepEqual(old.rect, { x: 18, y: 18, width: 64, height: 64 });
  assert.deepEqual(expectOk(await call('job_info')).snapshot.manifest, before, '候補は永続化しない');
  assert.deepEqual(expectOk(await call('suggest_margin_crop', { capture_id: 2 })).candidate.rect, old.rect);
  assert.equal(expectOk(await call('suggest_margin_crop', { capture_id: 3 })).candidate, null, '灰色の背景は余白として除去しない');
  expectError(await call('suggest_margin_crop', { capture_id: 999 }), 'capture_not_found');
  assert.deepEqual(expectOk(await call('job_info')).snapshot.manifest, before, '候補なし・失敗でも原本と保存状態を保持');
  expectOk(await call('crop_image', { capture_id: 2, x: 5, y: 5, width: 90, height: 90 }));
  const resetCandidate = expectOk(await call('suggest_margin_crop', { capture_id: 2 })).candidate;
  const beforeReset = expectOk(await call('job_info')).snapshot.manifest;
  expectOk(await call('reset_crop', { capture_id: 2 }));
  const reset = expectOk(await call('job_info')).snapshot.manifest;
  assert.equal(reset.next_render_version, beforeReset.next_render_version, '単ページの原寸復帰は描画版を進めない');
  expectError(await call('apply_margin_crop', { candidate: resetCandidate }), 'auto_crop_stale');
  assert.deepEqual(expectOk(await call('job_info')).snapshot.manifest, reset, '原寸復帰前の候補を拒否');
  expectOk(await call('crop_image', { capture_id: 1, x: 5, y: 5, width: 90, height: 90 }));
  const manual = expectOk(await call('job_info')).snapshot.manifest;
  expectError(await call('apply_margin_crop', { candidate: old }), 'auto_crop_stale');
  assert.deepEqual(expectOk(await call('job_info')).snapshot.manifest, manual, '古い候補は手動クロップを壊さない');
  const candidate = expectOk(await call('suggest_margin_crop', { capture_id: 1 })).candidate;
  expectError(await call('apply_margin_crop', { candidate: { ...candidate, job_id: 'other-job' } }), 'auto_crop_stale');
  expectOk(await call('apply_margin_crop', { candidate }));
  let saved = expectOk(await call('job_info')).snapshot;
  assert.deepEqual(saved.manifest.selected_capture_ids, [2, 1]);
  assert.equal(saved.manifest.images[0].split.first_page, 'left');
  assert.deepEqual([saved.manifest.images[0].split.left.width, saved.manifest.images[0].split.right.width], [32, 32]);
  const output = path.join(workspace, 'auto-margin.zip');
  expectOk(await call('export', { destination: output, format: 'zip' }));
  const pages = parseStoredZip(await readFile(output));
  assert.deepEqual(pages.map(page => page.name), ['000001.png', '000002.png', '000003.png']);
  assert.deepEqual(pages.map(page => { const p = PNG.sync.read(page.data); return [p.width, p.height]; }), [[100, 100], [32, 64], [32, 64]]);
  assert.deepEqual(await readFile(path.join(created.job_path, 'originals', '000001.png')), images[0]);
  expectOk(await call('reset_crop', { capture_id: 1 }));
  saved = expectOk(await call('job_info')).snapshot;
  assert.equal(saved.manifest.images[0].crop, null); assert.equal(saved.manifest.images[0].split.first_page, 'left');
  expectOk(await call('close_job'));
  saved = expectOk(await call('open_job', { path: created.job_path })).snapshot;
  assert.deepEqual(saved.issues, []); assert.deepEqual(saved.manifest.selected_capture_ids, [2, 1]);
  assert.deepEqual(await readFile(path.join(created.job_path, 'originals', '000001.png')), images[0]);
  expectOk(await call('close'));
});

test('Rust local-store IPC: legacy committed dark originals remain resumable, editable and exportable under stricter new capture checks', async t => {
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'legacy-dark-original-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const created = expectOk(run([request(1, 'create_job', { base_dir: workspace }), request(2, 'close_job')])[0]).snapshot;
  // This 99.6%-black PNG was accepted by the previous 99.9% capture policy.
  // Reconstruct its schema-1 committed record without relying on an old EXE.
  const original = png(1000, 1, x => x < 996 ? [0, 0, 0] : [200, 200, 200]);
  const manifest = created.manifest;
  delete manifest.capture_settings;
  manifest.state = 'paused'; manifest.next_capture_id = 2; manifest.last_capture_id = 1;
  manifest.images = [{ capture_id: 1, path: 'originals/000001.png', width: 1000, height: 1, bytes: original.length,
    sha256: createHash('sha256').update(original).digest('hex'), captured_at_ms: manifest.created_at_ms,
    blank_candidate: false, duplicate_candidate: false, crop: null }];
  manifest.selected_capture_ids = [1];
  await writeFile(path.join(created.job_path, 'originals/000001.png'), original, { flag: 'wx' });
  await writeFile(path.join(created.job_path, 'manifest.json'), JSON.stringify(manifest));
  const zipPath = path.join(workspace, 'legacy.zip'), cbzPath = path.join(workspace, 'legacy.cbz');
  const responses = run([
    request(1, 'open_job', { path: created.job_path }),
    request(2, 'resume_confirm', { last_capture_id: 1, target_confirmed: true }),
    request(3, 'capture_start'), request(4, 'capture_begin'),
    request(5, 'capture_chunk', { capture_id: 2, data_base64: original.toString('base64') }),
    request(6, 'capture_commit'), request(7, 'capture_abort'), request(8, 'capture_stop'),
    request(9, 'set_review_order', { capture_ids: [1] }),
    request(10, 'export', { destination: zipPath, format: 'zip' }),
    request(11, 'export', { destination: cbzPath, format: 'cbz' }),
    request(12, 'crop_image', { capture_id: 1, x: 995, y: 0, width: 5, height: 1 }),
    request(13, 'job_info'), request(14, 'close_job'),
  ]);
  const reopened = expectOk(responses[0]).snapshot;
  assert.deepEqual(reopened.issues, [], '新規撮影の閾値変更で確定済み原本を不整合にしない');
  assert.equal(reopened.manifest.capture_settings.capture_scale, 1);
  expectOk(responses[1]); expectOk(responses[2]); expectOk(responses[3]); expectOk(responses[4]);
  expectError(responses[5], 'black_image');
  expectOk(responses[6]); expectOk(responses[7]); expectOk(responses[8]);
  for (const [response, output] of [[responses[9], zipPath], [responses[10], cbzPath]]) {
    assert.equal(expectOk(response).export.entry_count, 1);
    assert.deepEqual(parseStoredZip(await readFile(output))[0].data, original);
  }
  assert.equal(expectOk(responses[11]).crop.width, 5);
  assert.deepEqual(expectOk(responses[12]).snapshot.issues, []);
  assert.deepEqual(await readFile(path.join(created.job_path, 'originals/000001.png')), original);
  await t.test('旧split原本の再判定も新規取得ではなく既存保存の黒閾値を使う', async () => {
    const sides = {};
    for (const [side, start] of [['left', 0], ['right', 500]]) {
      const bytes = png(500, 1, x => x + start < 996 ? [0, 0, 0] : [200, 200, 200]);
      const relative = `rendered/000001-v20-${side}.png`;
      await writeFile(path.join(created.job_path, relative), bytes, { flag: 'wx' });
      sides[side] = { path: relative, width: 500, height: 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    manifest.images[0].split = { version: 20, source_width: 1000, source_height: 1,
      source_sha256: manifest.images[0].sha256, boundary_x: 500, first_page: 'right', ...sides };
    manifest.next_render_version = 21;
    await writeFile(path.join(created.job_path, 'manifest.json'), JSON.stringify(manifest));
    const output = path.join(workspace, 'legacy-split.zip');
    const results = run([request(1, 'open_job', { path: created.job_path }), request(2, 'export', { destination: output, format: 'zip' }), request(3, 'close_job')]);
    assert.deepEqual(expectOk(results[0]).snapshot.issues, []);
    assert.equal(expectOk(results[1]).export.entry_count, 2);
    assert.deepEqual(await readFile(path.join(created.job_path, 'originals/000001.png')), original);
  });
});

test('Rust local-store IPC: black PNG is rejected, retained pending for explicit abort, and never counted as committed', async t => {
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'black-image-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const black = png(2, 2, () => [0, 0, 0]);
  const commands = [
    request(1, 'create_job', { base_dir: workspace }),
    request(2, 'capture_start'),
    request(3, 'capture_begin'),
    request(4, 'capture_chunk', { capture_id: 1, data_base64: black.toString('base64') }),
    request(5, 'capture_commit'),
    request(6, 'job_info'),
    request(7, 'capture_abort'),
    request(8, 'resume_confirm', { last_capture_id: null, target_confirmed: true }),
    request(9, 'close_job'),
  ];
  const responses = run(commands);
  const job = expectOk(responses[0]).snapshot.job_path;
  expectOk(responses[1]);
  assert.equal(expectOk(responses[2]).capture_id, 1);
  expectOk(responses[3]);
  expectError(responses[4], 'black_image');
  const attention = expectOk(responses[5]).snapshot;
  assert.equal(attention.manifest.state, 'needs_attention');
  assert.equal(attention.manifest.images.length, 0);
  assert.deepEqual(attention.orphan_files, ['pending/000001.upload']);
  expectOk(responses[6]);
  assert.equal(expectOk(responses[7]).state, 'ready');
  expectOk(responses[8]);
  assert.ok(job);
});

test('Rust local-store IPC: killed child reopens as interrupted and keeps uncommitted PNG as a visible orphan', async t => {
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'crash-recovery-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const client = liveClient();
  const created = expectOk(await client.call(1, 'create_job', { base_dir: workspace })).snapshot;
  expectOk(await client.call(2, 'capture_start'));
  const pending = expectOk(await client.call(3, 'capture_begin')).capture_id;
  const data = png(3, 2, (x, y) => [40 + x, 80 + y, 130]);
  expectOk(await client.call(4, 'capture_chunk', { capture_id: pending, data_base64: data.toString('base64') }));
  client.child.kill();
  await client.closed;

  const reopened = run([
    request(1, 'open_job', { path: created.job_path }),
    request(2, 'job_info'),
    request(3, 'close_job'),
  ]);
  const snapshot = expectOk(reopened[0]).snapshot;
  assert.equal(snapshot.manifest.state, 'interrupted');
  assert.equal(snapshot.manifest.images.length, 0);
  assert.equal(snapshot.resume_check_required, true);
  assert.deepEqual(snapshot.orphan_files, ['pending/000001.upload']);
  assert.equal(expectOk(reopened[1]).snapshot.issues.length, 0);
  expectOk(reopened[2]);
});
