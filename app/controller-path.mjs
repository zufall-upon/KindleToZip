import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit override, or the project's own controller. Never search PATH or build.
export function controllerPath({ platform = process.platform, env = process.env } = {}) {
  if (env.KTZ_CONTROLLER_PATH) return path.resolve(env.KTZ_CONTROLLER_PATH);
  const suffix = platform === 'win32' ? '.exe' : '';
  return fileURLToPath(new URL(`../artifacts/rust-target/debug/ktz-g02-controller${suffix}`, import.meta.url));
}

export function requireControllerPath() {
  const controller = controllerPath();
  try {
    if (!statSync(controller).isFile()) throw new Error('not_a_file');
    accessSync(controller, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch {
    throw Object.assign(new Error(`controller_not_found: ${controller}`), { code: 'controller_not_found' });
  }
  return controller;
}
