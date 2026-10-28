// Explicit launch convenience only. Authentication, preview and acquisition
// remain user actions in the visible application and dedicated browser.
export async function openKindleForUser(app, { resumeTemporary = false } = {}) {
  await app.command('create');
  let session;
  if (resumeTemporary) {
    const candidates = (await app.snapshot()).sessions.filter(item => !item.saved && /^temporary-[a-f0-9-]{36}$/.test(item.id));
    if (candidates.length !== 1) throw new Error('choose_temporary_session_in_ui');
    session = candidates[0].id;
  }
  await app.command('openBrowser', { mode: 'kindle', keep: true, ...(session ? { session } : {}) });
}
