// Scoped test-only observation of the real public control-window caller.
// No Playwright prototype or product file is modified. Calls from other async
// contexts pass directly through the original method, including its promise.
import { AsyncLocalStorage } from 'node:async_hooks';
import { isPromise } from 'node:util/types';

const scope = new AsyncLocalStorage();
const activeChromium = new WeakSet();

export function observeControlWindow(trace, test, chromium, operation) {
  if (!trace.enabled) return operation();
  const token = {};
  // A nested/concurrent observer cannot take over an existing patch. Its own
  // context also cannot accidentally be attributed to the first observer.
  if (activeChromium.has(chromium)) return scope.run(token, operation);
  const restorers = [];
  let active = true;
  activeChromium.add(chromium);

  function install(target, name, boundary, after) {
    try {
      if (!target || (typeof target !== 'object' && typeof target !== 'function')) return;
      const own = Object.getOwnPropertyDescriptor(target, name);
      let source = target, descriptor;
      while (source && !(descriptor = Object.getOwnPropertyDescriptor(source, name))) source = Object.getPrototypeOf(source);
      if (!descriptor || typeof descriptor.value !== 'function' || (own && !('value' in own))
        || (own && !own.configurable && !own.writable)) return;
      const original = descriptor.value;
      function wrapped(...args) {
        if (!active || scope.getStore() !== token) return Reflect.apply(original, this, args);
        return trace.step(test, boundary, () => {
          const result = Reflect.apply(original, this, args);
          if (!after) return result;
          const attach = value => { try { after(value); } catch { /* Optional instrumentation only. */ } return value; };
          if (!isPromise(result)) return attach(result);
          try { return Promise.prototype.then.call(result, attach); } catch { return result; }
        });
      }
      Object.defineProperty(target, name, own ? { ...own, value: wrapped }
        : { value: wrapped, configurable: true, writable: true, enumerable: false });
      restorers.push(() => {
        // Do not overwrite a third party's intervening descriptor change.
        if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapped) return;
        if (own) Object.defineProperty(target, name, own); else delete target[name];
      });
    } catch { /* Unsupported or sealed objects fall back to the outer step. */ }
  }
  const page = value => install(value, 'goto', 'control.page_goto');
  const context = value => {
    install(value, 'route', 'control.route_register');
    install(value, 'newPage', 'control.page_create', page);
  };
  const browser = value => {
    install(value, 'newContext', 'control.context_create', context);
    install(value, 'close', 'control.browser_close');
  };
  function restore() {
    active = false;
    for (const undo of restorers.reverse()) { try { undo(); } catch { /* Do not replace the public result. */ } }
    activeChromium.delete(chromium);
  }
  try {
    install(chromium, 'launch', 'control.browser_launch', browser);
    const result = scope.run(token, operation);
    if (!isPromise(result)) { restore(); return result; }
    try { return Promise.prototype.then.call(result, value => { restore(); return value; }, error => { restore(); throw error; }); }
    catch { restore(); return result; }
  } catch (error) { restore(); throw error; }
}
