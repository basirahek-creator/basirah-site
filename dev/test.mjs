// Tests for the storage rules: node dev/test.mjs
import assert from 'node:assert/strict';
import { handleAdmin, handleSubmit, handleTranslate, handleSettings, handleReport, normPhone, memoryStore } from '../netlify/lib/core.mjs';

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
console.log('all core tests passed');
