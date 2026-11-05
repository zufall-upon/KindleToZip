// Fixed entry for the newly consented corrected run, not a retry switch.
// The original capture/diagnostic ledgers stay consumed and untouched.
import { safeCaptureCode } from './expected-capture-diagnostic.mjs';

if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.error('invalid_invocation'); process.exitCode = 1;
} else {
  process.umask(0o077);
  for (const key of ['KTZ_CONTROLLER_PATH', 'DEBUG', 'PWDEBUG', 'CHROMIUM_FLAGS', 'NODE_OPTIONS']) delete process.env[key];
  try {
    const { runCorrectedCaptureOnce } = await import('./linux-expected-capture.mjs');
    if (!await runCorrectedCaptureOnce()) process.exitCode = 1;
  } catch (error) { console.error(safeCaptureCode(error)); process.exitCode = 1; }
}
