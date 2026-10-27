// Tests for the storage rules: node dev/test.mjs
import assert from 'node:assert/strict';
import { handleAdmin, handleSubmit, handleTranslate, handleSettings, handleReport, handleUpload, handleFile, handleReview, handleShare, handlePromo, handleImage, normPhone, memoryStore } from '../netlify/lib/core.mjs';

const store = memoryStore();
const env = { ADMIN_PASSWORD: 'pw' };
const rq = (method, url, body, token) => new Request('http://x' + url, { method, headers: { authorization: token ? 'Bearer ' + token : '' }, body: body === undefined ? undefined : JSON.stringify(body) });
const adm = async (method, url, body, token) => { const r = await handleAdmin(rq(method, url, body, token), store, env); return [r.status, await r.json()]; };
const good = { submission_id: 'BSR-ABC123', full_name: 'Test User', package: 'consultation', price_sar: 1, contact_method: 'Email', contact: 'a@b.co', payment_reference: 'TX1', payment_receipt: 'https://r/1', language: 'ar',
  'Q02 - Second?': 'two', 'Q01 - First?': 'one', 'Q03 - Third?': 'VOICE ANSWER - tap to listen: https://v/1', consent_given: true, consent_at: '2026-10-18T10:00:00Z', consent_language: 'ar' };

// public submit
let r = await handleSubmit(rq('POST', '/api/submissions', good), store); assert.equal(r.status, 201);
r = await handleSubmit(rq('POST', '/api/submissions', good), store); assert.equal((await r.json()).duplicate, true);   // retry is idempotent
assert.equal((await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: 'bad' }), store)).status, 400);
assert.equal((await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: 'BSR-ZZZ999', package: 'x' }), store)).status, 400);
assert.equal((await handleSubmit(rq('GET', '/api/submissions'), store)).status, 405);
assert.equal((await handleSubmit(new Request('http://x', { method: 'POST', body: 'x'.repeat(600000) }), store)).status, 413);

// auth
assert.equal((await adm('GET', '/api/admin/submissions'))[0], 401);
assert.equal((await adm('POST', '/api/admin/login', { password: 'nope' }))[0], 401);
const [s, { token }] = await adm('POST', '/api/admin/login', { password: 'pw' }); assert.equal(s, 200);
assert.equal((await adm('GET', '/api/admin/submissions', undefined, token + 'x'))[0], 401);
// many phones and computers can be signed in at the same time, and "keep me signed in" lasts 30 days
const sessions = await Promise.all(Array.from({ length: 8 }, () => adm('POST', '/api/admin/login', { password: 'pw', remember: true })));
for (const [sc, sj] of sessions) { assert.equal(sc, 200); assert.equal(sj.expires_in, 30 * 86400); assert.equal((await adm('GET', '/api/admin/submissions', undefined, sj.token))[0], 200); }
assert.equal((await adm('POST', '/api/admin/login', { password: 'pw' }))[1].expires_in, 12 * 3600);

// list hides answers, server decides price
let [, l] = await adm('GET', '/api/admin/submissions', undefined, token);
assert.equal(l.submissions.length, 1); assert.equal(l.submissions[0].price_sar, 400); assert.equal(l.submissions[0].answered, 2); assert.equal(l.submissions[0].voice, 1);
assert.equal(l.submissions[0].answers, undefined);
let [, d] = await adm('GET', '/api/admin/submissions/BSR-ABC123', undefined, token);
assert.deepEqual(d.submission.answers.map((a) => a.n), [1, 2, 3]);
assert.equal(d.submission.consent_at, '2026-10-18T10:00:00.000Z'); assert.equal(d.submission.consent_language, 'ar');
let u = d.submission.updated_at;

// workflow rules
let [c, e] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, report_status: 'in_progress' }, token);
assert.equal(c, 409); assert.match(e.error, /Verify the payment/);
[c, e] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, payment_status: 'verified' }, token);
assert.equal(c, 200); assert.ok(e.submission.verified_at);
await new Promise((r) => setTimeout(r, 5));
// stale write is refused
[c, e] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, notes: 'stale' }, token);
assert.equal(c, 409); assert.equal(e.submission.notes, '');
u = e.submission.updated_at;
[c, e] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, report_status: 'in_progress' }, token); assert.equal(c, 200); u = e.submission.updated_at;
[c, e] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, payment_status: 'rejected' }, token);
assert.equal(c, 409); assert.match(e.error, /Not started/);
await new Promise((r) => setTimeout(r, 5));
[c, e] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, report_status: 'delivered', consult_status: 'scheduled', consult_at: '2030-01-01T10:00', notes: 'ok' }, token);
assert.equal(c, 200); assert.ok(e.submission.delivered_at); assert.equal(e.submission.consult_status, 'scheduled'); assert.equal(e.submission.notes, 'ok');
assert.ok(e.submission.history.length >= 6);
u = e.submission.updated_at;
[c] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, report_status: 'bogus' }, token); assert.equal(c, 400);
// no-op patch does not touch the record
await new Promise((r) => setTimeout(r, 5));
[c, e] = await adm('PATCH', '/api/admin/submissions/BSR-ABC123', { updated_at: u, notes: 'ok' }, token); assert.equal(e.submission.updated_at, u);

