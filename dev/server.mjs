// Local preview: serves the admin page and the same API rules used on Netlify.
//   ADMIN_PASSWORD=demo node dev/server.mjs [--seed] [--site path/to/index.html]
import http from 'node:http';
import { readFile, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleAdmin, handleSubmit, handleSettings, handleReport, memoryStore, PACKAGES } from '../netlify/lib/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const sitePath = siteIdx >= 0 ? path.resolve(args[siteIdx + 1]) : null;
const port = +process.env.PORT || 8888;
const env = { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'demo' };
const dir = path.join(root, '.data');
await mkdir(dir, { recursive: true });

const fileStore = {
  async get(k) { try { return JSON.parse(await readFile(path.join(dir, k.replace('/', '_') + '.json'), 'utf8')); } catch { return null; } },
  async set(k, v) { await writeFile(path.join(dir, k.replace('/', '_') + '.json'), JSON.stringify(v)); },
  async delete(k) { const f = path.join(dir, k.replace('/', '_')); await rm(f + '.json', { force: true }); await rm(f + '.bin', { force: true }); },
  async getBin(k) { try { return await readFile(path.join(dir, k.replace('/', '_') + '.bin')); } catch { return null; } },
  async setBin(k, buf) { await writeFile(path.join(dir, k.replace('/', '_') + '.bin'), buf); },
  async list(prefix = 'sub/') { const pre = prefix.replace('/', '_'); return (await readdir(dir)).filter((f) => f.startsWith(pre)).map((f) => f.replace('_', '/').replace(/\.json$/, '')); },
};

if (args.includes('--seed') && !(await fileStore.list()).length) {
  const names = ['Noura Alharbi', 'Faisal Alotaibi', 'Maryam Khan', 'Abdullah Salem', 'Sara Mohammed', 'Khalid Aldossari', 'Layla Hassan', 'Omar Yusuf', 'Huda Alzahrani', 'Yasir Qureshi', 'Reem Alshehri', 'Tariq Mansour'];
  const qs = ['What color do you most enjoy wearing?', 'What is your favorite animal, and why?', 'What is your greatest dream?'];
  const H = 3600e3, nowMs = Date.now();
  for (let i = 0; i < names.length; i++) {
    const pkg = i % 3 === 1 ? 'consultation' : 'profile';
    const id = 'BSR-' + (1000 + i * 37).toString(36).toUpperCase().padStart(5, 'A');
    const created = new Date(nowMs - (i * 9 + 2) * H).toISOString();
    const body = { submission_id: id, full_name: names[i], package: pkg, contact_method: ['Email', 'WhatsApp', 'Mobile'][i % 3],
      contact: i % 3 === 0 ? names[i].split(' ')[0].toLowerCase() + '@example.com' : '+9665' + (10000000 + i * 1111111), payment_reference: 'TX' + (480000 + i * 731),
      payment_receipt: 'https://example.com/receipt-' + i + '.jpg', language: i % 4 === 3 ? 'ar' : 'en', consent_given: true, consent_at: new Date(nowMs - (i * 9 + 2.2) * H).toISOString(), consent_language: i % 4 === 3 ? 'ar' : 'en' };
    qs.forEach((q, k) => { body['Q' + String(k + 1).padStart(2, '0') + ' - ' + q] = k === 1 && i === 2 ? 'VOICE ANSWER - tap to listen: https://example.com/voice.webm' : (k === 2 && i % 2 ? 'SKIPPED BY CLIENT' : 'Sample answer ' + (k + 1) + ' from ' + names[i].split(' ')[0] + '.'); });
    await handleSubmit(new Request('http://x/api/submissions', { method: 'POST', body: JSON.stringify(body) }), fileStore);
    const rec = await fileStore.get('sub/' + id);
    rec.created_at = created; rec.history[0].at = created;
    const hrs = (h) => new Date(nowMs - h * H).toISOString();
    if (i >= 3) { rec.payment_status = 'verified'; rec.verified_at = hrs(i * 9 - 4); rec.history.push({ at: rec.verified_at, by: 'admin', action: 'Payment verified' }); }
    if (i === 4 || i === 5) { rec.report_status = 'in_progress'; rec.history.push({ at: hrs(i * 3), by: 'admin', action: 'Report preparation started' }); }
    if (i === 6) { rec.report_status = 'ready'; }
    if (i >= 7 && i <= 9) { rec.report_status = 'delivered'; rec.delivered_at = hrs(i); rec.history.push({ at: rec.delivered_at, by: 'admin', action: 'Report delivered to client' }); }
    if (i === 10) { rec.payment_status = 'rejected'; rec.notes = 'Receipt amount did not match.'; }
    if (pkg === 'consultation' && rec.report_status === 'delivered') rec.consult_status = 'completed';
    await fileStore.set('sub/' + id, rec);
  }
  console.log('Seeded demo data');
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };
const server = http.createServer(async (rq, rs) => {
  try {
    const url = new URL(rq.url, 'http://localhost:' + port);
    const chunks = []; for await (const c of rq) chunks.push(c);
    const body = Buffer.concat(chunks);
    const mk = () => new Request(url, { method: rq.method, headers: rq.headers, body: ['GET', 'HEAD'].includes(rq.method) ? undefined : body });
    const send = async (res) => { rs.writeHead(res.status, Object.fromEntries(res.headers)); rs.end(Buffer.from(await res.arrayBuffer())); };
    if (url.pathname.startsWith('/api/admin')) return send(await handleAdmin(mk(), fileStore, env));
    if (url.pathname === '/api/submissions') return send(await handleSubmit(mk(), fileStore));
    if (url.pathname === '/api/settings') return send(await handleSettings(mk(), fileStore));
    if (url.pathname.startsWith('/r/')) return send(await handleReport(mk(), fileStore));
    if (url.pathname === '/api/upload') return send(new Response(JSON.stringify({ url: 'https://example.com/uploaded-' + Date.now() }), { headers: { 'content-type': 'application/json' } }));
    if (url.pathname === '/' && sitePath) return send(new Response(await readFile(sitePath), { headers: { 'content-type': types['.html'] } }));
    if (sitePath && !url.pathname.startsWith('/admin')) { const sf = path.join(path.dirname(path.resolve(sitePath)), url.pathname); if (sf.startsWith(path.dirname(path.resolve(sitePath))) && existsSync(sf) && !sf.endsWith('/')) { rs.writeHead(200, { 'content-type': types[path.extname(sf)] || 'application/octet-stream' }); return rs.end(await readFile(sf)); } }
    let p = url.pathname === '/admin' ? '/admin/' : url.pathname;
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !existsSync(f)) { rs.writeHead(404); return rs.end('Not found'); }
    rs.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); rs.end(await readFile(f));
  } catch (e) { console.error(e); rs.writeHead(500); rs.end('Server error'); }
});
server.listen(port, () => console.log(`Basirah dev server: http://localhost:${port}/admin/  (password: ${env.ADMIN_PASSWORD})`));
