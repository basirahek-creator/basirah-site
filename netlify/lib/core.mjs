// Basirah back office: storage rules shared by the public site and the admin dashboard.
// Pure request -> response logic with an injected store, so it runs on Netlify Functions
// (Netlify Blobs) and in the local dev server / tests (in-memory or file store).
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export const PACKAGES = {
  profile: { name: 'Full Personality Profile', price: 200 },
  consultation: { name: 'Full Analysis + 1-to-1 Consultation', price: 400 },
};
export const PAYMENT = ['pending', 'verified', 'rejected'];
export const REPORT = ['not_started', 'in_progress', 'ready', 'delivered'];
export const CONSULT = ['not_scheduled', 'scheduled', 'completed'];
const METHODS = ['Email', 'WhatsApp', 'Mobile'];
const MAX_BODY = 500_000;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const now = () => new Date().toISOString();
const keyOf = (id) => 'sub/' + id;

/* ---------------- public: the site posts every finished assessment here ---------------- */
export async function handleSubmit(req, store) {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, 'Submission too large');
  let b;
  try { b = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON'); }
  if (!b || typeof b !== 'object') return fail(400, 'Invalid body');

  const id = str(b.submission_id, 16);
  if (!/^BSR-[A-Z0-9]{4,10}$/.test(id)) return fail(400, 'Missing or invalid submission_id');
  const pkg = PACKAGES[b.package] ? b.package : null;
  const name = str(b.full_name, 200), contact = str(b.contact, 200);
  if (!pkg || !name || !contact) return fail(400, 'Missing required fields');
  if (await store.get(keyOf(id))) return json({ ok: true, duplicate: true });   // a retry of the same submission

  const answers = Object.keys(b)
    .map((k) => { const m = /^Q(\d{2}) - (.*)$/s.exec(k); return m && typeof b[k] === 'string' ? { n: +m[1], q: m[2].slice(0, 1000), a: b[k].slice(0, 8000) } : null; })
    .filter(Boolean).sort((x, y) => x.n - y.n).slice(0, 80);
  const t = now();
  const rec = {
    id, source: 'site', created_at: t, updated_at: t,
    full_name: name, package: pkg, price_sar: PACKAGES[pkg].price,
    contact_method: METHODS.includes(b.contact_method) ? b.contact_method : 'Email', contact,
    payment_reference: str(b.payment_reference, 200), payment_receipt: str(b.payment_receipt, 2000), payment_method: str(b.payment_method, 80),
    language: b.language === 'ar' ? 'ar' : 'en', answers,
    consent_at: b.consent_given === true && b.consent_at && !isNaN(Date.parse(b.consent_at)) ? new Date(b.consent_at).toISOString() : null,
    consent_language: b.consent_language === 'ar' ? 'ar' : 'en',
    payment_status: 'pending', report_status: 'not_started',
    consult_status: pkg === 'consultation' ? 'not_scheduled' : null, consult_at: null,
    verified_at: null, delivered_at: null, delivery_note: '', notes: '',
    history: [{ at: t, by: 'client', action: 'Assessment submitted' }],
  };
  await store.set(keyOf(id), rec);
  return json({ ok: true, id }, 201);
}

/* ---------------- admin ---------------- */
const sha = (s) => createHash('sha256').update(String(s)).digest();
const secretOf = (env) => env.ADMIN_SECRET || 'basirah-admin:' + env.ADMIN_PASSWORD;
const sign = (secret, p) => createHmac('sha256', secret).update(p).digest('base64url');
export function makeToken(env, ttl = 12 * 3600) {
  const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttl })).toString('base64url');
  return p + '.' + sign(secretOf(env), p);
}
function tokenOk(env, header) {
  const tok = (header || '').replace(/^Bearer\s+/i, '');
  const [p, g] = tok.split('.');
  if (!p || !g) return false;
  const a = Buffer.from(g), e = Buffer.from(sign(secretOf(env), p));
  if (a.length !== e.length || !timingSafeEqual(a, e)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now() / 1000; } catch { return false; }
}

let failures = 0, lockedUntil = 0;   // best-effort brute-force slowdown (per running instance)

