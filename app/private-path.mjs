import path from 'node:path';

// Preserve Windows' existing case-folding; Linux paths are case sensitive.
export function samePath(a, b, platform = process.platform) {
  const left = path.resolve(a), right = path.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function privateMetadata(info, directory = false) {
  if (process.platform !== 'linux') return true;
  return info.uid === process.geteuid() && (info.mode & 0o7777) === (directory ? 0o700 : 0o600)
    && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1);
}
