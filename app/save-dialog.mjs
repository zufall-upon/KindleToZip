import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './store-client.mjs';

// Fixed script and structured stdin; user input is never executable command text.
// A separate process leaves store IPC and polling available during the modal wait.
export function chooseSaveDestination({ destination, format, signal }) {
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