// manual add + delete
[c, e] = await adm('POST', '/api/admin/submissions', { full_name: 'Old Client', contact: 'x@y.z', package: 'profile', created_at: '2026-01-02' }, token);
assert.equal(c, 201); assert.match(e.submission.id, /^BSR-M/); assert.equal(e.submission.created_at.slice(0, 10), '2026-01-02');
[c] = await adm('DELETE', '/api/admin/submissions/' + e.submission.id, undefined, token); assert.equal(c, 200);
[c] = await adm('GET', '/api/admin/submissions/' + e.submission.id, undefined, token); assert.equal(c, 404);
// feedback report library
let [dc, dd] = await adm('PUT', '/api/admin/docs/r-BSR-ABC123', { title: 'Report', docs: { en: '<p>Hi</p>', ar: '<p>مرحبا</p>' }, submissionId: 'BSR-ABC123', opts: { layout: 'side' } }, token);
assert.equal(dc, 200); assert.equal(dd.doc.submissionId, 'BSR-ABC123');
[dc, dd] = await adm('GET', '/api/admin/submissions/BSR-ABC123', undefined, token); assert.equal(dd.report_link.id, 'r-BSR-ABC123');
[dc, dd] = await adm('GET', '/api/admin/submissions', undefined, token); assert.equal(dd.submissions[0].has_report, true);
[dc, dd] = await adm('GET', '/api/admin/docs', undefined, token); assert.equal(dd.docs.length, 1);
assert.equal((await adm('PUT', '/api/admin/docs/x', { docs: {} }, token))[0], 400);
assert.equal((await adm('PUT', '/api/admin/docs/bad id', { docs: { en: '', ar: '' } }, token))[0], 400);
assert.equal((await adm('GET', '/api/admin/docs', undefined))[0], 401);
// translation: off without key, parses fenced JSON with a key
assert.equal((await handleTranslate(rq('POST', '/x', { prompt: 'p' }), {})).status, 503);
assert.equal((await (await handleTranslate(rq('GET', '/x'), {})).json()).enabled, false);
assert.equal((await (await handleTranslate(rq('GET', '/x'), { ANTHROPIC_API_KEY: 'k' })).json()).enabled, true);
const fake = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '```json\n["a","b"]\n```' }] }), { status: 200 });
r = await handleTranslate(rq('POST', '/x', { prompt: 'p' }), { ANTHROPIC_API_KEY: 'k' }, fake); assert.deepEqual((await r.json()).result, ['a', 'b']);
r = await handleTranslate(rq('POST', '/x', { prompt: 'p' }), { ANTHROPIC_API_KEY: 'k' }, async () => new Response('{}', { status: 429 })); assert.equal(r.status, 429);
// Netlify's own Claude address is used when it provides one; failures say why
let seenUrl = ''; await handleTranslate(rq('POST', '/x', { prompt: 'p' }), { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gw.example/anthropic/' }, async (u) => { seenUrl = u; return fake(); }); assert.equal(seenUrl, 'https://gw.example/anthropic/v1/messages');
await handleTranslate(rq('POST', '/x', { prompt: 'p' }), { ANTHROPIC_API_KEY: 'k' }, async (u) => { seenUrl = u; return fake(); }); assert.equal(seenUrl, 'https://api.anthropic.com/v1/messages');
r = await handleTranslate(rq('POST', '/x', { prompt: 'p' }), { ANTHROPIC_API_KEY: 'k' }, async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 }));
{ const j = await r.json(); assert.equal(r.status, 502); assert.equal(j.code, 'failed'); assert.match(j.detail, /HTTP 401 - authentication_error: invalid x-api-key/); }
r = await handleTranslate(rq('POST', '/x', { prompt: 'p' }), { ANTHROPIC_API_KEY: 'k' }, async () => { throw new Error('getaddrinfo ENOTFOUND'); }); assert.match((await r.json()).detail, /ENOTFOUND/);
// settings: phone numbers, payment methods, QR codes
assert.equal(normPhone('0551234567'), '966551234567'); assert.equal(normPhone('+966 55 123 4567'), '966551234567'); assert.equal(normPhone('00966551234567'), '966551234567'); assert.equal(normPhone('551234567'), '966551234567'); assert.equal(normPhone('12'), '');
let [sc, sd] = await adm('GET', '/api/admin/settings', undefined, token); assert.equal(sc, 200); assert.deepEqual(sd.settings.whatsapp, []);
assert.equal((await adm('GET', '/api/admin/settings'))[0], 401);
const png = 'data:image/png;base64,' + Buffer.from('x'.repeat(200)).toString('base64');
const cfg = { business_name: 'Basirah', whatsapp: [{ label: 'Consultations', label_ar: 'الاستشارات', number: '0551234567' }, { label: 'Support', number: '+966 50 000 0000' }],
  payments: [{ kind: 'stc', label: 'STC Pay', value: '0551234567', holder: 'EHSAN' }, { kind: 'qr', label: 'Bank QR', qr: [{ src: png, caption: 'Al Rajhi' }, { src: png }] }, { kind: 'link', label: 'Apple Pay / card', url: 'https://pay.example.com/x' }],
  templates: { report: { en: 'Hi {name}, {link}', ar: '' } }, show_default_qr: false };
