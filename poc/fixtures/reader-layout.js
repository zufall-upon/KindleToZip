// The outer page is intentionally only a frame host. Its iframe is the
// visible viewport for a larger, self-authored canvas and reader controls.
const frame = document.querySelector('#readingFrame');
const drawPage = () => {
  const canvas = frame.contentDocument.querySelector('#pageSurface');
  const ratio = Math.max(1, frame.contentWindow.devicePixelRatio || 1);
  canvas.width = 1100 * ratio;
  canvas.height = 900 * ratio;
  canvas.style.width = '1100px';
  canvas.style.height = '900px';
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = '#f7f0df';
  context.fillRect(0, 0, 1100, 900);
  context.fillStyle = '#1c5484';
  for (let index = 0; index < 8; index += 1) context.fillRect(35 + index * 120, 120, 72, 600);
  context.fillStyle = '#d44b2b';
  context.fillRect(520, 80, 160, 160);
  context.fillStyle = '#142e48';
  context.font = 'bold 64px system-ui';
  context.fillText('SELF-AUTHORED PAGE', 45, 310);
};
if (frame.contentDocument?.readyState === 'complete') drawPage();
else frame.addEventListener('load', drawPage, { once: true });
