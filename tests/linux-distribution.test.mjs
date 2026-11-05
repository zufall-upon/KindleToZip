import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appFiles, fixtureFiles, safeRelative, collectFiles } from '../scripts/linux-distribution.mjs';

test('Linux package includes every relative product module, including the reader overlay', async () => {
  const files = new Set([...appFiles, ...fixtureFiles, 'poc/browser/fixture-server.mjs']);
  for (const name of files) {
    if (!name.endsWith('.mjs')) continue;
    const source = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      assert.ok(files.has(target), `${name} requires ${target}`);
    }
  }
});

if (process.platform === 'linux') {
  test('Linux normal Portable supports its own installation, never a foreign data root or legacy trial', async () => {
    const { portableNormalAvailable, portableLimitedAvailable, authorizePortableKindle } = await import('../app/portable-linux-site.mjs');
    const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const previous = process.env.KTZ_PORTABLE_ROOT;
    try {
      delete process.env.KTZ_PORTABLE_ROOT;
      assert.equal(portableNormalAvailable(path.join(root, 'data/application')), false);
      process.env.KTZ_PORTABLE_ROOT = root;
      assert.equal(portableNormalAvailable(path.join(root, 'data/application')), true);
      assert.equal(portableNormalAvailable(path.join(root, 'other-data')), false);
      assert.equal(portableLimitedAvailable(path.join(root, 'data/application')), false);
      await assert.rejects(authorizePortableKindle({ root: path.join(root, 'data/application/saved-fixture') }, {}), { code: 'linux_kindle_permission_required' });
      await assert.rejects(authorizePortableKindle({ root: path.join(root, 'data/application/saved-fixture') }, {}, async () => {}), { code: 'portable_normal_job_unavailable' });
    } finally { if (previous === undefined) delete process.env.KTZ_PORTABLE_ROOT; else process.env.KTZ_PORTABLE_ROOT = previous; }
  });

  test('Linux bundle paths reject traversal and symlinks; existing output data survives refused rebuild', async t => {
    for (const value of ['../private', '/etc/passwd', 'a/../b', 'a//b', 'a\\b', './a']) assert.throws(() => safeRelative(value));
    const root = await mkdtemp(path.join(tmpdir(), 'ktz-package-'));
    t.after(() => rm(root, { recursive: true }));
    const target = path.join(root, 'bundle'); await mkdir(target);
    const marker = path.join(target, 'retained'); await writeFile(marker, 'anonymous retained data');
    const link = path.join(root, 'link'); await symlink(marker, link);
    await assert.rejects(collectFiles(link, 'fixture/link'), /symlink_refused/);
    const result = spawnSync(process.execPath, ['scripts/build-linux-distribution.mjs', '--output', target, '--ubuntu-portable'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /output_exists/);
    assert.equal(await readFile(marker, 'utf8'), 'anonymous retained data');
  });
}
