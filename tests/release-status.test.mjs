import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseArgs, summarize, monitor } from '../scripts/release-status.mjs';

const sha = 'a'.repeat(40);
const fixture = (status = 'completed', conclusion = 'success') => ({
  headSha: sha, status, conclusion, updatedAt: '2026-11-06T07:53:51Z',
  jobs: [{ databaseId: 123, name: 'Windows', status, conclusion,
    steps: [{ name: 'Public source UI regressions', status, startedAt: '2026-11-06T07:10:17Z', completedAt: null }] }],
});
test('exact source and terminal success are required', () => {
  assert.equal(summarize(fixture(), sha).code, 0);
  for (const outcome of ['failure', 'cancelled', 'timed_out', 'skipped', null]) assert.equal(summarize(fixture('completed', outcome), sha).code, 1);
  assert.equal(summarize(fixture('in_progress', null), sha).code, 2);
  assert.throws(() => summarize(fixture(), 'b'.repeat(40)), /Source mismatch/);
});
test('CLI bounds and exact input validation', () => {
  assert.equal(parseArgs(['--run', '123', '--source', sha]).wait, 0);
  for (const args of [[], ['--run', '0', '--source', sha], ['--run', '123', '--source', 'main'],
    ['--run', '123', '--source', sha, '--wait', '601'], ['--run', '123', '--source', sha, '--publish', 'true']]) assert.throws(() => parseArgs(args));
});
test('bounded wait reports step and never cancels or retries', async () => {
  let time = 0, calls = 0;
  const lines = [];
  const code = await monitor({ source: sha, wait: 30 }, {
    query: () => { calls++; return fixture('in_progress', null); },
    now: () => time, delay: async ms => { time += ms; }, output: text => lines.push(text),
  });
  assert.equal(code, 2); assert.equal(time, 30000); assert.equal(calls, 2);
  assert.match(lines[0], /Public source UI regressions/);
  assert.match(lines[0], /not a heartbeat/);
});
test('terminal failure supplies read-only log command; errors are not success', async () => {
  const lines = [];
  assert.equal(await monitor({ source: sha, run: '123', repo: 'owner/repo', wait: 0 }, {
    query: () => fixture('completed', 'cancelled'), output: line => lines.push(line),
  }), 1);
  assert.match(lines.at(-1), /gh run view 123 --repo owner\/repo --log-failed/);
  await assert.rejects(monitor({ source: sha, wait: 0 }, { query: () => { throw new Error('offline'); } }), /offline/);
});
test('Windows batch passes arguments and failure exit without launching GitHub', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(process.env.ComSpec, ['/d', '/c', 'scripts\\release-status.cmd --run invalid --source invalid'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Require --run ID/);
});
