import { writeFile } from 'node:fs/promises';
import { manualResultFiles } from './manual-result-files.mjs';

// Measurement baseline only. The actual run is separately observed by the host.
const baseline = { schemaVersion: 1, preparedAt: new Date().toISOString(), existing: await manualResultFiles() };
await writeFile('artifacts/manual-baseline.json', JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
console.log('今回の対人試験前のレシート一覧を記録しました。まだ手動試験は開始していません。');