[sc, sd] = await adm('PUT', '/api/admin/settings', { ...cfg, updated_at: null }, token); assert.equal(sc, 200, JSON.stringify(sd));
assert.equal(sd.settings.whatsapp[0].number, '966551234567'); assert.equal(sd.settings.payments[1].qr.length, 2); assert.equal(sd.settings.show_default_qr, false);
const sv = sd.settings.updated_at;
assert.equal((await adm('PUT', '/api/admin/settings', { ...cfg, updated_at: 'old' }, token))[0], 409);   // stale window
assert.equal((await adm('PUT', '/api/admin/settings', { ...cfg, whatsapp: [{ number: 'abc' }], updated_at: sv }, token))[0], 400);
assert.equal((await adm('PUT', '/api/admin/settings', { ...cfg, payments: [{ label: 'X', url: 'javascript:alert(1)' }], updated_at: sv }, token))[0], 400);
assert.equal((await adm('PUT', '/api/admin/settings', { ...cfg, payments: [{ label: 'X' }], updated_at: sv }, token))[0], 400);
assert.equal((await adm('PUT', '/api/admin/settings', { ...cfg, payments: [{ label: 'X', qr: [{ src: 'https://evil/x.png' }] }], updated_at: sv }, token))[0], 400);
const pub = await (await handleSettings(rq('GET', '/api/settings'), store)).json();
assert.equal(pub.whatsapp.length, 2); assert.equal(pub.templates, undefined); assert.equal(pub.updated_at, undefined); assert.equal(pub.payments[2].url, 'https://pay.example.com/x');
assert.equal((await handleSettings(rq('POST', '/api/settings', {}), store)).status, 405);
// questions: null = original, custom list is validated and hidden ones stay private
assert.equal((await handleSettings(rq('GET', '/api/settings'), store).then((r) => r.json())).questions, null);
const qcfg = { ...cfg, questions: [{ id: 'q1', en: 'First?', ar: 'الأول؟', required: true }, { id: 'q2', en: 'Second?', ar: '', hidden: true }, { id: 'n9', en: '', ar: 'ثالث', required: false }, { en: 'Fourth?', ar: 'رابع؟' }] };
let [qc, qd] = await adm('PUT', '/api/admin/settings', { ...qcfg, updated_at: sv }, token); assert.equal(qc, 200, JSON.stringify(qd));
assert.equal(qd.settings.questions.length, 4); assert.equal(qd.settings.questions[1].hidden, true); assert.ok(/^[A-Za-z0-9_-]{2,40}$/.test(qd.settings.questions[3].id));
const pubq = (await (await handleSettings(rq('GET', '/api/settings'), store)).json()).questions; assert.equal(pubq.length, 3); assert.deepEqual(pubq.map((q) => q.id).slice(0, 2), ['q1', 'n9']); assert.equal(pubq[0].required, true); assert.equal(pubq.some((q) => q.hidden !== undefined), false);
const sv2 = qd.settings.updated_at;
assert.equal((await adm('PUT', '/api/admin/settings', { ...qcfg, questions: [{ en: '', ar: '' }], updated_at: sv2 }, token))[0], 400);
assert.equal((await adm('PUT', '/api/admin/settings', { ...qcfg, questions: [{ en: 'x', hidden: true }], updated_at: sv2 }, token))[0], 400);
assert.equal((await adm('PUT', '/api/admin/settings', { ...qcfg, questions: Array(81).fill({ en: 'x' }), updated_at: sv2 }, token))[0], 400);
[qc, qd] = await adm('PUT', '/api/admin/settings', { ...qcfg, questions: [{ id: 'a1', en: 'A' }, { id: 'a1', en: 'B' }], updated_at: sv2 }, token); assert.equal(qc, 200); assert.notEqual(qd.settings.questions[0].id, qd.settings.questions[1].id);   // duplicate ids are fixed
[qc, qd] = await adm('PUT', '/api/admin/settings', { ...cfg, questions: null, updated_at: qd.settings.updated_at }, token); assert.equal(qc, 200); assert.equal(qd.settings.questions, null);   // reset to the original questions
// payment method the client chose is kept
r = await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: 'BSR-PAY111', payment_method: 'STC Pay' }), store); assert.equal(r.status, 201);
assert.equal((await adm('GET', '/api/admin/submissions/BSR-PAY111', undefined, token))[1].submission.payment_method, 'STC Pay');
// contact log
[c, e] = await adm('POST', '/api/admin/submissions/BSR-PAY111/contact', { channel: 'whatsapp', what: 'Report ready' }, token);
assert.equal(c, 200); assert.match(e.submission.history.at(-1).action, /WhatsApp.*Report ready/); assert.ok(e.submission.last_contacted_at);
assert.equal((await adm('POST', '/api/admin/submissions/BSR-PAY111/contact', { channel: 'pigeon' }, token))[0], 400);
// private report link
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 1)]);
const put = (body, tk = token) => handleAdmin(new Request('http://x/api/admin/submissions/BSR-PAY111/pdf', { method: 'PUT', headers: { authorization: 'Bearer ' + tk }, body }), store, env);
assert.equal((await put(pdfBytes, 'bad')).status, 401);
assert.equal((await put(Buffer.from('not a pdf at all'.repeat(20)))).status, 400);
assert.equal((await put(Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(4_100_000)]))).status, 413);
let pr = await put(pdfBytes); assert.equal(pr.status, 200); let pj = await pr.json(); assert.match(pj.pdf_link.path, /^\/r\/[A-Za-z0-9_-]{11}$/);
const tokn = pj.pdf_link.token;
const open1 = await handleReport(rq('GET', pj.pdf_link.path + '/download'), store); assert.equal(open1.status, 200); assert.equal(open1.headers.get('content-type'), 'application/pdf'); assert.match(open1.headers.get('content-disposition'), /^attachment/); assert.equal((await open1.arrayBuffer()).byteLength, pdfBytes.length);
const pageRes = await handleReport(rq('GET', pj.pdf_link.path), store); assert.equal(pageRes.status, 200); assert.match(pageRes.headers.get('content-type'), /text\/html/);
const html = await pageRes.text(); assert.ok(html.includes('/download')); assert.ok(html.includes('wa.me/966551234567')); assert.ok(html.includes('Download PDF'));
assert.equal((await handleReport(rq('GET', pj.pdf_link.path + '/view'), store)).headers.get('content-disposition').startsWith('inline'), true);
assert.equal((await handleReport(rq('GET', pj.pdf_link.path + '/nope'), store)).status, 404);
// the dashboard can see the client opened and downloaded it, but link previews do not count
let seen = (await adm('GET', '/api/admin/submissions/BSR-PAY111', undefined, token))[1].pdf_link; assert.ok(seen.opened_at); assert.ok(seen.downloaded_at); const opens0 = seen.opens;
await handleReport(new Request('http://x' + pj.pdf_link.path, { headers: { 'user-agent': 'WhatsApp/2.23' } }), store);
assert.equal((await adm('GET', '/api/admin/submissions/BSR-PAY111', undefined, token))[1].pdf_link.opens, opens0);
pj = await (await put(pdfBytes)).json(); assert.equal(pj.pdf_link.token, tokn); assert.equal(pj.pdf_link.opens, opens0);   // republishing keeps the same link and its history
assert.equal((await handleReport(rq('GET', '/r/' + 'A'.repeat(22)), store)).status, 404); assert.equal((await handleReport(rq('GET', '/r/short'), store)).status, 404);
[c, e] = await adm('GET', '/api/admin/submissions/BSR-PAY111', undefined, token); assert.equal(e.pdf_link.token, tokn);
[c, e] = await adm('GET', '/api/admin/submissions', undefined, token); assert.equal(e.submissions.find((x) => x.id === 'BSR-PAY111').has_pdf, true);
[c, e] = await adm('DELETE', '/api/admin/submissions/BSR-PAY111/pdf', undefined, token); assert.equal(e.pdf_link, null);
assert.equal((await handleReport(rq('GET', '/r/' + tokn), store)).status, 404);                          // switched off
const mine = await handleAdmin(new Request('http://x/api/admin/submissions/BSR-PAY111/pdf', { headers: { authorization: 'Bearer ' + token } }), store, env); assert.equal(mine.status, 404);
const live = (await (await put(pdfBytes)).json()).pdf_link.path;
{ const mine2 = await handleAdmin(new Request('http://x/api/admin/submissions/BSR-PAY111/pdf', { headers: { authorization: 'Bearer ' + token } }), store, env); assert.equal(mine2.status, 200); assert.equal((await mine2.arrayBuffer()).byteLength, pdfBytes.length);
  assert.equal((await handleAdmin(new Request('http://x/api/admin/submissions/BSR-PAY111/pdf'), store, env)).status, 401); } assert.equal((await handleReport(rq('GET', live), store)).status, 200);
