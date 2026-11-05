import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './store-client.mjs';
import { accessSync, constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';

const zenity = '/usr/bin/zenity';
export function saveDialogAvailable({ platform = process.platform, access = accessSync } = {}) {
  if (platform === 'win32') return true;
  if (platform !== 'linux') return false;
  try { access(zenity, constants.X_OK); return true; } catch { return false; }
}

// The injectable process primitive is for contract tests, not a runtime path override.
export function linuxSaveDestination({ destination, format, signal }, spawnProcess = spawn) {
  if (signal?.aborted) return Promise.resolve(null);
  if (!['zip', 'cbz'].includes(format) || typeof destination !== 'string' || !path.posix.isAbsolute(destination)
    || /[\0\r\n]/u.test(destination) || destination.length > 32760) throw new AppError('invalid_destination');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(zenity, ['--file-selection', '--save', `--title=KindleToZip ${format.toUpperCase()} ${randomUUID().slice(0, 8)}`, `--filename=${destination}`,
        `--file-filter=${format.toUpperCase()} | *.${format}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new AppError(error.code === 'ENOENT' ? 'save_dialog_unavailable' : 'save_dialog_failed')); return;
    }
    let chunks = [], length = 0, errorLength = 0, failed = false, spawnError, killTimer;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', error => { spawnError = error; });
    child.stdout.on('error', () => { failed = true; stop(); });
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 32768) { failed = true; chunks = []; stop(); }
      else if (!failed) chunks.push(chunk);
    });
    child.stderr.on('error', () => { failed = true; stop(); });
    // A startup/display failure can also exit 1. Do not call it user cancellation.
    // Count diagnostics without retaining paths or other potentially private text.
    child.stderr.on('data', chunk => {
      errorLength += chunk.length;
      if (errorLength > 32768) { failed = true; stop(); }
    });
    child.once('close', code => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return resolve(null);
      if (spawnError) return reject(new AppError(spawnError.code === 'ENOENT' ? 'save_dialog_unavailable' : 'save_dialog_failed'));
      const bytes = Buffer.concat(chunks);
      if (failed || !isUtf8(bytes)) return reject(new AppError('save_dialog_failed'));
      if (code === 1 && bytes.length === 0 && errorLength === 0) return resolve(null);
      // Strip exactly Zenity's record terminator, never trim or normalize the path.
      const output = bytes.toString('utf8');
      const result = output.endsWith('\n') ? output.slice(0, -1) : '';
      if (code !== 0 || !path.posix.isAbsolute(result) || result.length > 32760 || /[\0\r\n]/u.test(result)) {
        return reject(new AppError('save_dialog_failed'));
      }
      resolve(result);
    });
    if (signal?.aborted) stop();
  });
}

// Fixed script and structured stdin; user input is never executable command text.
// A separate process leaves store IPC and polling available during the modal wait.
export function chooseSaveDestination({ destination, format, signal }) {
  if (process.platform === 'linux') return linuxSaveDestination({ destination, format, signal });
  if (process.platform !== 'win32') throw new AppError('save_dialog_unavailable');
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./save-dialog.ps1', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const abort = () => child.kill(); // Only our own disposable dialog host.
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) abort(); });
    child.once('error', () => reject(new AppError('save_dialog_failed')));
    child.stdin.on('error', () => {});
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return resolve(null);
      try {
        if (code !== 0) throw new Error();
        const result = JSON.parse(output.replace(/^\uFEFF/u, '').trim());
        if (result !== null && (typeof result !== 'string' || !path.isAbsolute(result) || result.length > 32760)) throw new Error();
        resolve(result);
      } catch { reject(new AppError('save_dialog_failed')); }
    });
    child.stdin.end(JSON.stringify({ destination, format }) + '\n');
    if (signal?.aborted) abort();
  });
}
