// Read-only collection, including a terminal failure. Exit 0 means evidence was
// collected, never that capture succeeded: inspect the separate success field
// and the actual capture process exit. No browser or profile is opened here.
if (process.platform !== 'linux' || process.argv.length !== 2) {
  console.error('invalid_invocation'); process.exitCode = 1;
} else {
  try {
    const { collectCorrectedCaptureResult } = await import('./linux-expected-capture-result.mjs');
    const result = await collectCorrectedCaptureResult();
    console.log(JSON.stringify(result));
  } catch { console.error('result_validation_failed'); process.exitCode = 1; }
}
