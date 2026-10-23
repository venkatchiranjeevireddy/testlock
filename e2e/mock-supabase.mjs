// MINIMAL LOCAL STAND-IN for the few Supabase endpoints the two apps use (auth, PostgREST, storage).
// For automated browser testing only. It is NOT Supabase and does not test RLS/policies (supabase/test does that on real Postgres).
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 54400);
const files = new Map();            // path -> {buf, type}
const pairs = [];                   // rows
const sets = [];                    // rows
const ADMIN = { id: '00000000-0000-0000-0000-0000000000a1', email: 'admin@example.test' };
const log = (...a) => process.env.QUIET || console.log('[mock]', ...a);

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,HEAD,OPTIONS',
  'access-control-expose-headers': '*',
};
const json = (res, code, body) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

function parseMultipart(buf, contentType) {
  const boundary = '--' + /boundary=(.+)$/.exec(contentType)[1];
  const parts = buf.toString('latin1').split(boundary).slice(1, -1);
  let best = null;
  for (const p of parts) {
    const headEnd = p.indexOf('\r\n\r\n');
    const head = p.slice(0, headEnd);
    if (/filename=/.test(head) || /name=""/.test(head)) {
      const body = Buffer.from(p.slice(headEnd + 4, p.length - 2), 'latin1');
      const ct = /content-type:\s*([^\r\n]+)/i.exec(head);
      best = { buf: body, type: ct ? ct[1] : 'application/octet-stream' };
    }
  }
  return best;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // ---- auth
  if (p === '/auth/v1/token') {
    const now = Math.floor(Date.now() / 1000);
    return json(res, 200, { access_token: 'tok-' + randomUUID(), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'r', user: { id: ADMIN.id, email: ADMIN.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
  }
  if (p === '/auth/v1/logout') { res.writeHead(204, cors); return res.end(); }

  // ---- PostgREST
  if (p === '/rest/v1/admins') return json(res, 200, [{ user_id: ADMIN.id }]);
  if (p === '/rest/v1/target_sets') {
    const rows = [...sets].sort((a, b) => b.version - a.version);
    return json(res, 200, u.searchParams.get('limit') ? rows.slice(0, Number(u.searchParams.get('limit'))) : rows);
  }
  if (p === '/rest/v1/pairs') {
    let rows = [...pairs];
    const idf = u.searchParams.get('id');
    if (idf && idf.startsWith('in.(')) { const ids = idf.slice(4, -1).split(',').map((s) => s.replace(/"/g, '')); rows = rows.filter((r) => ids.includes(r.id)); }
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json(res, 200, rows);
  }
  if (p === '/rest/v1/rpc/register_pair') {
    const a = JSON.parse((await readBody(req)).toString());
    const cur = sets.length ? Math.max(...sets.map((s) => s.version)) : 0;
    if (cur !== a.p_base_version) return json(res, 400, { code: '40001', message: 'version_conflict' });
    const id = randomUUID();
    pairs.push({ id, label: a.p_label, image_path: a.p_image_path, video_path: a.p_video_path, image_width: a.p_image_width, image_height: a.p_image_height, created_at: new Date().toISOString() });
    const prev = sets.length ? sets.find((s) => s.version === cur).pair_ids : [];
    sets.push({ version: cur + 1, mind_path: a.p_mind_path, pair_ids: [...prev, id], created_at: new Date().toISOString() });
    log('registered pair', a.p_label, '-> version', cur + 1);
    return json(res, 200, [{ pair_id: id, version: cur + 1 }]);
  }

  // ---- storage
  const up = /^\/storage\/v1\/object\/wedding-ar\/(.+)$/.exec(p);
  if (up && req.method === 'POST') {
    const body = await readBody(req);
    const ct = req.headers['content-type'] || '';
    const f = ct.startsWith('multipart/') ? parseMultipart(body, ct) : { buf: body, type: ct };
    const path = decodeURIComponent(up[1]);
    if (files.has(path)) return json(res, 400, { message: 'The resource already exists' });
    files.set(path, f);
    log('stored', path, f.buf.length, 'bytes');
    return json(res, 200, { Key: 'wedding-ar/' + path, Id: randomUUID() });
  }
  if (p === '/storage/v1/object/wedding-ar' && req.method === 'DELETE') {
    const { prefixes } = JSON.parse((await readBody(req)).toString());
    prefixes.forEach((x) => files.delete(x));
    log('removed', prefixes);
    return json(res, 200, prefixes.map((name) => ({ name })));
  }
  const pub = /^\/storage\/v1\/object\/public\/wedding-ar\/(.+)$/.exec(p);
  if (pub && (req.method === 'GET' || req.method === 'HEAD')) {
    const f = files.get(decodeURIComponent(pub[1]));
    if (!f) return json(res, 404, { message: 'not found' });
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const s = range[1] ? Number(range[1]) : 0, e = range[2] ? Number(range[2]) : f.buf.length - 1;
      res.writeHead(206, { ...cors, 'content-type': f.type, 'accept-ranges': 'bytes', 'content-range': `bytes ${s}-${e}/${f.buf.length}`, 'content-length': e - s + 1 });
      return res.end(req.method === 'HEAD' ? undefined : f.buf.subarray(s, e + 1));
    }
    res.writeHead(200, { ...cors, 'content-type': f.type, 'accept-ranges': 'bytes', 'content-length': f.buf.length });
    return res.end(req.method === 'HEAD' ? undefined : f.buf);
  }
  if (p === '/__state') return json(res, 200, { files: [...files.keys()], pairs, sets });
  json(res, 404, { message: 'mock: unhandled ' + req.method + ' ' + p });
}).listen(PORT, '127.0.0.1', () => log('listening on', PORT));
