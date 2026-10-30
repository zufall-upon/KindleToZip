// Test-only observer loaded by NODE_OPTIONS into the real npm start child.
// Launch options are untouched; only the app's own control page is exercised.
import net from 'node:net';

if (process.platform === 'linux' && process.env.KTZ_PUBLIC_TEST_SOCKET
  && /(?:^|\/)app\/main\.mjs$/.test(process.argv[1] ?? '')) {
  const { chromium } = await import('playwright');
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async contextOptions => {
      const context = await newContext(contextOptions);
      let connected = false;
      context.on('page', page => page.on('domcontentloaded', async () => {
        if (connected || !page.url().startsWith('http://127.0.0.1:')) return;
        connected = true;
        const socket = net.createConnection(process.env.KTZ_PUBLIC_TEST_SOCKET);
        const send = value => socket.write(`${JSON.stringify(value)}\n`);
        try {
          await page.waitForFunction(() => document.querySelector('#state')?.textContent === '待機');
          send({ event: 'ready', pid: process.pid, origin: new URL(page.url()).origin, title: await page.title() });
          let buffer = '';
          socket.on('data', chunk => {
            buffer += chunk.toString();
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
              void (async () => {
                if (request.action === 'exercise') {
                  await page.locator('#decisionButton').click();
                  await page.waitForFunction(() => document.querySelector('#state')?.textContent === '手動ログイン・1冊選択待ち');
                  await page.locator('[data-stage="browser"] details > summary').click();
                  await page.locator('#openSample').click();
                  await page.waitForFunction(() => document.querySelector('#readerTab').options.length > 1);
                  if (request.screenshot) await page.screenshot({ path: request.screenshot, scale: 'css' });
                  send({ event: 'exercised', state: await page.locator('#state').textContent(),
                    kindleDisabled: await page.locator('#openKindle').isDisabled(),
                    notice: await page.locator('#kindleUnsupported').textContent() });
                } else if (request.action === 'close') {
                  socket.write(`${JSON.stringify({ event: 'closing' })}\n`, () => { void page.close(); });
                }
              })().catch(error => send({ event: 'error', message: error.message }));
            }
          });
        } catch (error) { send({ event: 'error', message: error.message }); }
      }));
      return context;
    };
    return browser;
  };
}
