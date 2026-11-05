// Normalize only the fixed normal Reader's title/position overlay. A preview
// reveals these controls for inspection; capture after a turn may auto-hide
// them. Their visibility must not change the retained page pixels used to resume.
export async function withReaderChromeHidden(reader, capture) {
  if (!reader.ownedSessionGuard?.normal || !reader.isKindleChromeConfiguration()) return capture();
  const title = reader.pickedMarkers.identity?.handle, position = reader.pickedMarkers.position?.handle;
  const fail = () => { throw Object.assign(new Error('reader_chrome_overlay_changed'), { code: 'capture_failed' }); };
  if (!title || !position) fail();
  let overlay, previous;
  try {
    overlay = await title.evaluateHandle((title, position) => {
      if (!title.isConnected || !position?.isConnected) return null;
      let region = title.parentElement;
      for (let divs = 0; region; region = region.parentElement) {
        if (region.tagName === 'DIV' && ++divs === 5) break;
      }
      if (!region || !region.contains(position)) return null;
      let node = title;
      while (node.parentElement && node.parentElement !== region) node = node.parentElement;
      // Require the exact shared overlay of the already inspected title and
      // position, directly inside the preset region. Never hide page surfaces.
      if (node === title || node.parentElement !== region || !node.contains(position)
          || node.querySelector('canvas,img,picture,video,iframe,object,embed,svg image')
          || !region.querySelector('canvas,img,iframe')) return null;
      return node;
    }, position);
    if (!overlay.asElement()) fail();
    previous = await reader.pickedMarkers.next.handle.evaluateHandle(next => {
      const r = next.getBoundingClientRect();
      const controls = [...document.querySelectorAll('button[aria-label*="前"], button[aria-label*="戻"], button[aria-label*="previous" i], button[aria-label*="back" i]')]
        .filter(button => {
          const b = button.getBoundingClientRect();
          return button !== next && button.isConnected && b.width > 0 && b.height > 0
            && b.width <= innerWidth / 4 && b.height <= innerHeight / 4
            && b.top <= r.top + r.height / 2 && b.bottom >= r.top + r.height / 2
            && (b.left + b.width / 2 < innerWidth / 2) !== (r.left + r.width / 2 < innerWidth / 2)
            && !button.querySelector('canvas,img,picture,video,iframe,object,embed,svg image');
        });
      if (controls.length > 1) throw new Error('previous_control_ambiguous');
      return controls[0] ?? null;
    });
    const hidden = [];
    try {
      // Opacity changes no layout, clip, position, scrolling or book rendering.
      for (const node of [overlay, previous].filter(handle => handle.asElement())) {
        const original = await node.evaluate(node => {
          const original = { value: node.style.getPropertyValue('opacity'),
            priority: node.style.getPropertyPriority('opacity'), hadStyle: node.hasAttribute('style') };
          node.style.setProperty('opacity', '0', 'important');
          return original;
        });
        hidden.push({ node, original });
      }
      return await capture();
    } finally {
      let restored = true;
      for (const { node, original } of hidden.reverse()) {
        const current = await node.evaluate((node, original) => {
          if (!node.isConnected || node.style.getPropertyValue('opacity') !== '0'
              || node.style.getPropertyPriority('opacity') !== 'important') return false;
          if (original.value) node.style.setProperty('opacity', original.value, original.priority);
          else node.style.removeProperty('opacity');
          if (!original.hadStyle && !node.getAttribute('style')) node.removeAttribute('style');
          return true;
        }, original).catch(() => false);
        restored = current && restored;
      }
      if (!restored) fail();
    }
  } finally {
    await previous?.dispose().catch(() => {});
    await overlay?.dispose().catch(() => {});
  }
}
