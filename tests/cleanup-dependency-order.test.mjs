import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createControlFirstCleanup } from './support/owned-control-cleanup.mjs';

test('所有cleanup: control完了→application完了→fixture削除を直列に待つ', async () => {
  const order = []; let releaseControl, releaseRunning;
  const control = new Promise(resolve => { releaseControl = resolve; });
  const running = new Promise(resolve => { releaseRunning = resolve; });
  const cleanup = createControlFirstCleanup({
    closeControl: async () => { order.push('control.start'); await control; order.push('control.end'); },
    closeRunning: async () => { order.push('running.start'); await running; order.push('running.end'); },
    removeFixture: async () => { order.push('remove'); },
  });
  const first = cleanup(); assert.equal(cleanup(), first); assert.deepEqual(order, ['control.start']);
  releaseControl(); await control; await Promise.resolve();
  assert.deepEqual(order, ['control.start', 'control.end', 'running.start']);
  releaseRunning(); await first;
  assert.deepEqual(order, ['control.start', 'control.end', 'running.start', 'running.end', 'remove']);
});

test('所有cleanup: 各終了失敗を保持し不確実なfixtureを削除しない', async t => {
  for (const failed of ['control', 'running', 'remove']) await t.test(failed, async () => {
    const error = new Error(failed), calls = [];
    const operation = name => async () => { calls.push(name); if (name === failed) throw error; };
    const cleanup = createControlFirstCleanup({ closeControl: operation('control'), closeRunning: operation('running'), removeFixture: operation('remove') });
    await assert.rejects(cleanup(), value => value === error);
    await assert.rejects(cleanup(), value => value === error);
    assert.deepEqual(calls, failed === 'remove' ? ['control', 'running', 'remove'] : ['control', 'running']);
  });
});

test('所有cleanup: 本文と複数終了エラーのidentityを同時に保持する', async () => {
  const body = new Error('body'), control = new Error('control'), running = new Error('running'); let removed = false;
  const cleanup = createControlFirstCleanup({ closeControl: async () => { throw control; }, closeRunning: async () => { throw running; },
    removeFixture: async () => { removed = true; }, bodyFailure: () => ({ error: body }) });
  await assert.rejects(cleanup(), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [body, control, running]);
    assert.equal(error.cause, body); return true;
  });
  assert.equal(removed, false);
});

test('所有cleanup: 本文assert失敗もcontrol生成前失敗もnative FAILと正当cleanupを維持', () => {
  const helper = new URL('./support/owned-control-cleanup.mjs', import.meta.url).href;
  for (const [created, failClose] of [[true, false], [false, false], [true, true]]) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const source = `import test from 'node:test';import assert from 'node:assert/strict';
      import {createControlFirstCleanup} from ${JSON.stringify(helper)};
      const calls=[];let bodyFailure;const closeError=new Error('close-marker');
      process.once('exit',()=>console.log('CLEANUP_ORDER:'+JSON.stringify(calls)));
      test('body-fails',async t=>{const cleanup=createControlFirstCleanup({
        closeControl:async()=>{if(${created}){calls.push('control');if(${failClose})throw closeError;}},
        closeRunning:async()=>{calls.push('running');},removeFixture:async()=>{calls.push('remove');},bodyFailure:()=>bodyFailure});
        t.after(async()=>{try{await cleanup();}catch(e){console.log('BOTH_ERRORS:'+JSON.stringify({body:e.cause===bodyFailure.error,close:e.errors.includes(closeError)}));throw e;}});
        try{assert.fail('body-marker');}catch(error){bodyFailure={error};throw error;}});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env, timeout: 5000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 1);
    assert.match(child.stdout, /# fail 1/); assert.match(child.stdout, /body-marker/);
    const line = child.stdout.split('\n').find(line => line.startsWith('CLEANUP_ORDER:'));
    assert.deepEqual(JSON.parse(line.slice('CLEANUP_ORDER:'.length)), failClose ? ['control', 'running'] : created ? ['control', 'running', 'remove'] : ['running', 'remove']);
    if (failClose) assert.match(child.stdout, /BOTH_ERRORS:\{"body":true,"close":true\}/);
  }
});

test('実control caller: 再closeは同promiseであり拒否も同じまま', async () => {
  const { chromium } = await import('playwright');
  const { openControlWindow } = await import('../app/control-window.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launch');
  try {
    for (const reject of [false, true]) {
      let finish, calls = 0;
      const closePromise = new Promise((resolve, fail) => { finish = reject ? fail : resolve; });
      const page = { on() {}, once() {}, async goto() {} };
      const context = { async route() {}, async newPage() { return page; } };
      const browser = { async newContext() { return context; }, close() { calls++; return closePromise; } };
      Object.defineProperty(chromium, 'launch', { value: async () => browser, configurable: true, writable: true });
      const control = await openControlWindow(`http://127.0.0.1:4321/#${'a'.repeat(64)}`, { headless: true });
      const first = control.close(); assert.equal(control.close(), first); assert.equal(first, closePromise); assert.equal(calls, 1);
      const error = new Error('close-rejection'); finish(reject ? error : undefined);
      if (reject) await assert.rejects(first, value => value === error); else await first;
      assert.equal(control.close(), first); assert.equal(calls, 1);
    }
  } finally { if (before) Object.defineProperty(chromium, 'launch', before); else delete chromium.launch; }
});

test('実control caller: 初期化途中のclose失敗を未生成の正常終了とせずfixtureを保持する', async () => {
  const { chromium } = await import('playwright');
  const { openControlWindow } = await import('../app/control-window.mjs');
  const before = Object.getOwnPropertyDescriptor(chromium, 'launch');
  const initializationError = new Error('control-initialization-marker'), closeError = new Error('partial-close-marker');
  const calls = []; let control, controlFailure, bodyFailure, missingCloseCalls = 0;
  try {
    const page = { on() {}, async goto() { calls.push('goto'); throw initializationError; } };
    const context = { async route() {}, async newPage() { return page; } };
    const browser = { async newContext() { return context; }, async close() { calls.push('browser.close'); throw closeError; } };
    Object.defineProperty(chromium, 'launch', { value: async () => browser, configurable: true, writable: true });
    const cleanup = createControlFirstCleanup({
      closeControl: () => { missingCloseCalls++; return control ? control.close() : undefined; },
      closeRunning: async () => { calls.push('running.close'); },
      removeFixture: async () => { calls.push('fixture.remove'); },
      controlFailure: () => controlFailure, bodyFailure: () => bodyFailure,
    });
    try { control = await openControlWindow(`http://127.0.0.1:4321/#${'a'.repeat(64)}`, { headless: true }); }
    catch (error) { controlFailure = { error }; bodyFailure = { error }; }
    assert.equal(control, undefined); assert.equal(bodyFailure.error, closeError);
    await assert.rejects(cleanup(), error => error === closeError);
    await assert.rejects(cleanup(), error => error === closeError);
    assert.equal(missingCloseCalls, 0);
    assert.deepEqual(calls, ['goto', 'browser.close', 'running.close']);
  } finally { if (before) Object.defineProperty(chromium, 'launch', before); else delete chromium.launch; }
});
