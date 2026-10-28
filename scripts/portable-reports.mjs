import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Accept historical flat reports and new immutable build directories only.
export async function selectLatestPortable(root) {
  const releases = path.join(root, 'artifacts/releases');
  const reports = [];
  for (const entry of await readdir(releases, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) reports.push(path.join(releases, entry.name));
    else if (entry.isDirectory() && /^build-[\w-]+$/.test(entry.name)) {
      reports.push(path.join(releases, entry.name, 'KindleToZip-Portable.json'));
    }
  }
  const candidates = [];
  for (const reportPath of reports) {
    let report;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch { continue; }
    if (report.portable !== true || typeof report.executablePath !== 'string') continue;
    const executable = path.resolve(root, report.executablePath);
    if (path.dirname(executable) !== path.dirname(reportPath) || path.basename(executable) !== report.executable) continue;
    candidates.push({ executable, report, reportPath });
  }
  candidates.sort((a, b) => String(b.report.createdAtUtc).localeCompare(String(a.report.createdAtUtc)));
  if (!candidates.length) throw new Error('No build report with portable=true was found. Build a Portable EXE first.');
  return candidates[0];
}
