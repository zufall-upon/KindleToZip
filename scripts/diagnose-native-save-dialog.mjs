// Manual, dependency-free hosted diagnostic. This is not a substitute for the
// mandatory source/release workflows and never opens a reader or real book.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

test('owned native save dialogs: first-use readiness and exact Unicode selection', async t => {
  const root = path.resolve('artifacts/native-dialog-diagnostics');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'anonymous-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile('app/save-dialog.ps1', 'utf8');
  const declaration = '$dialog = [System.Windows.Forms.SaveFileDialog]::new()';
  assert.equal(source.split(declaration).length, 2);
  for (const style of ['classic', 'default']) {
    const script = path.join(directory, `${style}.ps1`);
    await writeFile(script, style === 'classic' ? source.replace(declaration, `${declaration}\n$dialog.AutoUpgradeEnabled = $false`) : source);
    for (const action of ['cancel', 'select']) await t.test(`${style}/${action}`, async t => {
      const host = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '';
      host.stdout.setEncoding('utf8'); host.stdout.on('data', chunk => { output += chunk; });
      host.stderr.setEncoding('utf8'); host.stderr.on('data', chunk => { errors += chunk; });
      const finished = new Promise((resolve, reject) => { host.once('error', reject); host.once('close', resolve); });
      t.after(async () => { if (host.exitCode === null) host.kill(); await finished; });
      const initial = path.join(directory, '匿名保存試料 第１巻.zip');
      const destination = path.join(directory, '本人が選んだ匿名名.zip');
      host.stdin.end(JSON.stringify({ destination: initial, format: 'zip' }) + '\n');
      const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-File', 'scripts/drive-owned-save-dialog.ps1',
        '-OwnerPid', String(process.pid), '-Action', action, '-Destination', destination], { timeout: 45000, encoding: 'utf8' });
      t.diagnostic(stdout.trim());
      assert.equal(await finished, 0, errors);
      const selected = JSON.parse(output.trim());
      t.diagnostic(JSON.stringify({ selected, expected: action === 'select' ? destination : null }));
      assert.equal(selected, action === 'select' ? destination : null);
      await assert.rejects(stat(destination), { code: 'ENOENT' });
    });
  }
});
