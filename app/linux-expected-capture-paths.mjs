// Fixed private paths for the single, explicitly authorised operation. No
// environment, command-line URL/profile/position, or arbitrary destination.
import path from 'node:path';
import { userInfo } from 'node:os';
import { lstat, realpath } from 'node:fs/promises';
import { loadExpectedBook } from './linux-expected-book.mjs';
import { linuxLoginRoot } from './linux-login-core.mjs';

const boundBooks = new WeakMap();
export function captureBook(paths) {
  const book = boundBooks.get(paths);
  if (!book) throw new Error('unsafe_expected_book');
  return book;
}
async function fixedPaths(stem) {
  const home = userInfo().homedir;
  const book = await loadExpectedBook(home); // also validates the private state ancestors
  const state = path.join(home, '.local/state/kindle-to-zip-inspection');
  const data = linuxLoginRoot(home);
  const info = await lstat(data);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== 0o700 || await realpath(data) !== data) throw new Error('unsafe_capture_data');
  const paths = Object.freeze({ data, state, claim: path.join(state, `${stem}.claim`),
    result: path.join(state, `${stem}.result.json`), lock: path.join(data, 'owned/in-use.lock') });
  boundBooks.set(paths, book);
  return paths;
}
export const fixedCapturePaths = () => fixedPaths('expected-capture-once');
// A distinct, newly authorised one-shot. The consumed original and diagnostic
// ledgers are never removed, renamed or used as permission for this operation.
export const fixedCorrectedCapturePaths = () => fixedPaths('expected-capture-corrected-590122c0');
