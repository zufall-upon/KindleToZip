// Test-only ownership order for the four storage-uncertainty UI cases.
// Never remove a fixture while either its HTTP caller or application may live.
export function createControlFirstCleanup({ closeControl, closeRunning, removeFixture,
  bodyFailure = () => undefined, controlFailure = () => undefined }) {
  let cleanupPromise;
  return () => cleanupPromise ??= (async () => {
    const errors = [];
    let controlClosed = false, runningClosed = false;
    try {
      // A rejected acquisition may have left a partially created browser whose
      // own close also failed. No returned control is not proof of its exit.
      const failedControl = controlFailure();
      if (failedControl) throw failedControl.error;
      await closeControl(); controlClosed = true;
    } catch (error) { errors.push(error); }
    // Even a failed browser close must not skip releasing the application.
    try { await closeRunning(); runningClosed = true; } catch (error) { errors.push(error); }
    if (controlClosed && runningClosed) {
      try { await removeFixture(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      const body = bodyFailure();
      if (body && !errors.includes(body.error)) errors.unshift(body.error);
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, 'owned_test_cleanup_failed', { cause: body ? body.error : errors[0] });
    }
  })();
}
