const reader = document.querySelector('#reader');
const canvas = document.querySelector('#sheet');
const next = document.querySelector('#next');
const ctx = canvas.getContext('2d');
let position = 1;
reader.style.position = 'relative';
next.style.cssText = 'position:absolute;top:210px;width:35px;height:60px;margin:0;background:white;color:black;z-index:2';
function draw() {
  const ratio = Math.max(1, devicePixelRatio || 1);
  canvas.width = 600 * ratio; canvas.height = 480 * ratio;
  canvas.style.width = '600px'; canvas.style.height = '480px';
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 600, 480);
  if (position === 1) {
    // Original artwork is not used: coloured geometric shapes approximate the
    // asymmetric cover, black side, horizontal chrome and edge control only.
    ctx.fillStyle = '#c75b38'; ctx.fillRect(0, 50, 280, 400);
    ctx.fillStyle = '#ebcc96'; ctx.fillRect(45, 85, 180, 160);
    ctx.fillStyle = '#325b45'; ctx.beginPath(); ctx.arc(110, 330, 90, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, 0, 600, 50); ctx.fillRect(0, 450, 600, 30);
    next.style.left = '565px'; next.textContent = '❯';
  } else {
    // A fictional page with panels; the left navigation control overlaps it.
    ctx.fillStyle = '#fff'; ctx.fillRect(120, 10, 360, 460);
    ctx.strokeStyle = '#111'; ctx.lineWidth = 3;
    for (const [x, y, w, h] of [[135, 30, 150, 165], [295, 30, 170, 165], [135, 205, 330, 115], [135, 330, 160, 120], [305, 330, 160, 120]]) {
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#aaa'; ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 30, 0, 2 * Math.PI); ctx.fill();
    }
    next.style.left = '120px'; next.textContent = '❮';
  }
}
addEventListener('resize', draw);
next.addEventListener('click', () => {
  if (position !== 1) return;
  position = 2; reader.dataset.position = '2'; document.querySelector('#position').textContent = '2 / 2';
  next.disabled = true; draw();
});
draw();
