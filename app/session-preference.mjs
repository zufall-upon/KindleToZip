import { lstat, readFile, realpath, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from './store-client.mjs';

export const sessionId = /^(saved|temporary)-[a-f0-9-]{36}$/;
const filename = directory => path.join(directory, 'kindle-session.json');
const empty = () => ({ session: null, savedTemporarySessions: [] });
const validId = value => typeof value === 'string' && sessionId.test(value);

async function check(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024
      || path.resolve(await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new AppError('unsafe_session_preferences');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Only opaque local directory IDs are stored here, never cookies or book data.
// Retention is independent of the last-used pointer: old temporary paths cannot
// be renamed without changing Chromium's profile/encryption identity.
export async function readSessionPreferences(directory) {
  const file = filename(directory);
  if (!await check(file)) return empty();
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.version === 1 && validId(value.session)) {
      return { session: value.session, savedTemporarySessions: value.session.startsWith('temporary-') ? [value.session] : [] };
    }
    if (value.version !== 2 || value.session !== null && !validId(value.session)
      || !Array.isArray(value.savedTemporarySessions)
      || value.savedTemporarySessions.some(id => !validId(id) || !id.startsWith('temporary-'))
      || new Set(value.savedTemporarySessions).size !== value.savedTemporarySessions.length
      || value.session?.startsWith('temporary-') && !value.savedTemporarySessions.includes(value.session)) throw new Error('invalid');
    return { session: value.session, savedTemporarySessions: value.savedTemporarySessions };
  } catch { throw new AppError('invalid_session_preferences'); }
}

export async function readSessionPreference(directory) {
  return (await readSessionPreferences(directory)).session;
}

async function writePreferences(directory, preferences) {
  const file = filename(directory);
  await check(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const content = JSON.stringify({ version: 2, ...preferences });
    if (Buffer.byteLength(content) > 1024 * 1024) throw new AppError('invalid_session_preferences');
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function saveSessionPreference(directory, session, { preferred = true } = {}) {
  if (!validId(session)) throw new AppError('invalid_session');
  const previous = await readSessionPreferences(directory);
  const saved = new Set(previous.savedTemporarySessions);
  if (session.startsWith('temporary-')) saved.add(session);
  const preferences = { session: preferred ? session : previous.session, savedTemporarySessions: [...saved] };
  await writePreferences(directory, preferences);
  return preferences;
}

export async function forgetSessionPreference(directory, session) {
  if (!validId(session)) throw new AppError('invalid_session');
  const previous = await readSessionPreferences(directory);
  const preferences = {
    session: previous.session === session ? null : previous.session,
    savedTemporarySessions: previous.savedTemporarySessions.filter(id => id !== session),
  };
  if (preferences.session === previous.session && preferences.savedTemporarySessions.length === previous.savedTemporarySessions.length) return preferences;
  if (preferences.session === null && preferences.savedTemporarySessions.length === 0) {
    const file = filename(directory);
    if (await check(file)) await rm(file);
  } else await writePreferences(directory, preferences);
  return preferences;
}
