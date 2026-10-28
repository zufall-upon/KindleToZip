import { AppError } from './store-client.mjs';

function localGeometry(element) {
  const r = element.getBoundingClientRect();
  const w = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth);
  const h = Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);
  let left = Math.max(0, r.left), top = Math.max(0, r.top);
  let right = Math.min(w, r.right), bottom = Math.min(h, r.bottom);
  const rootStyle = getComputedStyle(document.documentElement);
  let escapingFixed = getComputedStyle(element).position === 'fixed';
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (escapingFixed) {
      const containsFixed = style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none'
        || /(?:paint|layout|strict|content)/.test(style.contain) || /(?:transform|perspective|filter)/.test(style.willChange);
      if (!containsFixed) continue;
      escapingFixed = false;
    }
    // Root overflow applies to the viewport, already intersected above. Body
    // overflow is propagated there when the root overflow is visible; a SPA's
    // body box may have zero height while fixed-position content is visible.
    if (parent === document.documentElement || style.display === 'contents') continue;
    const bodyX = parent === document.body && rootStyle.overflowX === 'visible';
    const bodyY = parent === document.body && rootStyle.overflowY === 'visible';
    const p = parent.getBoundingClientRect();
    const sx = parent.offsetWidth ? p.width / parent.offsetWidth : 1;
    const sy = parent.offsetHeight ? p.height / parent.offsetHeight : 1;
    if (!bodyX && ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
      const x = p.left + parent.clientLeft * sx;
      left = Math.max(left, x); right = Math.min(right, x + parent.clientWidth * sx);
    }
    if (!bodyY && ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
      const y = p.top + parent.clientTop * sy;
      top = Math.max(top, y); bottom = Math.min(bottom, y + parent.clientHeight * sy);
    }
  }
  return {
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    visible: { x: left, y: top, width: right - left, height: bottom - top },
    viewport: [innerWidth, innerHeight, w, h, devicePixelRatio],
  };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.min(a.x + a.width, b.x + b.width) - x, height: Math.min(a.y + a.height, b.y + b.height) - y };
}

// Geometry only: never scrolls, reads book text, or changes a service setting.
// Each enclosing frame and overflow viewport contributes to the visible clip.
export async function visibleCaptureGeometry(page, region) {
  const invalid = cause => new AppError('display_or_position_unknown', { field: 'reader', cause });
  const pieces = [];
  let handle = await region.elementHandle();
  if (!handle) throw new AppError('target_changed');
  const viewport = page.viewportSize();
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) { await handle.dispose(); throw invalid('viewport_unknown'); }
  let clip = { x: 0, y: 0, ...viewport };
  try {
    for (let depth = 0; handle && depth < 8; depth += 1) {
      const item = { handle }; pieces.push(item);
      item.local = await handle.evaluate(localGeometry);
      item.box = await handle.boundingBox();
      const { rect, visible } = item.local;
      if (!item.box || rect.width <= 0 || rect.height <= 0 || visible.width <= 0 || visible.height <= 0) throw invalid('empty_visible_bounds');
      item.sx = item.box.width / rect.width; item.sy = item.box.height / rect.height;
      clip = intersect(clip, {
        x: item.box.x + (visible.x - rect.x) * item.sx, y: item.box.y + (visible.y - rect.y) * item.sy,
        width: visible.width * item.sx, height: visible.height * item.sy,
      });
      const owner = await handle.ownerFrame();
      if (owner === page.mainFrame()) { handle = null; break; }
      if (!owner?.parentFrame()) throw new AppError('target_changed');
      handle = await owner.frameElement();
    }
    if (handle) throw invalid('frame_depth_unsupported');
    if (clip.width <= 0 || clip.height <= 0) throw invalid('empty_visible_bounds');
    let unobscured = true;
    for (const item of pieces) {
      const rect = {
        x: item.local.rect.x + (clip.x - item.box.x) / item.sx,
        y: item.local.rect.y + (clip.y - item.box.y) / item.sy,
        width: clip.width / item.sx, height: clip.height / item.sy,
      };
      const clear = await item.handle.evaluate((element, rect) => [[.1, .1], [.5, .5], [.9, .9]].every(([x, y]) => {
        const hit = document.elementFromPoint(rect.x + rect.width * x, rect.y + rect.height * y);
        return hit && (hit === element || element.contains(hit) || hit.contains(element));
      }), rect);
      if (!clear) unobscured = false;
    }
    return { clip, unobscured, viewports: pieces.map(item => item.local.viewport) };
  } finally {
    for (const item of pieces) await item.handle.dispose().catch(() => {});
    if (handle && !pieces.some(item => item.handle === handle)) await handle.dispose().catch(() => {});
  }
}
