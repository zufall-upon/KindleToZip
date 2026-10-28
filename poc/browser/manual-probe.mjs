import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SampleProbe } from './probe.mjs';
import { RustGuard, GuardedSample } from './rust-guard.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--armed') {
  console.error('人の参加が必要です。手動試験票を読み、別アプリでダミー入力できる時だけ npm run poc:manual -- --armed を起動してください。');
  process.exit(2);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summarize = observation => Object.fromEntries(Object.entries(observation).filter(([key]) => !['initial', 'last'].includes(key)));
const guard = new RustGuard();
let sample;
const result = {
  schemaVersion: 1, scope: 'self-authored-manual-trial', captures: [], advances: [],
  humanAssessment: 'pending', actualHumanActions: 'not-observed-by-software',
  kindle: 'not-tested', termination: 'not-started',
};
try {
  sample = await SampleProbe.open({ headless: false });
  const session = await sample.browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  await session.detach();
  const pid = processInfo.find(process => process.type === 'browser').id;
  const { window } = await guard.request({ kind: 'window_for_process', pid });
  if (!window || window.minimized) throw new Error('window_not_available');
  const bridge = new GuardedSample(sample, guard);
  bridge.requireVisibleWindow(pid);
  await bridge.approveAndStart();
  console.log('自作試料を表示しました。15秒後に測定を開始します。別アプリでこのウィンドウを覆い、個人情報のないダミー入力・クリック・切替を続けてください。前面化やOS入力は自動送信しません。');
  await sleep(15_000);
  const { snapshot } = await guard.request({ kind: 'snapshot' });
  if (snapshot.foreground === window.handle || snapshot.foreground === 0 || !snapshot.cursor_valid) {
    result.termination = 'background_precondition_not_met';
    process.exitCode = 1;
  } else {
    for (let screen = 1; screen <= 12; screen += 1) {
      await guard.request({ kind: 'observe_start' });
      await sleep(1000);
      const image = await bridge.capture();
      result.captures.push({ position: image.position, ...summarize((await guard.request({ kind: 'observe_stop' })).observation) });
      await guard.request({ kind: 'observe_start' });
      await sleep(1000);
      const advance = await bridge.advance();
      result.advances.push({ ...advance, ...summarize((await guard.request({ kind: 'observe_stop' })).observation) });
    }
    result.termination = 'end_candidate';
    console.log('自作12画面の測定終了。意図しない前景・カーソル移動・誤入力の有無は実施者の報告待ちです。自動的にAT01合格にはしません。');
  }
} catch {
  result.termination = 'operation_failed';
  console.error('手動試料試験を停止しました。AT01合格とは扱いません。');
  process.exitCode = 1;
} finally {
  if (sample) {
    try {
      await writeFile(path.join(sample.directory, 'manual-receipt.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    } finally {
      await sample.close();
      await guard.close();
    }
  } else { await guard.close(); }
}