const summary = (r, withReport = new Set(), withPdf = new Set()) => {
  const { answers, history, ...rest } = r;
  return { ...rest, has_report: withReport.has(r.id), has_pdf: withPdf.has(r.id), answered: answers.filter((a) => a.a && !a.a.startsWith('VOICE ANSWER')).length, voice: answers.filter((a) => a.a.startsWith('VOICE ANSWER')).length };
};

async function load(store, id) { return id ? store.get(keyOf(id)) : null; }

export async function handleAdmin(req, store, env, base = '/api/admin') {
  if (!env.ADMIN_PASSWORD) return fail(503, 'ADMIN_PASSWORD is not set on the server');
  const url = new URL(req.url);
  const path = url.pathname.replace(base, '').replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);       // e.g. ['submissions', 'BSR-123']
  const m = req.method;

  if (path === '/login' && m === 'POST') {
    if (Date.now() < lockedUntil) return fail(429, 'Too many attempts. Wait a minute and try again.');
    let body = {}; try { body = await req.json(); } catch {}
    const ok = timingSafeEqual(sha(body.password || ''), sha(env.ADMIN_PASSWORD));
    if (!ok) {
      if (++failures >= 5) { lockedUntil = Date.now() + 60_000; failures = 0; }
      await new Promise((r) => setTimeout(r, 400));
      return fail(401, 'Incorrect password');
    }
    failures = 0;
    const ttl = body.remember === true ? 30 * 86400 : 12 * 3600;   // many phones and computers can be signed in at once: sessions are not counted
    return json({ token: makeToken(env, ttl), expires_in: ttl });
  }

  if (!tokenOk(env, req.headers.get('authorization'))) return fail(401, 'Please sign in again');
  if (parts[0] === 'docs') return handleDocs(req, store, parts[1]);
  if (parts[0] === 'translate') return handleTranslate(req, env);
  if (parts[0] === 'settings') return handleAdminSettings(req, store);
  if (parts[0] !== 'submissions') return fail(404, 'Not found');
  const id = parts[1];

  if (!id && m === 'GET') {
    const keys = await store.list('sub/');
    const withReport = new Set((await store.list('doc/')).filter((k) => k.startsWith('doc/r-')).map((k) => k.slice(6)));
    const withPdf = new Set((await store.list('pdfmeta/')).map((k) => k.slice(8)));
    const recs = (await Promise.all(keys.map((k) => store.get(k)))).filter(Boolean).map((r) => summary(r, withReport, withPdf));
    recs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json({ submissions: recs, server_time: now() });
  }

  if (!id && m === 'POST') {            // record a submission that arrived before the dashboard existed (e.g. from an email)
    let b; try { b = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
    const pkg = PACKAGES[b.package] ? b.package : null, name = str(b.full_name, 200), contact = str(b.contact, 200);
    if (!pkg || !name || !contact) return fail(400, 'Name, contact and package are required');
    const t = now(), when = b.created_at && !isNaN(Date.parse(b.created_at)) ? new Date(b.created_at).toISOString() : t;
    const nid = 'BSR-M' + randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
    const rec = {
      id: nid, source: 'manual', created_at: when, updated_at: t, full_name: name, package: pkg, price_sar: PACKAGES[pkg].price,
      contact_method: METHODS.includes(b.contact_method) ? b.contact_method : 'Email', contact,
      payment_reference: str(b.payment_reference, 200), payment_receipt: str(b.payment_receipt, 2000), language: 'en', answers: [], consent_at: null, consent_language: 'en',
      payment_status: 'pending', report_status: 'not_started', consult_status: pkg === 'consultation' ? 'not_scheduled' : null, consult_at: null,
      verified_at: null, delivered_at: null, delivery_note: '', notes: str(b.notes, 4000),
      history: [{ at: t, by: 'admin', action: 'Added manually' }],
    };
    await store.set(keyOf(nid), rec);
    return json({ submission: summary(rec) }, 201);
  }

  const rec = await load(store, id);
  if (!rec) return fail(404, 'Submission not found');

  if (parts[2] === 'pdf') return handlePdf(req, store, rec);
  if (parts[2] === 'contact' && m === 'POST') {            // a message to the client was started: keep a note in the history
    let b = {}; try { b = await req.json(); } catch {}
    const ch = { whatsapp: 'WhatsApp', email: 'email', copy: 'copied to send elsewhere' }[b.channel];
    if (!ch) return fail(400, 'Unknown channel');
    const t = now(), what = str(b.what, 80);
    const next = { ...rec, history: [...rec.history, { at: t, by: 'admin', action: 'Message to client (' + ch + ')' + (what ? ': ' + what : '') }], last_contacted_at: t, updated_at: t };
    await store.set(keyOf(id), next);
    return json({ submission: next });
  }

  if (m === 'GET') {
    const d = await store.get('doc/r-' + id);
    const pm = await store.get('pdfmeta/' + id);
    return json({ submission: rec, report_link: d ? { id: d.id, title: d.title || '', updatedAt: d.updatedAt || 0 } : null, pdf_link: pm ? pdfLink(pm) : null });
  }

  if (m === 'DELETE') {
    await store.delete(keyOf(id)); await store.delete('doc/r-' + id); await dropPdf(store, id);
    return json({ ok: true });
  }

  if (m === 'PATCH') {
    let b; try { b = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
    // two people editing at once: refuse to overwrite a record that changed since it was loaded
    if (b.updated_at && b.updated_at !== rec.updated_at) return fail(409, 'This record was changed by someone else. It has been reloaded.', { submission: rec });
    const t = now();
    const next = { ...rec, history: [...rec.history] };
    const L = (action) => next.history.push({ at: t, by: 'admin', action });

    if (b.payment_status !== undefined && b.payment_status !== rec.payment_status) {
      if (!PAYMENT.includes(b.payment_status)) return fail(400, 'Invalid payment status');
      if (rec.payment_status === 'verified' && rec.report_status !== 'not_started') return fail(409, 'Move the report back to “Not started” before changing a verified payment.');
      next.payment_status = b.payment_status;
      next.verified_at = b.payment_status === 'verified' ? t : null;
      L({ verified: 'Payment verified', rejected: 'Payment rejected', pending: 'Payment set back to pending' }[b.payment_status]);
    }
    if (b.report_status !== undefined && b.report_status !== rec.report_status) {
      if (!REPORT.includes(b.report_status)) return fail(400, 'Invalid report status');
      if (b.report_status !== 'not_started' && next.payment_status !== 'verified') return fail(409, 'Verify the payment before preparing the report.');
      next.report_status = b.report_status;
      next.delivered_at = b.report_status === 'delivered' ? t : null;
      L({ not_started: 'Report moved back to not started', in_progress: 'Report preparation started', ready: 'Report marked ready to send', delivered: 'Report delivered to client' }[b.report_status]);
    }
    if (b.delivery_note !== undefined) next.delivery_note = str(b.delivery_note, 1000);
    if (rec.package === 'consultation') {
      if (b.consult_status !== undefined && b.consult_status !== rec.consult_status) {
        if (!CONSULT.includes(b.consult_status)) return fail(400, 'Invalid consultation status');
        next.consult_status = b.consult_status;
        L({ not_scheduled: 'Consultation unscheduled', scheduled: 'Consultation scheduled', completed: 'Consultation completed' }[b.consult_status]);
      }
      if (b.consult_at !== undefined) {
        if (b.consult_at && isNaN(Date.parse(b.consult_at))) return fail(400, 'Invalid consultation date');
        next.consult_at = b.consult_at ? new Date(b.consult_at).toISOString() : null;
      }
    }
    if (b.notes !== undefined && str(b.notes, 4000) !== rec.notes) { next.notes = str(b.notes, 4000); L('Notes updated'); }
    if (next.history.length === rec.history.length && JSON.stringify({ ...next, history: 0 }) === JSON.stringify({ ...rec, history: 0 })) return json({ submission: rec });
    next.updated_at = t;
    await store.set(keyOf(id), next);
    return json({ submission: next });
  }
  return fail(405, 'Method not allowed');
}

/* ---------------- feedback report library (Document Studio) ---------------- */
const MAX_DOC = 600_000;
async function handleDocs(req, store, id) {
  const m = req.method;
  if (!id && m === 'GET') {
    const keys = await store.list('doc/');
    const docs = (await Promise.all(keys.map((k) => store.get(k)))).filter(Boolean);
    return json({ docs });
  }
  if (!id || !/^[A-Za-z0-9_-]{3,60}$/.test(id)) return fail(400, 'Invalid document id');
  if (m === 'GET') { const d = await store.get('doc/' + id); return d ? json({ doc: d }) : fail(404, 'Document not found'); }
  if (m === 'DELETE') { await store.delete('doc/' + id); return json({ ok: true }); }
  if (m === 'PUT') {
    const raw = await req.text();
    if (raw.length > MAX_DOC) return fail(413, 'Document too large');
    let b; try { b = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON'); }
    const docs = b && b.docs && typeof b.docs.en === 'string' && typeof b.docs.ar === 'string' ? { en: b.docs.en, ar: b.docs.ar } : null;
    if (!docs) return fail(400, 'Document text is missing');
    const sid = typeof b.submissionId === 'string' && /^BSR-[A-Z0-9]{4,10}$/.test(b.submissionId) ? b.submissionId : null;
    const old = await store.get('doc/' + id);
    const rec = {
      id, owner: 'admin', createdAt: old?.createdAt || Date.now(), updatedAt: Date.now(), updatedBy: 'admin',
      title: str(b.title, 300), titleAr: str(b.titleAr, 300), forName: str(b.forName, 100), docs,
      sync: b.sync && typeof b.sync === 'object' ? b.sync : null, opts: b.opts && typeof b.opts === 'object' ? b.opts : {}, submissionId: sid,
    };
    await store.set('doc/' + id, rec);
    return json({ doc: rec });
  }
  return fail(405, 'Method not allowed');
}

/* Optional machine translation for the studio. Needs ANTHROPIC_API_KEY on the server; without it the studio falls back to paste-in translation. */
export async function handleTranslate(req, env, fetchImpl = fetch) {
  if (req.method === 'GET') return json({ enabled: !!env.ANTHROPIC_API_KEY });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  if (!env.ANTHROPIC_API_KEY) return fail(503, 'Automatic translation is not set up on the server', { code: 'capability_disabled' });
  let b; try { b = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt || prompt.length > 30_000) return fail(400, 'The text is empty or too long', { code: 'prompt_too_large' });
  let r;
  try {
    r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.TRANSLATE_MODEL || 'claude-sonnet-5-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch { return fail(502, 'Could not reach the translation service'); }
  if (r.status === 429) return fail(429, 'Too many requests', { code: 'rate_limited' });
  if (!r.ok) return fail(502, 'The translation service returned an error', { code: 'failed' });
  const data = await r.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result; try { result = JSON.parse(text); } catch { return fail(502, 'The translation could not be read', { code: 'invalid_json' }); }
  return json({ result });
}

/* ---------------- settings: WhatsApp lines, payment methods, message wording ---------------- */
const KINDS = ['stc', 'bank', 'apple', 'qr', 'link', 'other'];
const TEMPLATE_KEYS = ['received', 'payment_issue', 'report', 'report_file', 'consult', 'consult_confirm'];
const MAX_SETTINGS = 1_100_000, MAX_QR = 250_000;
export const DEFAULT_GREETING = { en: 'Hello, I would like to ask about the Basirah assessment.', ar: 'السلام عليكم، أرغب في الاستفسار عن تقييم بصيرة.' };
const emptySettings = () => ({ business_name: 'Basirah', whatsapp: [], wa_greeting: { ...DEFAULT_GREETING }, show_default_qr: true, payments: [], templates: {}, questions: null, updated_at: null });

/* Saudi style numbers (05xxxxxxxx, 5xxxxxxxx, +966..., 00966...) become plain international digits for wa.me links. */
export function normPhone(v) {
  const raw = String(v || '').trim();
  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) d = d.slice(2);
  else if (/^05\d{8}$/.test(d)) d = '966' + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = '966' + d;
  return d.length >= 8 && d.length <= 15 ? d : '';
}
const tid = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{2,40}$/.test(v) ? v : randomBytes(4).toString('hex'));

function cleanSettings(b, prev) {
  if (!b || typeof b !== 'object') return { error: 'Invalid settings' };
  const out = emptySettings();
  out.business_name = str(b.business_name, 60) || 'Basirah';
  out.show_default_qr = b.show_default_qr !== false;
  out.wa_greeting = { en: str(b.wa_greeting?.en, 300) || DEFAULT_GREETING.en, ar: str(b.wa_greeting?.ar, 300) || DEFAULT_GREETING.ar };
  const wa = Array.isArray(b.whatsapp) ? b.whatsapp.slice(0, 6) : [];
  for (const w of wa) {
    const number = normPhone(w?.number);
    if (!number) return { error: 'The WhatsApp number “' + str(w?.number, 30) + '” is not valid. Use the full number, for example 0551234567 or +966551234567.' };
    out.whatsapp.push({ id: tid(w.id), label: str(w.label, 40) || 'WhatsApp', label_ar: str(w.label_ar, 40), number });
  }
  const pay = Array.isArray(b.payments) ? b.payments.slice(0, 10) : [];
  for (const p of pay) {
    const label = str(p?.label, 60);
    if (!label) return { error: 'Every payment method needs a name.' };
    let url = str(p.url, 500);
    if (url && !/^https?:\/\//i.test(url)) return { error: '“' + label + '”: the payment link must start with https://' };
    const qr = [];
    for (const q of Array.isArray(p.qr) ? p.qr.slice(0, 4) : []) {
      const src = typeof q?.src === 'string' ? q.src : '';
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return { error: '“' + label + '”: a QR code image is not valid. Upload a PNG or JPG.' };
      if (src.length > MAX_QR) return { error: '“' + label + '”: a QR code image is too large. Use a smaller picture.' };
      qr.push({ src, caption: str(q.caption, 60) });
    }
    const m = { id: tid(p.id), kind: KINDS.includes(p.kind) ? p.kind : 'other', label, label_ar: str(p.label_ar, 60), value: str(p.value, 120), holder: str(p.holder, 100), bank: str(p.bank, 100), url, note: str(p.note, 400), note_ar: str(p.note_ar, 400), qr };
    if (!m.value && !m.url && !m.qr.length && !m.note) return { error: '“' + label + '” needs a number, a link, a QR code or a note.' };
    out.payments.push(m);
  }
  if (b.questions === null || b.questions === undefined) out.questions = null;          // null = the original questions built into the website
  else {
    if (!Array.isArray(b.questions) || b.questions.length > 80) return { error: 'You can have up to 80 questions.' };
    const seen = new Set(); out.questions = [];
    for (const [i, q] of b.questions.entries()) {
      const en = str(q?.en, 600), ar = str(q?.ar, 600);
      if (!en && !ar) return { error: 'Question ' + (i + 1) + ' is empty. Write it, or delete it.' };
      let id = tid(q.id); while (seen.has(id)) id = randomBytes(4).toString('hex'); seen.add(id);
      out.questions.push({ id, en, ar, required: q.required === true, hidden: q.hidden === true });
    }
    if (!out.questions.some((q) => !q.hidden)) return { error: 'Keep at least one question visible.' };
  }
  for (const k of TEMPLATE_KEYS) {
    const en = str(b.templates?.[k]?.en, 1000), ar = str(b.templates?.[k]?.ar, 1000);
    if (en || ar) out.templates[k] = { en, ar };
  }
  out.updated_at = now();
  if (JSON.stringify(out).length > MAX_SETTINGS) return { error: 'Settings are too large. Remove a QR code or use smaller pictures.' };
  return { settings: out };
}
const publicSettings = (s) => {
  const { templates, updated_at, questions, ...rest } = s || emptySettings();
  return { ...rest, questions: Array.isArray(questions) ? questions.filter((q) => !q.hidden).map(({ id, en, ar, required }) => ({ id, en, ar, required })) : null };
};

async function handleAdminSettings(req, store) {
  const cur = (await store.get('settings')) || emptySettings();
  if (req.method === 'GET') return json({ settings: cur });
  if (req.method !== 'PUT') return fail(405, 'Method not allowed');
  const raw = await req.text();
  if (raw.length > MAX_SETTINGS + 20_000) return fail(413, 'Settings are too large. Remove a QR code or use smaller pictures.');
  let b; try { b = JSON.parse(raw); } catch { return fail(400, 'Invalid JSON'); }
  if (cur.updated_at && b.updated_at !== cur.updated_at) return fail(409, 'Settings were changed in another window. They have been reloaded.', { settings: cur });
  const r = cleanSettings(b, cur);
  if (r.error) return fail(400, r.error);
  await store.set('settings', r.settings);
  return json({ settings: r.settings });
}

/* Public: the website reads the WhatsApp lines and payment methods from here. */
export async function handleSettings(req, store) {
  if (req.method !== 'GET') return fail(405, 'Method not allowed');
  const res = json(publicSettings(await store.get('settings')));
  res.headers.set('cache-control', 'public, max-age=30');
  return res;
}

/* ---------------- report PDF with a private link the client can open ---------------- */
const MAX_PDF = 4_000_000;
const pdfLink = (m) => ({ token: m.token, path: '/r/' + m.token, size: m.size, at: m.at, opens: m.opens || 0, opened_at: m.opened_at || null, downloaded_at: m.downloaded_at || null });
async function dropPdf(store, id) {
  const m = await store.get('pdfmeta/' + id);
  if (m) { await store.delete('pdf/' + m.token); await store.delete('pdftok/' + m.token); await store.delete('pdfmeta/' + id); }
  return !!m;
}
async function handlePdf(req, store, rec) {
  const id = rec.id, t = now();
  if (req.method === 'PUT') {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > MAX_PDF) return fail(413, 'The PDF is too large to share by link (limit 4 MB).');
    if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') return fail(400, 'That is not a PDF file');
    const old = await store.get('pdfmeta/' + id);
    let token = old?.token;
    if (!token) do { token = randomBytes(8).toString('base64url'); } while (await store.get('pdftok/' + token));   // 11 characters: short enough for WhatsApp, still impossible to guess
    const meta = { token, size: buf.length, at: t, sid: id, name: str((rec.full_name || '').split(/\s+/)[0], 40), lang: rec.language === 'ar' ? 'ar' : 'en', opens: old?.opens || 0, opened_at: old?.opened_at || null, downloaded_at: old?.downloaded_at || null };
    await store.setBin('pdf/' + token, buf); await store.set('pdftok/' + token, { sid: id }); await store.set('pdfmeta/' + id, meta);
    const next = { ...rec, history: [...rec.history, { at: t, by: 'admin', action: old ? 'Report PDF updated (same private link)' : 'Report PDF published with a private link' }], updated_at: t };
    await store.set(keyOf(id), next);
    return json({ pdf_link: pdfLink(meta), submission: next });
  }
  if (req.method === 'GET') {            // the admin's own copy (does not count as the client downloading it)
    const m = await store.get('pdfmeta/' + id), buf = m && (await store.getBin('pdf/' + m.token));
    if (!buf) return fail(404, 'No PDF has been published for this client yet');
    return new Response(buf, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Basirah-Report.pdf"', 'cache-control': 'no-store' } });
  }
  if (req.method === 'DELETE') {
    const had = await dropPdf(store, id);
    if (!had) return json({ pdf_link: null, submission: rec });
    const next = { ...rec, history: [...rec.history, { at: t, by: 'admin', action: 'Private report link switched off' }], updated_at: t };
    await store.set(keyOf(id), next);
    return json({ pdf_link: null, submission: next });
  }
  return fail(405, 'Method not allowed');
}
/* Public: the client opens their report from its private link.
     /r/<token>           a small page with a Download button (this is the link you send)
     /r/<token>/download  the PDF as a download
     /r/<token>/view      the PDF in the browser
   Unknown links all look the same. */
const BOT = /whatsapp|facebookexternalhit|bot\b|crawler|spider|preview|slack|telegram|twitterbot|linkedin|skype/i;
const H = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function reportPage(meta, settings, token) {
  const lines = (settings?.whatsapp || []), name = meta.name || '';
  const kb = meta.size > 1048576 ? (meta.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(meta.size / 1024)) + ' KB';
  const sid = meta.sid || '';
  const msgEn = 'Hello, I have received my Basirah report (' + sid + ') and would like to talk about it.';
  const msgAr = 'السلام عليكم، استلمت تقرير بصيرة الخاص بي (' + sid + ') وأرغب في مناقشته.';
  const wa = (l) => 'https://wa.me/' + l.number + '?text=';
  const both = (en, ar) => `<span data-l="en">${en}</span><span data-l="ar">${ar}</span>`;
  const waBtns = lines.map((l) => `<a class="b o" target="_blank" rel="noopener" data-l="en" href="${H(wa(l) + encodeURIComponent(msgEn))}">${H(lines.length > 1 ? 'WhatsApp · ' + l.label : 'Message us on WhatsApp')}</a><a class="b o" target="_blank" rel="noopener" data-l="ar" href="${H(wa(l) + encodeURIComponent(msgAr))}">${H(lines.length > 1 ? 'واتساب · ' + (l.label_ar || l.label) : 'راسلنا عبر واتساب')}</a>`).join('');
  return `<!doctype html><html lang="${meta.lang === 'ar' ? 'ar' : 'en'}" dir="${meta.lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Basirah · ${meta.lang === 'ar' ? 'تقريرك' : 'Your report'}</title>
<meta property="og:title" content="${meta.lang === 'ar' ? 'تقريرك من بصيرة جاهز' : 'Your Basirah report is ready'}"><meta property="og:description" content="${meta.lang === 'ar' ? 'اضغط لفتح تقريرك وتحميله بصيغة PDF.' : 'Tap to open and download your report as a PDF.'}">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--cream:#FEFAF3;--card:#fff;--teal:#0B4F4C;--sub:#587571;--gold:#B8914A;--line:#DCD3C0;--sage:#E4EDE7}
@media(prefers-color-scheme:dark){:root{--cream:#121a19;--card:#1b2624;--teal:#7fc4bb;--sub:#a3bab6;--gold:#d3ac66;--line:#33403d;--sage:#26332f}}
*{box-sizing:border-box;margin:0}body{background:var(--cream);color:var(--teal);font:17px/1.6 'Tajawal',system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:460px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.brand{font:600 30px 'Cormorant Garamond',Georgia,serif}
.lg button{border:1.5px solid var(--line);background:var(--card);color:var(--teal);border-radius:99px;padding:5px 14px;font:700 14px 'Tajawal',sans-serif;cursor:pointer}.lg button[aria-pressed=true]{background:var(--teal);color:var(--cream);border-color:var(--teal)}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:34px 28px;text-align:center;box-shadow:0 2px 6px rgba(11,79,76,.08),0 24px 48px -24px rgba(11,79,76,.3)}
.ok{width:64px;height:64px;border-radius:50%;background:var(--sage);display:grid;place-items:center;margin:0 auto 16px}.ok svg{width:32px;height:32px}
h1{font:600 34px/1.15 'Cormorant Garamond',Georgia,serif;margin-bottom:6px}[dir=rtl] h1{font-family:'Tajawal',sans-serif;font-weight:700;font-size:30px;line-height:1.4}
.who{color:var(--sub);margin-bottom:22px}.b{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:var(--teal);color:var(--cream);border:1.5px solid var(--teal);border-radius:99px;padding:15px 24px;font:700 18px 'Tajawal',sans-serif;text-decoration:none;margin-bottom:10px}
.b.o{background:transparent;color:var(--teal);font-size:16px;padding:12px 20px}.b:hover{opacity:.92}.meta{font-size:14px;color:var(--sub);margin:4px 0 0}
.q{margin-top:26px;padding-top:22px;border-top:1px solid var(--line)}.q p{color:var(--sub);margin-bottom:14px;font-size:16px}
footer{text-align:center;color:var(--sub);font-size:13.5px;margin-top:18px}
[data-l]{display:none}html[lang=en] [data-l=en],html[lang=ar] [data-l=ar]{display:inline}a[data-l]{display:none}html[lang=en] a[data-l=en],html[lang=ar] a[data-l=ar]{display:flex}
:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
</style></head><body><main>
<div class="top"><span class="brand">Basirah</span><span class="lg" role="group" aria-label="Language"><button type="button" data-set="en" aria-pressed="${meta.lang !== 'ar'}">English</button> <button type="button" data-set="ar" aria-pressed="${meta.lang === 'ar'}">العربية</button></span></div>
<div class="card"><div class="ok" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M8 14h8M8 18h5"/></svg></div>
<h1>${both('Your report is ready', 'تقريرك جاهز')}</h1>
<p class="who">${name ? both('Prepared for ' + H(name), 'أُعدّ خصيصاً لـ ' + H(name)) : both('Prepared just for you', 'أُعدّ خصيصاً لك')}</p>
<a class="b" href="/r/${H(token)}/download" data-l="en">Download PDF</a><a class="b" href="/r/${H(token)}/download" data-l="ar">تحميل PDF</a>
<a class="b o" href="/r/${H(token)}/view" target="_blank" rel="noopener" data-l="en">Open in your browser</a><a class="b o" href="/r/${H(token)}/view" target="_blank" rel="noopener" data-l="ar">فتح في المتصفح</a>
<p class="meta">PDF · ${H(kb)}</p>
${lines.length ? `<div class="q"><p>${both('Questions about your report, or would you like to book your consultation?', 'لديك سؤال عن تقريرك، أو ترغب في حجز استشارتك؟')}</p>${waBtns}</div>` : ''}
</div><footer>${both('Basirah by Ehsankey · Self-reflection, not diagnosis.', 'بصيرة من إحسان · تأمّل ذاتي، وليس تشخيصاً.')}</footer></main>
<script>document.querySelectorAll('[data-set]').forEach(function(b){b.onclick=function(){var l=b.dataset.set,h=document.documentElement;h.lang=l;h.dir=l==='ar'?'rtl':'ltr';document.querySelectorAll('[data-set]').forEach(function(x){x.setAttribute('aria-pressed',x===b)})}})</script>
</body></html>`;
}
export async function handleReport(req, store) {
  if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Method not allowed');
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);       // ['r', token, action?]
  const token = segs[1] || '', action = segs[2] || '';
  const nf = () => new Response('This link is not available.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token) || segs.length > 3 || !['', 'download', 'view'].includes(action)) return nf();
  const ptr = await store.get('pdftok/' + token);
  const meta = ptr && (await store.get('pdfmeta/' + ptr.sid));
  if (!meta || meta.token !== token) return nf();
  const human = req.method === 'GET' && !BOT.test(req.headers.get('user-agent') || '');
  const touch = async (field) => {      // lets you see in the dashboard that the client opened or downloaded the report
    if (!human) return;
    const m = { ...meta }, t = now();
    if (field === 'open') { m.opens = (m.opens || 0) + 1; m.opened_at = m.opened_at || t; } else { m.downloaded_at = m.downloaded_at || t; m.opened_at = m.opened_at || t; }
    await store.set('pdfmeta/' + ptr.sid, m);
  };
  const base = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
  if (!action) {
    await touch('open');
    const html = reportPage(meta, await store.get('settings'), token);
    return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers: { ...base, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
  }
  const buf = await store.getBin('pdf/' + token);
  if (!buf) return nf();
  if (action === 'download') await touch('download');
  return new Response(req.method === 'HEAD' ? null : buf, { status: 200, headers: { ...base, 'content-type': 'application/pdf', 'content-disposition': (action === 'download' ? 'attachment' : 'inline') + '; filename="Basirah-Report.pdf"', 'content-length': String(buf.length) } });
}

/* ---------------- stores ---------------- */
export function memoryStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    async get(k) { const v = m.get(k); return v ? structuredClone(v) : null; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { m.delete(k); },
    async list(prefix = 'sub/') { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
    async getBin(k) { const v = m.get('bin:' + k); return v ? Buffer.from(v) : null; },
    async setBin(k, buf) { m.set('bin:' + k, Buffer.from(buf)); m.set(k, { bin: true }); },
  };
}
export function netlifyStore(getStore) {
  const ns = getStore({ name: 'basirah', consistency: 'strong' });
  return {
    get: (k) => ns.get(k, { type: 'json' }),
    set: (k, v) => ns.setJSON(k, v),
    delete: (k) => ns.delete(k),
    async list(prefix = 'sub/') { const { blobs } = await ns.list({ prefix }); return blobs.map((b) => b.key); },
    async getBin(k) { const v = await ns.get(k, { type: 'arrayBuffer' }); return v ? Buffer.from(v) : null; },
    setBin: (k, buf) => ns.set(k, new Uint8Array(buf).buffer),
  };
}
