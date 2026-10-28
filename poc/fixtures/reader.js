const reader = document.querySelector('#reader');
const canvas = document.querySelector('#sheet');
const ctx = canvas.getContext('2d');
const next = document.querySelector('#next');
let position = 1;
let stall = false;
let duplicate = false;

function draw() {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  if (canvas.width !== 600 * ratio || canvas.height !== 480 * ratio) {
    canvas.width = 600 * ratio; canvas.height = 480 * ratio;
    canvas.style.width = '600px'; canvas.style.height = '480px';
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#faf6e9';
  ctx.fillRect(0, 0, 600, 480);
  ctx.fillStyle = '#163c67';
  ctx.fillRect(30, 30, 540, 6);
  ctx.font = 'bold 120px sans-serif';
  ctx.fillText(String(position).padStart(2, '0'), 200, 260);
  ctx.font = '24px sans-serif';
  ctx.fillText('SELF-AUTHORED SAMPLE', 115, 340);
  ctx.fillStyle = `hsl(${position * 27}, 70%, 45%)`;
  ctx.fillRect(30 + position * 20, 390, 24, 48);
}

window.addEventListener('resize', draw);

next.addEventListener('click', () => {
  if (stall || position === 12) return;
  position += 1;
  reader.dataset.position = String(position);
  document.querySelector('#position').textContent = `${position} / 12`;
  next.disabled = position === 12;
  if (!duplicate) draw();
  duplicate = false;
});
document.querySelector('#logout').addEventListener('click', () => { reader.dataset.session = 'logged-out'; });
document.querySelector('#other-book').addEventListener('click', () => { reader.dataset.book = 'sample-b'; });
document.querySelector('#overlay').addEventListener('click', () => { reader.dataset.overlay = 'true'; });
document.querySelector('#stall').addEventListener('click', () => { stall = true; });
document.querySelector('#duplicate').addEventListener('click', () => { duplicate = true; });
for (const [id, color] of [['blank', '#fff'], ['black', '#000']]) {
  document.querySelector(`#${id}`).addEventListener('click', () => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 600, 480);
  });
}
draw();
