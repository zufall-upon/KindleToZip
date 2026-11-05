// Fixed private identity input for the dedicated expected-book entry only.
// No URL, profile, selector or credentials are accepted in this file.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function loadExpectedBook(home) {
  const local = path.join(home, '.local'), state = path.join(local, 'state');
  const directory = path.join(state, 'kindle-to-zip-inspection');
  const filename = path.join(directory, 'expected-book.json');
  for (const item of [local, state, directory]) {
    const info = await lstat(item);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
        || (info.mode & 0o7777) !== 0o700 || await realpath(item) !== item) throw new Error('unsafe_expected_book');
  }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(), entry = await lstat(filename);
    if (!info.isFile() || entry.isSymbolicLink() || !entry.isFile() || info.uid !== process.geteuid()
        || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 8192
        || !['dev', 'ino', 'uid', 'mode', 'nlink'].every(key => info[key] === entry[key])
        || await realpath(filename) !== filename) throw new Error('unsafe_expected_book');
    const value = JSON.parse(await handle.readFile('utf8'));
    const title = text => typeof text === 'string' && text === text.trim() && text.length > 0 && text.length <= 500
      && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text);
    if (!value || Object.keys(value).sort().join(',') !== 'aliases,asin,title,version'
        || value.version !== 1 || !/^[A-Z0-9]{10}$/.test(value.asin) || !title(value.title)
        || !Array.isArray(value.aliases) || value.aliases.length > 8 || !value.aliases.every(title)) throw new Error('unsafe_expected_book');
    return Object.freeze({ asin: value.asin, title: value.title, aliases: Object.freeze([...value.aliases]) });
  } finally { await handle.close(); }
}
