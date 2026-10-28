// Anonymous, self-authored pixels. The dynamic variant advances from its
// visible control and briefly hides the same title/location/toolbar nodes.
const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
const position = document.querySelector('#position');
const next = document.querySelector('#next');
const identity = document.querySelector('#readerChromeTitle');
const toolbar = document.querySelector('nav');
const dynamic = new URLSearchParams(location.search).get('dynamic') === '1';
const ambiguous = new URLSearchParams(location.search).get('ambiguous') === '1';
let anonymousEnd = 142;
if (ambiguous) { position.max = '200'; position.value = '2'; }
// A persistent initial state, independent of the post-next dynamic scenario.
// The persistent-hidden variant never restores itself. The separately selected
// top-motion variant models the observed recovery sequence, not Kindle markup
// or an unmeasured timer. No real user/profile/book data is used.
const initialHidden = new URLSearchParams(location.search).get('chrome') === 'hidden';
for (const node of [identity, position, toolbar]) node.style.visibility = initialHidden ? 'hidden' : '';
document.querySelector('#revealChrome').addEventListener('click', () => {
  for (const node of [identity, position, toolbar]) node.style.visibility = '';
});
document.querySelector('#hideChrome').addEventListener('click', () => {
  for (const node of [identity, position, toolbar]) node.style.visibility = 'hidden';
});
window.chromeRecoveryCount = 0;
if (new URLSearchParams(location.search).get('recovery') === 'top-motion') {
  const surface = document.querySelector('#chromeSurface');
  surface.addEventListener('mousemove', event => {
    const box = surface.getBoundingClientRect();
    if (event.clientY < box.top || event.clientY > box.top + 20
      || event.clientX < box.left + box.width / 4 || event.clientX > box.right - box.width / 4) return;
    window.chromeRecoveryCount++;
    for (const node of [identity, position, toolbar]) node.style.visibility = '';
  });
}

function paint(page) {
  ctx.fillStyle = '#f7f0df'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1c5484';
  for (let n = 0; n < 6; n++) ctx.fillRect(30 + n * 85, 80, 50, 200);
  ctx.fillStyle = '#d44b2b'; ctx.fillRect(245, 100 + (page % 3) * 8, 80, 120);
  ctx.fillStyle = '#4f8062'; ctx.fillRect(40 + (page % 5) * 24, 40, 24, 24);
  if (ambiguous) { ctx.fillStyle = '#1c5484'; ctx.font = '24px sans-serif'; ctx.fillText(`Anonymous spread ${page}/${page + 1}`, 30, 330); }
}

paint(Number(position.value));

if (new URLSearchParams(location.search).get('tabs') === '1') {
  const open = document.querySelector('#openSameBookTab');
  open.hidden = false;
  open.addEventListener('click', () => {
    // Anonymous public replay of the observed library + separate reading tab.
    // The route stays fixed only to keep the local sample's strict URL fence;
    // the live adapter identifies the official library route instead.
    window.open(location.href, '_blank');
    document.querySelector('main').replaceChildren();
    document.querySelector('main').dataset.ktzSampleLibrary = 'true';
    const heading = document.createElement('h1');
    heading.textContent = '匿名ライブラリ（読書画面は別の専用タブ）';
    document.querySelector('main').append(heading);
    document.querySelector('aside').hidden = true;
  });
}

if (ambiguous) {
  for (const id of ['hideDuplicate', 'extendSample', 'startNearBoundary']) document.querySelector(`#${id}`).hidden = false;
  document.querySelector('#startNearBoundary').addEventListener('click', () => { position.value = '130'; paint(130); });
  document.querySelector('#hideDuplicate').addEventListener('click', () => { const duplicate = document.querySelector('#duplicateNext'); if (duplicate) duplicate.hidden = true; });
  document.querySelector('#extendSample').addEventListener('click', () => { anonymousEnd += 4; next.setAttribute('aria-disabled', 'false'); });
  window.anonymousTurns = 0;
  next.addEventListener('click', () => {
    if (Number(position.value) >= anonymousEnd) return;
    window.anonymousTurns++;
    position.value = String(Number(position.value) + 2);
    paint(Number(position.value));
    if (position.value === '136') setTimeout(() => {
      const duplicate = next.cloneNode(true); duplicate.id = 'duplicateNext';
      toolbar.append(duplicate);
    }, 550);
    next.setAttribute('aria-disabled', String(Number(position.value) >= anonymousEnd));
  });
} else if (dynamic) {
  let advances = 0;
  next.addEventListener('click', () => {
    const page = Number(position.value);
    if (page >= Number(position.max)) return;
    advances += 1;
    position.value = String(page + 1);
    paint(page + 1);

    // First post-commit change outlasts the reader's bounded visibility wait,
    // producing a real, observable stop after one committed page. Later turns
    // recover within that same bound so a separately confirmed resume can run.
    const hiddenFor = advances === 1 ? 1100 : 240;
    identity.style.visibility = 'hidden';
    position.style.visibility = 'hidden';
    toolbar.style.visibility = 'hidden';
    setTimeout(() => {
      identity.style.visibility = '';
      position.style.visibility = '';
      toolbar.style.visibility = '';
    }, hiddenFor);
  });
}
