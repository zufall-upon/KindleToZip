import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Application } from './application.mjs';
import { AppError } from './store-client.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/ui.mjs', ['ui.mjs', 'text/javascript; charset=utf-8']],
  ['/i18n.mjs', ['i18n.mjs', 'text/javascript; charset=utf-8']],
  ['/messages.mjs', ['messages.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const imageType = bytes => bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';

export async function startApplication(options = {}) {
  const app = new Application(options);
  try { await app.init(); } catch (e) { await app.close(); throw e; }
  const token = randomBytes(32).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
    try {
      if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin
        || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { code: 'local_access_only' });
      const asset = assets.get(req.url);
      if (req.method === 'GET' && asset) {
        return res.writeHead(200, { 'Content-Type': asset[1] }).end(await readFile(new URL(`./ui/${asset[0]}`, import.meta.url)));
      }
      if (!equal(req.headers.authorization, `Bearer ${token}`)) return json(403, { code: 'authorization_required' });
      // Independent of the Rust command queue: a long export/reset must not
      // prevent the control window from observing completed stages.
      if (req.method === 'GET' && req.url === '/api/progress') return json(200, app.progress ?? null);
      if (req.method === 'GET' && req.url === '/api/state') return json(200, await app.snapshot());
      if (req.method === 'GET' && req.url === '/api/preview') {
        if (!app.previewImage) throw new AppError('preview_required');
        return res.writeHead(200, { 'Content-Type': imageType(app.previewImage) }).end(app.previewImage);
      }
      const image = /^\/api\/image\/(\d+)(?:\?(original=1|page=(left|right)))?$/.exec(req.url);
      if (req.method === 'GET' && image) {
        const bytes = await app.image(Number(image[1]), image[2] === 'original=1', image[3] ?? null);
        return res.writeHead(200, { 'Content-Type': imageType(bytes) }).end(bytes);
      }
      if (req.method === 'POST' && req.url === '/api/command') {
        if (req.headers['content-type'] !== 'application/json') return json(415, { code: 'json_required' });
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString('utf8');
          if (Buffer.byteLength(body) > 65_536) return json(413, { code: 'request_too_large' });
        }
        let input;
        try { input = JSON.parse(body); } catch { throw new AppError('invalid_json'); }
        if (!input || typeof input.action !== 'string' || !input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new AppError('invalid_request');
        return json(200, await app.command(input.action, input.input));
      }
      return json(404, { code: 'not_found' });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'operation_failed';
      const detail = error instanceof AppError && ['reader', 'next', 'identity', 'position'].includes(error.detail?.field)
        && (error.code === 'reader_auto_ambiguous' ? ['not_found', 'not_unique'].includes(error.detail?.cause)
          : ['hidden', 'not_found', 'not_unique', 'invalid_selector', 'auth_password', 'auth_modal', 'reader_password', 'reader_modal', 'blocked_hit', 'viewport_unknown', 'empty_visible_bounds', 'frame_depth_unsupported', 'label_empty', 'label_too_long', 'area_too_small', 'outside_view', 'kindle_chrome_structure_changed', 'library_selected'].includes(error.detail?.cause))
        ? { field: error.detail.field, cause: error.detail.cause } : undefined;
      if (detail) console.log(`KTZ_CHECK:${detail.field}:${detail.cause}`);
      const stage = ['auto_visibility_wait', 'preview_visibility_wait', 'reader_target_check'].includes(error.stage) ? error.stage : undefined;
      const recoveryObservation = ['not_preset', 'auth_visible', 'markers_not_unique', 'no_handles', 'region_hidden', 'not_shared', 'next_direction', 'no_surface', 'hit_blocked', 'dispatched'].includes(error.recoveryObservation) ? error.recoveryObservation : undefined;
      if (!res.headersSent) json(400, { code, ...(detail ? { detail } : {}), ...(stage ? { stage } : {}), ...(recoveryObservation ? { recoveryObservation } : {}) });
      else res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (e) { await app.close(); throw e; }
  origin = `http://127.0.0.1:${server.address().port}`;
  let closePromise;
  return {
    app, origin, token, url: `${origin}/#${token}`,
    close() {
      return closePromise ??= (async () => {
        const errors = [];
        try { await app.close(); } catch (error) { errors.push(error); }
        try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'server_cleanup_failed', { cause: errors[0] });
      })();
    },
  };
}
