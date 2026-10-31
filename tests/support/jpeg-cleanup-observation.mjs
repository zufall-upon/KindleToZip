// Observation for the JPEG public-workflow test only. Records contain no
// resource identifiers or error details; all operations still use real methods.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function createJpegCleanupObservation({ eventFile = process.env.KTZ_JPEG_CLEANUP_EVENTS } = {}) {
  const events = [], readers = new Set();
  let outputFailed = false, server, bodyCompleted = false;

  function record(boundary, event) {
    const entry = { boundary, event };
    events.push(entry);
    if (!eventFile) return;
    try {
      mkdirSync(path.dirname(eventFile), { recursive: true, mode: 0o700 });
      appendFileSync(eventFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { outputFailed = true; }
  }

  async function step(boundary, operation) {
    record(boundary, 'start');
    try {
      const result = await operation();
      record(boundary, 'end');
      return result;
    } catch (error) {
      record(boundary, 'error');
      throw error;
    }
  }

  function wrapClose(target, boundary) {
    const original = target.close;
    target.close = function (...args) {
      return step(boundary, () => Reflect.apply(original, this, args));
    };
  }

  function attach(running) {
    const app = running.app, closeBrowser = app.closeBrowser;
    wrapClose(app, 'app.close');
    wrapClose(app.store, 'store.close');
    // The JPEG body closes its Reader through the public UI before teardown.
    // Attach to the actual owned instance at closeBrowser, including on an
    // early body failure where the Reader was created but not yet selected.
    app.closeBrowser = function (...args) {
      if (this.reader && !readers.has(this.reader)) {
        readers.add(this.reader);
        wrapClose(this.reader, 'reader.close');
      }
      return Reflect.apply(closeBrowser, this, args);
    };
  }

  async function closeRunning(running) {
    // server.mjs keeps the HTTP server private. Intercept only the close of
    // this running server, identified by its live listening address, and only
    // while its real running.close is pending. Other HTTP servers pass through.
    const port = Number(new URL(running.origin).port);
    const original = http.Server.prototype.close;
    function observedClose(callback) {
      const address = this.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== port) {
        return Reflect.apply(original, this, arguments);
      }
      server = this;
      record('http.close', 'start');
      try {
        return Reflect.apply(original, this, [function (error) {
          record('http.close', error ? 'error' : 'end');
          return Reflect.apply(callback, this, arguments);
        }]);
      } catch (error) {
        record('http.close', 'error');
        throw error;
      }
    }
    http.Server.prototype.close = observedClose;
    try { return await step('running.close', () => running.close()); }
    finally {
      if (http.Server.prototype.close === observedClose) http.Server.prototype.close = original;
    }
  }

  async function removeFixture({ running, control, controlAttempted, remove }) {
    await step('fixture.safe', () => {
      const app = running.app;
      assert.equal(app.closed, true);
      assert.ok(!app.reader && !app.fixture && !app.profile && !app.readerLifecycle && !app.readerReleasePending);
      assert.equal(app.store.closed, true);
      assert.ok(app.store.child.exitCode !== null || app.store.child.signalCode !== null);
      assert.ok(server && !server.listening);
      for (const reader of readers) assert.equal(reader.lifecycle.state, 'closed_confirmed');
      if (!control) assert.equal(controlAttempted, false);

      if (bodyCompleted) {
        // The existing body explicitly closes the Reader before reopening the
        // job; it is not created again for the final teardown.
        assert.equal(readers.size, 1);
        assert.ok(control);
        assert.deepEqual(events, [
          ['reader.close', 'start'], ['reader.close', 'end'], ['body', 'complete'],
          ['control.close', 'start'], ['control.close', 'end'], ['running.close', 'start'],
          ['app.close', 'start'], ['store.close', 'start'], ['store.close', 'end'],
          ['app.close', 'end'], ['http.close', 'start'], ['http.close', 'end'],
          ['running.close', 'end'], ['fixture.safe', 'start'],
        ].map(([boundary, event]) => ({ boundary, event })));
      }
    });
    await step('fixture.remove', remove);
    if (outputFailed) throw new Error('jpeg_cleanup_event_output_failed');
  }

  return {
    attach, closeRunning, removeFixture, step,
    bodyComplete() { bodyCompleted = true; record('body', 'complete'); },
    bodyError() { record('body', 'error'); },
    events: () => events.slice(),
  };
}
