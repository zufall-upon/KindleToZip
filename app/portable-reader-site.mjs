// The real Reader starts empty; its fixed official entry is navigated only after
// the existing owner, transport and initial page have been verified.
export async function startPortableReaderSite() {
  return { url: 'about:blank',
    flags: ['--ozone-platform=wayland', '--remote-debugging-pipe'],
    expectedReader: true, close: async () => {} };
}
