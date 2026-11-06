// Read-only monitor: never dispatches, retries, cancels or publishes.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseArgs(args) {
  const options = { repo: 'zufall-upon/KindleToZip', wait: 0, gh: 'gh' };
  const keys = new Set(['run', 'source', 'repo', 'wait', 'gh']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !keys.has(key) || seen.has(key) || !args[i + 1]) throw new Error('Invalid arguments');
    options[key] = args[i + 1]; seen.add(key);
  }
  if (!/^[1-9][0-9]*$/.test(options.run ?? '') || !/^[a-f0-9]{40}$/.test(options.source ?? '')
    || !/^[\w.-]+\/[\w.-]+$/.test(options.repo) || !/^\d+$/.test(String(options.wait))) throw new Error('Require --run ID --source FULL_SHA; --wait must be 0..600 seconds');
  options.wait = Number(options.wait);
  if (options.wait > 600) throw new Error('Wait exceeds 600 seconds');
  return options;
}

export function summarize(run, source) {
  if (run.headSha !== source) throw new Error('Source mismatch: do not reuse this result');
  if (!['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(run.status)
    || !Array.isArray(run.jobs) || typeof run.updatedAt !== 'string') throw new Error('Invalid run response');
  const lines = [`${run.workflowName ?? 'Workflow'}: ${run.status} / ${run.conclusion || 'not concluded'}`,
    `Source: ${run.headSha}`, `Run updated (not a heartbeat): ${run.updatedAt}`];
  for (const job of run.jobs) {
    lines.push(`Job ${job.databaseId}: ${job.name} — ${job.status} / ${job.conclusion || 'not concluded'}`);
    const active = (job.steps ?? []).filter(step => step.status === 'in_progress');
    const last = (job.steps ?? []).filter(step => step.status === 'completed').at(-1);
    for (const step of active.length ? active : last ? [last] : []) {
      lines.push(`  Step: ${step.name}; ${step.status}; started=${step.startedAt}; completed=${step.completedAt}`);
    }
  }
  return { lines, code: run.status !== 'completed' ? 2 : run.conclusion === 'success' ? 0 : 1 };
}

export async function monitor(options, {
  query = () => {
    const result = spawnSync(options.gh, ['run', 'view', options.run, '--repo', options.repo,
      '--json', 'workflowName,status,conclusion,updatedAt,headSha,jobs'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    if (result.error || result.status !== 0) throw new Error('GitHub query failed; check gh installation and existing authentication. No retry was started.');
    return JSON.parse(result.stdout);
  }, output = console.log, now = Date.now,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + options.wait * 1000;
  for (;;) {
    const result = summarize(await query(), options.source);
    output(`Observed: ${new Date(now()).toISOString()}\n${result.lines.join('\n')}`);
    if (result.code !== 2) {
      if (result.code === 1) output(`Read failure logs: gh run view ${options.run} --repo ${options.repo} --log-failed`);
      return result.code;
    }
    if (now() >= deadline) return 2;
    await delay(Math.min(15000, deadline - now()));
    if (now() >= deadline) return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await monitor(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 3; }
}
