import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { selectLatestPortable } from '../scripts/portable-reports.mjs';

test('Portable準備: Windowsのheaded引数とアプリ・lockfile・launcherの版を一致させる', async () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /^\s+node scripts\/install-browser\.mjs --headed\s*$/m, 'npm.ps1を経由せずheaded引数を渡す');
    assert.doesNotMatch(source, /npm run browser:install -- --headed/);
  }
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const launcher = await readFile('poc/launcher/Cargo.toml', 'utf8');
  const launcherLock = await readFile('poc/launcher/Cargo.lock', 'utf8');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(/^version = "([^"]+)"$/m.exec(launcher)[1], pkg.version);
  assert.equal(/name = "kindle-to-zip-launcher"\r?\nversion = "([^"]+)"/.exec(launcherLock)[1], pkg.version);
  const build = await readFile('scripts/build-distribution.ps1', 'utf8');
  assert.match(build, /\$testDestination = Join-Path \$root '_testenv'\s+\[IO\.Directory\]::CreateDirectory\(\$testDestination\) \| Out-Null\s+\$deployment =/);
  const release = await readFile('.github/workflows/release.yml', 'utf8');
  const preflight = await readFile('.github/workflows/package-preflight.yml', 'utf8');
  for (const workflow of [release, preflight]) {
    assert.match(workflow, /\.\/scripts\/package-release\.ps1/);
    assert.match(workflow, /node scripts\/test-distribution\.mjs --latest-portable/);
    assert.match(workflow, /sha256sum --check SHA256SUMS\.txt/);
  }
  assert.doesNotMatch(preflight, /gh release create|attest-build-provenance|contents: write/);
});

test('Portable包装: JPEG lockのLF・CRLFを許可し異版を拒否する', async () => {
  const source = await readFile('scripts/package-release.ps1', 'utf8');
  const expression = source.split(/\r?\n/).find(line => line.trim().startsWith('$lockEntry ='));
  assert.ok(expression, '実際の包装処理の照合式を使う');
  const script = `
    foreach ($newline in @("\u0060n", "\u0060r\u0060n")) {
      foreach ($name in @('jpeg-decoder', 'jpeg-encoder')) {
        $crate = @{ name = $name; version = '0.3.2' }
        ${expression}
        $text = 'name = "' + $name + '"' + $newline + 'version = "0.3.2"' + $newline
        if ($text -notmatch $lockEntry) { throw 'Valid lock rejected' }
        if ($text.Replace('0.3.2', '0.3.20') -match $lockEntry) { throw 'Wrong version accepted' }
      }
    }
  `;
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('Portable固定名: 新旧metadata選択とPowerShell consumerが同じ最新を選ぶ', async () => {
  const root = path.resolve('artifacts/distribution-tests', `selection-${randomUUID()}`);
  const releases = path.join(root, 'artifacts/releases');
  const build = path.join(releases, 'build-20261027-test');
  await mkdir(build, { recursive: true });
  const old = { portable: true, executable: 'old-hash.exe', executablePath: 'artifacts/releases/old-hash.exe', createdAtUtc: '2026-10-26T00:00:00Z' };
  const current = { portable: true, executable: 'KindleToZip-Portable.exe', executablePath: 'artifacts/releases/build-20261027-test/KindleToZip-Portable.exe', createdAtUtc: '2026-10-27T00:00:00Z', executableSha256: 'retained-hash' };
  await writeFile(path.join(releases, 'old-hash.json'), JSON.stringify(old));
  assert.equal((await selectLatestPortable(root)).report.executable, old.executable);
  await writeFile(path.join(build, 'KindleToZip-Portable.json'), JSON.stringify(current));
  await writeFile(path.join(releases, 'escape.json'), JSON.stringify({ ...current, executablePath: '../outside.exe', createdAtUtc: '2099-01-01' }));
  const selected = await selectLatestPortable(root);
  assert.deepEqual(selected.report, current);
  const ps = spawnSync('pwsh', ['-NoProfile', '-Command', `. ./scripts/portable-reports.ps1; (Get-LatestPortableReport '${root.replaceAll("'", "''")}').Report | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.stderr);
  assert.deepEqual(JSON.parse(ps.stdout), current);
  const buildSource = await readFile('scripts/build-distribution.ps1', 'utf8');
  assert.match(buildSource, /\$destinationName = "KindleToZip-Portable\.exe"/);
  assert.match(buildSource, /deploy-portable\.ps1/);
});

test('Portable配置: 初回・更新・ロック・hash不一致・missing source・reparse拒否と既存データ保全', () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', 'scripts/test-portable-deployment.ps1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /deployment-regression: pass/);
});
