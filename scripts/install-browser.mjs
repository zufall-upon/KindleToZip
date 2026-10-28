import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.slice(2).some(arg => arg !== '--headed')) throw new Error('unsupported_install_option');
const result = spawnSync(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium', process.argv.includes('--headed') ? '--no-shell' : '--only-shell'], {
  cwd: root,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: fileURLToPath(new URL('../artifacts/browsers', import.meta.url)) },
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