[c] = await adm('DELETE', '/api/admin/submissions/BSR-PAY111', undefined, token);
assert.equal((await handleReport(rq('GET', live), store)).status, 404); assert.equal((await handleReport(rq('GET', live + '/download'), store)).status, 404);   // deleting a client removes the link
// deleting a client removes their report too
[c] = await adm('DELETE', '/api/admin/submissions/BSR-ABC123', undefined, token);
assert.equal((await adm('GET', '/api/admin/docs', undefined, token))[1].docs.length, 0);
// missing password config fails closed
assert.equal((await handleAdmin(rq('GET', '/api/admin/submissions', undefined, token), store, {})).status, 503);

// ---- files clients attach (voice answers, receipts) ----
const upl = (type, bytes) => handleUpload(new Request('https://site.test/api/upload', { method: 'POST', headers: { 'content-type': type }, body: bytes }), store);
const audio = Buffer.from('OggS-fake-audio-bytes-0123456789');
let up = await upl('audio/webm;codecs=opus', audio); assert.equal(up.status, 200);
const upUrl = (await up.json()).url; assert.match(upUrl, /^https:\/\/site\.test\/api\/file\/[A-Za-z0-9_-]{16}\.webm$/);
const getF = (u, h = {}) => handleFile(new Request(u, { headers: h }), store);
let f = await getF(upUrl); assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'audio/webm'); assert.equal(Buffer.from(await f.arrayBuffer()).toString(), audio.toString());
f = await getF(upUrl, { range: 'bytes=0-3' }); assert.equal(f.status, 206); assert.equal(f.headers.get('content-range'), 'bytes 0-3/' + audio.length); assert.equal(Buffer.from(await f.arrayBuffer()).toString(), 'OggS');
f = await getF(upUrl, { range: 'bytes=-4' }); assert.equal(f.status, 206); assert.equal((await f.arrayBuffer()).byteLength, 4);
assert.equal((await getF(upUrl, { range: 'bytes=999-1000' })).status, 416);
assert.equal((await getF('https://site.test/api/file/doesnotexist1234')).status, 404);
assert.equal((await upl('text/html', '<script>')).status, 415);
assert.equal((await upl('image/jpeg', Buffer.alloc(0))).status, 400);
assert.equal((await upl('image/jpeg', Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
// packages: editable prices and names; server uses the saved price
{
  const [, cur] = await adm('GET', '/api/admin/settings', undefined, token);
  const base = { ...cur.settings };
  const pk = (o = {}) => [{ id: 'profile', price: 250, name: 'Profile', name_ar: 'ملف', desc: 'd', desc_ar: 'و', ...o }, { id: 'consultation', price: '500', name: 'Pro', name_ar: 'برو', hidden: false }];
  let [c, d] = await adm('PUT', '/api/admin/settings', { ...base, packages: pk(), info: { duration_en: '30 minutes', delivery_en: '48 hours' }, updated_at: base.updated_at }, token);
  assert.equal(c, 200); assert.equal(d.settings.packages[1].price, 500); assert.equal(d.settings.info.delivery_en, '48 hours');
  const pub = await (await handleSettings(rq('GET', '/api/settings'), store)).json();
  assert.equal(pub.packages[0].price, 250); assert.equal(pub.info.duration_en, '30 minutes');
  const rs = await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: 'BSR-PRICE1', package: 'consultation' }), store); assert.equal(rs.status, 201);
  assert.equal((await adm('GET', '/api/admin/submissions/BSR-PRICE1', undefined, token))[1].submission.price_sar, 500);
  let v = d.settings.updated_at;
  assert.equal((await adm('PUT', '/api/admin/settings', { ...base, packages: pk({ price: 0 }), updated_at: v }, token))[0], 400);
  assert.equal((await adm('PUT', '/api/admin/settings', { ...base, packages: pk({ name_ar: '' }), updated_at: v }, token))[0], 400);
  assert.equal((await adm('PUT', '/api/admin/settings', { ...base, packages: pk().map((x) => ({ ...x, hidden: true })), updated_at: v }, token))[0], 400);
  [c, d] = await adm('PUT', '/api/admin/settings', { ...base, packages: null, info: null, updated_at: v }, token);
  assert.equal(c, 200); assert.equal(d.settings.packages, null);
}
// reviews: private link, one review per client, consent, featured list on the public settings
{
  const [lc, ld] = await adm('POST', '/api/admin/submissions/BSR-PRICE1/review-link', undefined, token);
  assert.equal(lc, 200); assert.ok(/^\/v\/[A-Za-z0-9_-]{11}$/.test(ld.review_link.path));
  const [, ld2] = await adm('POST', '/api/admin/submissions/BSR-PRICE1/review-link', undefined, token); assert.equal(ld2.review_link.token, ld.review_link.token);   // same link every time
  const rvq = (method, path, body) => handleReview(new Request('http://x' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), store);
  const page = await rvq('GET', ld.review_link.path); assert.equal(page.status, 200);
  const html = await page.text(); assert.ok(html.includes('og:image') && html.includes('/og-star.png') && html.includes('data-q="overall"'));
  assert.equal((await rvq('GET', '/v/AAAAAAAAAAA')).status, 404);
  assert.equal((await rvq('POST', ld.review_link.path, { answers: { valued: 'x' } })).status, 400);   // required answers missing
  const ok = await rvq('POST', ld.review_link.path, { answers: { overall: 5, accuracy: 4, recommend: 10, valued: 'It felt like being seen.' }, share: true, display: 'first', lang: 'en' });
  assert.equal(ok.status, 201);
  assert.equal((await rvq('POST', ld.review_link.path, { answers: { overall: 1, accuracy: 1, recommend: 0 } })).status, 409);   // only once
  const [, lst] = await adm('GET', '/api/admin/reviews', undefined, token);
  assert.equal(lst.reviews.length, 1); assert.equal(lst.reviews[0].stars, 5); assert.equal(lst.reviews[0].quote, 'It felt like being seen.');
  const subr = (await adm('GET', '/api/admin/submissions/BSR-PRICE1', undefined, token))[1].submission; assert.ok(subr.review_at && subr.review_requested_at);
  let [fc] = await adm('PUT', '/api/admin/reviews/BSR-PRICE1', { featured: true }, token); assert.equal(fc, 200);
  let pub2 = await (await handleSettings(rq('GET', '/api/settings'), store)).json();
  assert.equal(pub2.testimonials.length, 1); assert.equal(pub2.testimonials[0].stars, 5); assert.equal(pub2.testimonials[0].name, 'Test');
  assert.ok(!('review_questions' in pub2));
  [fc] = await adm('PUT', '/api/admin/reviews/BSR-PRICE1', { quote: 'Edited words', display_name: 'Sara K.' }, token); assert.equal(fc, 200);
  pub2 = await (await handleSettings(rq('GET', '/api/settings'), store)).json(); assert.equal(pub2.testimonials[0].quote, 'Edited words'); assert.equal(pub2.testimonials[0].name, 'Sara K.');
  // no consent => cannot be shown
  await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: 'BSR-NOSHR1' }), store);
  const l2 = (await adm('POST', '/api/admin/submissions/BSR-NOSHR1/review-link', undefined, token))[1].review_link;
  await rvq('POST', l2.path, { answers: { overall: 3, accuracy: 3, recommend: 6, valued: 'ok' }, share: false });
  assert.equal((await adm('PUT', '/api/admin/reviews/BSR-NOSHR1', { featured: true }, token))[0], 409);
  // custom review questions, saved in settings
  const [, cs] = await adm('GET', '/api/admin/settings', undefined, token);
  let [qc2, qd2] = await adm('PUT', '/api/admin/settings', { ...cs.settings, review_questions: [{ id: 'x1', type: 'text', en: 'Anything?', ar: '', required: true }], updated_at: cs.settings.updated_at }, token); assert.equal(qc2, 200);
  assert.equal((await adm('PUT', '/api/admin/settings', { ...cs.settings, review_questions: [{ en: '', ar: '' }], updated_at: qd2.settings.updated_at }, token))[0], 400);
  [qc2, qd2] = await adm('PUT', '/api/admin/settings', { ...cs.settings, review_questions: null, updated_at: qd2.settings.updated_at }, token); assert.equal(qd2.settings.review_questions, null);
  // name policy set by the admin overrides what the client picks
  {
    const [, c0] = await adm('GET', '/api/admin/settings', undefined, token);
    const [pc, pd] = await adm('PUT', '/api/admin/settings', { ...c0.settings, review_name: 'anon', updated_at: c0.settings.updated_at }, token); assert.equal(pc, 200); assert.equal(pd.settings.review_name, 'anon');
    assert.ok(!('review_name' in (await (await handleSettings(rq('GET', '/api/settings'), store)).json())));
    await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: 'BSR-ANON01' }), store);
    const l3 = (await adm('POST', '/api/admin/submissions/BSR-ANON01/review-link', undefined, token))[1].review_link;
    assert.ok(!(await (await rvq('GET', l3.path)).text()).includes('id="disp"'));          // no name choice shown
    await rvq('POST', l3.path, { answers: { overall: 5, accuracy: 5, recommend: 9, valued: 'Lovely' }, share: true, display: 'full', lang: 'en' });
    const got = (await adm('GET', '/api/admin/reviews', undefined, token))[1].reviews.find((r) => r.sid === 'BSR-ANON01');
    assert.equal(got.display, 'anon'); assert.equal(got.display_name, 'A Basirah client');
    await adm('PUT', '/api/admin/settings', { ...pd.settings, review_name: 'choose', updated_at: pd.settings.updated_at }, token);
  }
  // share page and delete cascade
  const sh = await handleShare(new Request('http://x/s')); assert.ok((await sh.text()).includes('og:image'));
  assert.equal((await adm('DELETE', '/api/admin/submissions/BSR-PRICE1', undefined, token))[0], 200);
  assert.equal((await rvq('GET', ld.review_link.path)).status, 404);
  pub2 = await (await handleSettings(rq('GET', '/api/settings'), store)).json(); assert.equal(pub2.testimonials.length, 0);
}
// the files go when the client record is deleted
await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: 'BSR-FILE01', payment_receipt: upUrl }), store);
assert.equal((await adm('DELETE', '/api/admin/submissions/BSR-FILE01', undefined, token))[0], 200);
assert.equal((await getF(upUrl)).status, 404);
// free translator route: no key needed, chunks are translated one by one
{
  const seen = [];
  const free = async (url) => { const u = new URL(url); seen.push(u.searchParams.get('q')); return new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'AR:' + u.searchParams.get('q') } }), { status: 200 }); };
  const long = 'First sentence here. Second one follows! ' + 'x'.repeat(10) + '. ' + 'Word '.repeat(150);
  const r = await handleTranslate(new Request('http://x/api/admin/translate', { method: 'POST', body: JSON.stringify({ texts: ['Hello world', '', long], to: 'ar' }) }), {}, free);
  const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.result.length, 3); assert.equal(j.result[0], 'AR:Hello world'); assert.equal(j.result[1], '');
  assert.ok(seen.every((q) => q.length <= 440), 'chunks stay small'); assert.ok(seen.length >= 3);
  const full = async () => new Response(JSON.stringify({ responseStatus: 429, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }), { status: 200 });
  const q = await handleTranslate(new Request('http://x/api/admin/translate', { method: 'POST', body: JSON.stringify({ texts: ['Hi there'], to: 'ar' }) }), {}, full);
  assert.equal(q.status, 429); assert.ok((await q.json()).detail.includes('tomorrow'));
  assert.equal((await handleTranslate(new Request('http://x/t', { method: 'POST', body: JSON.stringify({ texts: [5], to: 'ar' }) }), {}, free)).status, 400);
}
// the old plain greeting is upgraded to the new default; a custom greeting is kept
{
  const [, g0] = await adm('GET', '/api/admin/settings', undefined, token);
  const old = { en: 'Hello, I would like to ask about the Basirah assessment.', ar: 'السلام عليكم، أرغب في الاستفسار عن تقييم بصيرة.' };
  await store.set('settings', { ...g0.settings, wa_greeting: old });
  const g1 = (await adm('GET', '/api/admin/settings', undefined, token))[1].settings.wa_greeting;
  assert.ok(g1.en.includes('{site}') && g1.ar.includes('{site}'));
  assert.ok((await (await handleSettings(rq('GET', '/api/settings'), store)).json()).wa_greeting.en.includes('Basirah by EhsanKey'));
  await store.set('settings', { ...g0.settings, wa_greeting: { en: 'My own words', ar: 'كلماتي' } });
  assert.equal((await (await handleSettings(rq('GET', '/api/settings'), store)).json()).wa_greeting.en, 'My own words');
  await store.set('settings', g0.settings);
}
// marketing: extra packages, offers, promo codes
{
  const [, cur] = await adm('GET', '/api/admin/settings', undefined, token);
  const base = { ...cur.settings };
  const two = [{ id: 'profile', price: 200, name: 'P', name_ar: 'ب' }, { id: 'consultation', price: 400, name: 'C', name_ar: 'س', consult: true, featured: true, badge: 'Most popular', badge_ar: 'الأكثر طلباً' }];
  const custom = { id: 'new', price: 300, name: 'Team Pack', name_ar: 'باقة الفريق', features: [{ en: 'One', ar: 'واحد' }, { en: '', ar: '' }], consult: false, sale_price: 250, sale_ends: new Date(Date.now() + 86400000).toISOString() };
  const promo = { banner: { on: true, en: 'Launch week', ar: 'أسبوع الإطلاق', ends_at: '' }, note_en: 'Money-back', note_ar: 'ضمان', codes: [
    { code: 'welcome10', type: 'percent', value: 10, packages: [], max_uses: 2 }, { code: 'SAVE50', type: 'fixed', value: 50, combine: false }, { code: 'OLD', type: 'percent', value: 5, ends_at: '2020-01-01T00:00:00Z' }] };
  let [c, d] = await adm('PUT', '/api/admin/settings', { ...base, packages: [...two, custom], promo, updated_at: base.updated_at }, token);
  assert.equal(c, 200, JSON.stringify(d)); const cid = d.settings.packages[2].id; assert.match(cid, /^p[0-9a-f]{6}$/);
  assert.equal(d.settings.packages[2].features.length, 1); assert.equal(d.settings.promo.codes[0].code, 'WELCOME10');
  let v = d.settings.updated_at;
  const pub = await (await handleSettings(rq('GET', '/api/settings'), store)).json();
  assert.equal(pub.packages.length, 3); assert.equal(pub.promo.banner.en, 'Launch week'); assert.equal(pub.promo.has_codes, true); assert.ok(!JSON.stringify(pub).includes('WELCOME10'));   // codes never reach the public
  // validation
  const bad = (pk, pr = promo) => adm('PUT', '/api/admin/settings', { ...base, packages: pk, promo: pr, updated_at: v }, token);
  assert.equal((await bad([...two, { ...custom, sale_price: 300 }]))[0], 400);                         // offer must be lower
  assert.equal((await bad([two[0]]))[0], 400);                                                         // originals must stay
  assert.equal((await bad(two, { ...promo, codes: [{ code: 'A', type: 'percent', value: 5 }] }))[0], 400);
  assert.equal((await bad(two, { ...promo, codes: [{ code: 'ABC', type: 'percent', value: 95 }] }))[0], 400);
  assert.equal((await bad(two, { ...promo, codes: [{ code: 'ABC', type: 'fixed', value: 5 }, { code: 'abc', type: 'fixed', value: 5 }] }))[0], 400);
  assert.equal((await bad(two, { ...promo, banner: { on: true } }))[0], 400);
  // promo check
  const pc = async (code, pkg) => (await (await handlePromo(rq('POST', '/api/promo', { code, package: pkg }), store)).json());
  let r1 = await pc('welcome10', 'consultation'); assert.equal(r1.ok, true); assert.equal(r1.discount, 40); assert.equal(r1.final, 360);
  r1 = await pc('welcome10', cid); assert.equal(r1.base, 250); assert.equal(r1.final, 225);              // on top of the offer price
  assert.equal((await pc('SAVE50', cid)).reason, 'no_combine'); assert.equal((await pc('SAVE50', 'profile')).final, 150);
  assert.equal((await pc('OLD', 'profile')).reason, 'expired'); assert.equal((await pc('NOPE', 'profile')).reason, 'invalid'); assert.equal((await pc('WELCOME10', 'zzz')).reason, 'invalid');
  // submissions: server price, promo applied once per order, max uses
  const sub = async (id, extra) => { const x = await handleSubmit(rq('POST', '/api/submissions', { ...good, submission_id: id, price_sar: 1, ...extra }), store); assert.equal(x.status, 201); return (await adm('GET', '/api/admin/submissions/' + id, undefined, token))[1].submission; };
  let s1 = await sub('BSR-PRM001', { package: cid }); assert.equal(s1.price_sar, 250); assert.equal(s1.list_price, 300); assert.equal(s1.consult_status, null); assert.equal(s1.package_name, 'Team Pack');
  s1 = await sub('BSR-PRM002', { package: 'consultation', promo_code: 'welcome10' }); assert.equal(s1.price_sar, 360); assert.equal(s1.discount_sar, 40); assert.equal(s1.promo_code, 'WELCOME10'); assert.equal(s1.consult_status, 'not_scheduled');
  await sub('BSR-PRM003', { package: 'profile', promo_code: 'WELCOME10' });
  s1 = await sub('BSR-PRM004', { package: 'profile', promo_code: 'WELCOME10' }); assert.equal(s1.price_sar, 200); assert.match(s1.promo_invalid, /used_up/);   // limit of 2 reached
  assert.equal((await (await adm('GET', '/api/admin/settings', undefined, token))[1]).promo_uses.WELCOME10, 2);
  // sale that has ended charges the normal price
  await store.set('settings', { ...(await store.get('settings')), packages: (await store.get('settings')).packages.map((x) => (x.id === cid ? { ...x, sale_ends: '2020-01-01T00:00:00Z' } : x)) });
  assert.equal((await sub('BSR-PRM005', { package: cid })).price_sar, 300);
  // manual add with a custom package
  const [mc, md] = await adm('POST', '/api/admin/submissions', { full_name: 'M', contact: 'm@x.co', package: cid }, token); assert.equal(mc, 201); assert.equal(md.submission.price_sar, 300);
  [c, d] = await adm('PUT', '/api/admin/settings', { ...base, packages: null, promo: null, updated_at: v }, token); assert.equal(c, 200);
}
{
  const sh = async (q) => (await handleShare(new Request('http://x/s' + q))).text();
  let h = await sh('?code=WELCOME10&pkg=p1a2b3c'); assert.ok(h.includes('href="/?code=WELCOME10&amp;pkg=p1a2b3c"') && h.includes('location.replace("/?code=WELCOME10&pkg=p1a2b3c")') && !h.includes('http-equiv="refresh"')); assert.ok(h.includes('/og.png')); assert.ok(h.includes("location.replace(\"/?code=WELCOME10&pkg=p1a2b3c\")"));
  h = await sh('?code=%22%3E%3Cscript%3E'); assert.ok(!h.includes('<script>alert') && h.includes('href="/?code=script"')); h = await sh(''); assert.ok(h.includes('location.replace("/")'));
}
// pictures for packages, offers and codes
{
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
  const up = (body, tok = token) => handleAdmin(new Request('http://x/api/admin/image', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'image/png' }, body }), store, env);
  assert.equal((await up(png, 'bad')).status, 401);
  assert.equal((await up(Buffer.from('<svg onload=alert(1)>'))).status, 415);
  assert.equal((await up(Buffer.alloc(1_600_000, 0xff))).status, 413);
  const r0 = await up(png); assert.equal(r0.status, 200); const { path } = await r0.json(); assert.match(path, /^\/api\/img\/[A-Za-z0-9_-]{10,40}\.png$/);
  const g = await handleImage(new Request('http://x' + path), store); assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/png'); assert.ok(g.headers.get('cache-control').includes('immutable'));
  assert.equal((await handleImage(new Request('http://x/api/img/nope123456.png'), store)).status, 404);
  const [, cur] = await adm('GET', '/api/admin/settings', undefined, token); const base = { ...cur.settings };
  const two = [{ id: 'profile', price: 200, name: 'P', name_ar: 'ب', image: path }, { id: 'consultation', price: 400, name: 'C', name_ar: 'س', image: 'https://evil.example/x.png' }];
  const promo = { banner: { on: true, en: 'Hi', ar: 'مرحبا', image: path }, codes: [{ code: 'PICCODE', type: 'percent', value: 10, image: path }] };
  const [c, d] = await adm('PUT', '/api/admin/settings', { ...base, packages: two, promo, updated_at: base.updated_at }, token); assert.equal(c, 200);
  assert.equal(d.settings.packages[0].image, path); assert.equal(d.settings.packages[1].image, ''); assert.equal(d.settings.promo.codes[0].image, path);   // only our own picture paths are kept
  const pub = await (await handleSettings(rq('GET', '/api/settings'), store)).json(); assert.equal(pub.packages[0].image, path); assert.equal(pub.promo.banner.image, path); assert.ok(!JSON.stringify(pub).includes('PICCODE'));
  const pr = await (await handlePromo(rq('POST', '/api/promo', { code: 'piccode', package: 'profile' }), store)).json(); assert.equal(pr.image, path);
  const sh = async (q) => (await handleShare(new Request('http://x/s' + q), store)).text();
  assert.ok((await sh('?pkg=profile')).includes('content="http://x' + path + '"')); assert.ok((await sh('?code=PICCODE')).includes('A gift from Basirah') && (await sh('?code=PICCODE')).includes(path));
  { const a = await sh('?ann=1'); assert.ok(a.includes('📣 Hi') && a.includes(path) && a.includes('href="/#pkgs"')); }
  assert.ok((await sh('?pkg=consultation')).includes('/og.png')); assert.ok((await sh('')).includes('/og.png'));   // the plain link always shows the Basirah logo
  await adm('PUT', '/api/admin/settings', { ...base, packages: null, promo: null, updated_at: d.settings.updated_at }, token);
}
console.log('all core tests passed');
