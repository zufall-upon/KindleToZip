import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SampleProbe } from './probe.mjs';

// Developer-only explicit invocation; not a production user's consent UI.
const probe = await SampleProbe.open();
try {
  await probe.preview();
  probe.approvePreview(true);
  await probe.start(true);
  for (let screen = 1; screen <= 12; screen += 1) {
    await probe.capture();
    const result = await probe.advance();
    if (result.endCandidate) break;
  }
  await writeFile(path.join(probe.directory, 'receipt.json'), `${JSON.stringify(probe.receipt(), null, 2)}\n`, { flag: 'wx' });
  console.log('自作12画面の試験終了。終端は候補のまま確認待ち。Kindle・Windows非干渉受入は未確認。');
  console.log(JSON.stringify(probe.receipt()));
} catch {
  console.error('試料試験が停止しました。完成・取得成功とは扱いません。');
  process.exitCode = 1;
} finally {
  await probe.close();
}
