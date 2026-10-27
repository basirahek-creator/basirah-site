// A tiny pretend Supabase (table + file box) so everything can be tested without the real thing.
//   PORT=54321 node dev/mock-supabase.mjs
import http from 'node:http';
const rows = new Map(), files = new Map(), KEY = 'test-service-key';
const port = +process.env.PORT || 54321;
http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, 'http://x'); const chunks = []; for await (const c of rq) chunks.push(c); const body = Buffer.concat(chunks);
  const send = (st, b, ct = 'application/json') => { rs.writeHead(st, { 'content-type': ct }); rs.end(b); };
  if (rq.headers.apikey !== KEY || rq.headers.authorization !== 'Bearer ' + KEY) return send(401, '{"message":"bad key"}');
  if (u.pathname === '/rest/v1/kv') {
    const q = u.searchParams, key = q.get('key') || '';
    if (rq.method === 'POST') {
      for (const r of JSON.parse(body)) rows.set(r.key, { key: r.key, value: r.value });
      return send(201, '');
    }
    if (rq.method === 'DELETE') { if (key.startsWith('eq.')) rows.delete(key.slice(3)); return send(204, ''); }
    let list = [...rows.values()];
    if (key.startsWith('eq.')) list = list.filter((r) => r.key === key.slice(3));
    else if (key.startsWith('like.')) { const pre = key.slice(5).replace(/\*$/, ''); list = list.filter((r) => r.key.startsWith(pre)); }
    list.sort((a, b) => (a.key < b.key ? -1 : 1));
    const off = +q.get('offset') || 0, lim = +q.get('limit') || 1000;
    const sel = (q.get('select') || '*').split(',');
    return send(200, JSON.stringify(list.slice(off, off + lim).map((r) => sel[0] === '*' ? r : Object.fromEntries(sel.map((s) => [s, r[s]])))));
  }
  const m = /^\/storage\/v1\/object\/basirah\/(.+)$/.exec(u.pathname);
  if (m) {
    const k = decodeURIComponent(m[1]);
    if (rq.method === 'POST') { files.set(k, body); return send(200, '{"Key":"x"}'); }
    if (rq.method === 'DELETE') { if (!files.has(k)) return send(404, '{"error":"not_found"}'); files.delete(k); return send(200, '{}'); }
    if (rq.method === 'GET') return files.has(k) ? send(200, files.get(k), 'application/octet-stream') : send(400, '{"error":"not_found"}');
  }
  send(404, '{}');
}).listen(port, () => console.log('mock supabase on ' + port));
