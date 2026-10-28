// Only a filename component is derived from validated, locally held metadata.
export function bookFilename(title, format = 'zip') {
  const clean = String(title ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '_').replace(/[. ]+$/u, '').trim();
  let stem = Array.from(clean).slice(0, 100).join('').replace(/[. ]+$/u, '') || 'export';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
  return `${stem}.${format === 'cbz' ? 'cbz' : 'zip'}`;
}
