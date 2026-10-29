import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/reader-kindle-chrome.html', ['reader-kindle-chrome.html', 'text/html; charset=utf-8']],
  ['/reader-kindle-chrome.css', ['reader-kindle-chrome.css', 'text/css; charset=utf-8']],
  ['/reader-kindle-chrome.js', ['reader-kindle-chrome.js', 'text/javascript; charset=utf-8']],
  ['/reader.html', ['reader.html', 'text/html; charset=utf-8']],
  ['/reader-image-review.html', ['reader-image-review.html', 'text/html; charset=utf-8']],
  ['/reader-image-review.js', ['reader-image-review.js', 'text/javascript; charset=utf-8']],
  ['/reader.js', ['reader.js', 'text/javascript; charset=utf-8']],
  ['/reader.css', ['reader.css', 'text/css; charset=utf-8']],
  ['/reader-layout.html', ['reader-layout.html', 'text/html; charset=utf-8']],
  ['/reader-layout.js', ['reader-layout.js', 'text/javascript; charset=utf-8']],
  ['/reader-layout.css', ['reader-layout.css', 'text/css; charset=utf-8']],
  ['/reader-layout-frame.html', ['reader-layout-frame.html', 'text/html; charset=utf-8']],
  ['/reader-layout-frame.css', ['reader-layout-frame.css', 'text/css; charset=utf-8']],
]);

// Only fixed self-authored assets are served; never a general file server.
export async function startFixture({ fixture = 'reader' } = {}) {
  if (!['reader', 'image-review', 'layout', 'kindle-chrome', 'kindle-chrome-dynamic', 'kindle-chrome-hidden', 'kindle-chrome-recoverable', 'kindle-chrome-tabs', 'kindle-chrome-ambiguous'].includes(fixture)) throw new Error('invalid_sample_fixture');
  const ambiguous = fixture === 'kindle-chrome-ambiguous';
  const tabs = fixture === 'kindle-chrome-tabs';
  const dynamic = fixture === 'kindle-chrome-dynamic';
  const recoverable = fixture === 'kindle-chrome-recoverable';
  const initialHidden = fixture === 'kindle-chrome-hidden' || recoverable;
  const assetFixture = dynamic || initialHidden || tabs || ambiguous ? 'kindle-chrome' : fixture;
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const file = files.get(requestUrl.pathname);
    if (req.method !== 'GET' || !file) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(new URL(`../fixtures/${file[0]}`, import.meta.url));
      const framePage = requestUrl.pathname === '/reader-layout-frame.html';
      const layoutPage = requestUrl.pathname === '/reader-layout.html';
      res.writeHead(200, {
        'Content-Type': file[1],
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; ${layoutPage ? "frame-src 'self'; " : ''}connect-src 'none'; form-action 'none'; frame-ancestors ${framePage ? "'self'" : "'none'"}`,
        'X-Content-Type-Options': 'nosniff',
      }).end(data);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/${assetFixture === 'kindle-chrome' ? 'reader-kindle-chrome.html' : assetFixture === 'layout' ? 'reader-layout.html' : assetFixture === 'image-review' ? 'reader-image-review.html' : 'reader.html'}${ambiguous ? '?ambiguous=1' : tabs ? '?tabs=1' : dynamic ? '?dynamic=1' : recoverable ? '?chrome=hidden&recovery=top-motion' : initialHidden ? '?chrome=hidden' : ''}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
