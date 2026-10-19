// Basirah back office: storage rules shared by the public site and the admin dashboard.
// Pure request -> response logic with an injected store, so it runs on Netlify Functions
// (Netlify Blobs) and in the local dev server / tests (in-memory or file store).
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export const PACKAGES = {
  profile: { name: 'Full Personality Profile', price: 200 },
  consultation: { name: 'Full Analysis + 1-to-1 Consultation', price: 400 },
};
export const PKG_IDS = ['profile', 'consultation'];          // the two original packages; they can be hidden but never deleted (old orders refer to them)
const PKG_MAX = 12;
const defaultPkgs = () => Object.entries(PACKAGES).map(([id, p]) => ({ id, price: p.price, name: p.name, consult: id === 'consultation' }));
const pkgList = async (store) => { const set = await store.get('settings'); return Array.isArray(set?.packages) && set.packages.length ? set.packages : defaultPkgs(); };
const saleOn = (p, t = Date.now()) => Number(p.sale_price) > 0 && Number(p.sale_price) < p.price && (!p.sale_ends || Date.parse(p.sale_ends) > t);
const effPrice = (p, t) => (saleOn(p, t) ? Number(p.sale_price) : p.price);
// the price the server really charges: the saved price, or the sale price while the sale is running. Never a number sent by the browser.
const pkgInfo = async (store, id) => {
  const p = (await pkgList(store)).find((x) => x.id === id);
  if (!p) return null;
  return { id: p.id, name: p.name, list: p.price, price: effPrice(p), sale: saleOn(p), consult: p.consult === undefined ? p.id === 'consultation' : p.consult === true };
};
/* promo codes */
const normCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24) : '');
const promoWhy = (c, pk, t, used) => {
  if (!c || c.active === false) return 'invalid';
  if (c.starts_at && Date.parse(c.starts_at) > t) return 'soon';
  if (c.ends_at && Date.parse(c.ends_at) <= t) return 'expired';
  if (c.max_uses > 0 && used >= c.max_uses) return 'used_up';
  if (Array.isArray(c.packages) && c.packages.length && !c.packages.includes(pk.id)) return 'wrong_package';
  if (c.combine === false && pk.sale) return 'no_combine';
  return '';
};
const promoMath = (c, base) => {
  const raw = c.type === 'percent' ? Math.round((base * c.value) / 100) : c.value;
  const discount = Math.max(0, Math.min(raw, base - 1));          // the price never goes below 1 SAR
  return { discount, final: base - discount };
};
const promoUsed = async (store, code) => (await store.get('promouse/' + code))?.n || 0;
// returns { ok, code, discount, final, base, type, value } or { ok:false, reason }
async function checkPromo(store, rawCode, pk) {
  const code = normCode(rawCode);
  if (!code || !pk) return { ok: false, reason: 'invalid' };
  const set = await store.get('settings');
  const c = Array.isArray(set?.promo?.codes) ? set.promo.codes.find((x) => x.code === code) : null;
  const why = promoWhy(c, pk, Date.now(), c ? await promoUsed(store, code) : 0);
  if (why) return { ok: false, reason: why };
  return { ok: true, code, type: c.type, value: c.value, base: pk.price, image: c.image || '', ...promoMath(c, pk.price) };
}
export async function handlePromo(req, store) {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  let b; try { b = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const ip = req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
  const rk = 'promorl/' + createHash('sha256').update(ip).digest('hex').slice(0, 12) + '-' + Math.floor(Date.now() / 3600000);
  const n = ((await store.get(rk))?.n || 0) + 1;
  if (n > 40) return fail(429, 'Too many tries. Please wait a little and try again.');
  await store.set(rk, { n });
  const pk = await pkgInfo(store, b?.package);
  return json(await checkPromo(store, b?.code, pk));
}
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

// applies a promo code to a new order; the code is checked again here, and a code that stopped being valid is only flagged for the admin
async function promoFor(store, raw, pki) {
  const code = normCode(raw);
  if (!code) return {};
  const r = await checkPromo(store, code, pki);
  if (!r.ok) return { promo_invalid: code + ' (' + r.reason + ')' };
  await store.set('promouse/' + code, { n: (await promoUsed(store, code)) + 1 });
  return { promo_code: code, discount_sar: r.discount, price_sar: r.final };
}

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
  const pki = await pkgInfo(store, b.package), pkg = pki ? pki.id : null;
  const name = str(b.full_name, 200), contact = str(b.contact, 200);
  if (!pkg || !name || !contact) return fail(400, 'Missing required fields');
  if (await store.get(keyOf(id))) return json({ ok: true, duplicate: true });   // a retry of the same submission

  const answers = Object.keys(b)
    .map((k) => { const m = /^Q(\d{2}) - (.*)$/s.exec(k); return m && typeof b[k] === 'string' ? { n: +m[1], q: m[2].slice(0, 1000), a: b[k].slice(0, 8000) } : null; })
    .filter(Boolean).sort((x, y) => x.n - y.n).slice(0, 80);
  const t = now();
  const rec = {
    id, source: 'site', created_at: t, updated_at: t,
    full_name: name, package: pkg, package_name: pki.name, price_sar: pki.price, list_price: pki.list,
    ...(await promoFor(store, b.promo_code, pki)),
    contact_method: METHODS.includes(b.contact_method) ? b.contact_method : 'Email', contact,
    payment_reference: str(b.payment_reference, 200), payment_receipt: str(b.payment_receipt, 2000), payment_method: str(b.payment_method, 80),
    language: b.language === 'ar' ? 'ar' : 'en', answers,
    consent_at: b.consent_given === true && b.consent_at && !isNaN(Date.parse(b.consent_at)) ? new Date(b.consent_at).toISOString() : null,
    consent_language: b.consent_language === 'ar' ? 'ar' : 'en',
    payment_status: 'pending', report_status: 'not_started',
    consult_status: pki.consult ? 'not_scheduled' : null, consult_at: null,
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
  if (parts[0] === 'image') return handleAdminImage(req, store);
  if (parts[0] === 'reviews') return handleAdminReviews(req, store, parts[1]);
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
    const pki = await pkgInfo(store, b.package), pkg = pki ? pki.id : null, name = str(b.full_name, 200), contact = str(b.contact, 200);
    if (!pkg || !name || !contact) return fail(400, 'Name, contact and package are required');
    const t = now(), when = b.created_at && !isNaN(Date.parse(b.created_at)) ? new Date(b.created_at).toISOString() : t;
    const nid = 'BSR-M' + randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
    const rec = {
      id: nid, source: 'manual', created_at: when, updated_at: t, full_name: name, package: pkg, package_name: pki.name, price_sar: pki.price, list_price: pki.list,
      contact_method: METHODS.includes(b.contact_method) ? b.contact_method : 'Email', contact,
      payment_reference: str(b.payment_reference, 200), payment_receipt: str(b.payment_receipt, 2000), language: 'en', answers: [], consent_at: null, consent_language: 'en',
      payment_status: 'pending', report_status: 'not_started', consult_status: pki.consult ? 'not_scheduled' : null, consult_at: null,
      verified_at: null, delivered_at: null, delivery_note: '', notes: str(b.notes, 4000),
      history: [{ at: t, by: 'admin', action: 'Added manually' }],
    };
    await store.set(keyOf(nid), rec);
    return json({ submission: summary(rec) }, 201);
  }

  const rec = await load(store, id);
  if (!rec) return fail(404, 'Submission not found');

  if (parts[2] === 'pdf') return handlePdf(req, store, rec);
  if (parts[2] === 'review-link' && m === 'POST') {        // a private link where this client can leave a review
    let meta = await store.get('rvmeta/' + id);
    const t = now();
    if (!meta) {
      let token; do { token = randomBytes(8).toString('base64url'); } while (await store.get('rvtok/' + token));
      meta = { token, sid: id, requested_at: t };
      await store.set('rvtok/' + token, { sid: id }); await store.set('rvmeta/' + id, meta);
      const next = { ...rec, review_requested_at: t, updated_at: t, history: [...rec.history, { at: t, by: 'admin', action: 'Review link created' }] };
      await store.set(keyOf(id), next);
      return json({ review_link: { token: meta.token, path: '/v/' + meta.token, requested_at: t }, submission: next });
    }
    return json({ review_link: { token: meta.token, path: '/v/' + meta.token, requested_at: meta.requested_at }, submission: rec });
  }
  if (parts[2] === 'contact' && m === 'POST') {            // a message to the client was started: keep a note in the history
    let b = {}; try { b = await req.json(); } catch {}
    const ch = { whatsapp: 'WhatsApp', email: 'email', copy: 'copied to send elsewhere' }[b.channel];
    if (!ch) return fail(400, 'Unknown channel');
    const t = now(), what = str(b.what, 80);
    const next = { ...rec, history: [...rec.history, { at: t, by: 'admin', action: 'Message to client (' + ch + ')' + (what ? ': ' + what : '') }], last_contacted_at: t, updated_at: t, ...(b.kind === 'delay' ? { delay_notice_at: t, delay_notices: (rec.delay_notices || 0) + 1 } : {}) };
    await store.set(keyOf(id), next);
    return json({ submission: next });
  }

  if (m === 'GET') {
    const d = await store.get('doc/r-' + id);
    const pm = await store.get('pdfmeta/' + id);
    const rm = await store.get('rvmeta/' + id);
    return json({ submission: rec, report_link: d ? { id: d.id, title: d.title || '', updatedAt: d.updatedAt || 0 } : null, pdf_link: pm ? pdfLink(pm) : null, review_link: rm ? { token: rm.token, path: '/v/' + rm.token, requested_at: rm.requested_at } : null });
  }

  if (m === 'DELETE') {
    await dropFiles(store, rec);                       // the client's voice answers and receipt go too
    await store.delete(keyOf(id)); await store.delete('doc/r-' + id); await dropPdf(store, id);
    await dropReview(store, id);
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
    if (rec.consult_status) {
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
/* Free fallback: no key and no cost. Uses the public MyMemory service (about 5,000 characters a day without an account). Plain text only, so bold and italic are lost. */
function chunkText(t, max = 420) {
  const parts = t.match(/[^.!?؟۔\n]+[.!?؟۔]*\s*|\n+/g) || [t], out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur); cur = ''; }
    if (p.length > max) { for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max)); } else cur += p;
  }
  if (cur) out.push(cur);
  return out;
}
async function freeTranslate(texts, to, fetchImpl) {
  const pair = to === 'ar' ? 'en|ar' : 'ar|en';
  const one = async (chunk) => {
    if (!chunk.trim() || !/[\p{L}]/u.test(chunk)) return chunk;
    const r = await fetchImpl('https://api.mymemory.translated.net/get?langpair=' + encodeURIComponent(pair) + '&q=' + encodeURIComponent(chunk));
    const j = await r.json().catch(() => null);
    const out = j?.responseData?.translatedText;
    if (!r.ok || !out || (j.responseStatus && Number(j.responseStatus) !== 200) || /MYMEMORY WARNING/i.test(out)) {
      const e = new Error(/MYMEMORY WARNING|ALL AVAILABLE FREE/i.test(String(out)) || r.status === 429 ? 'quota' : 'failed'); e.status = r.status; throw e;
    }
    return out;
  };
  const result = [];
  for (const t of texts) {
    const chunks = chunkText(String(t));
    const done = new Array(chunks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => { while (next < chunks.length) { const i = next++; done[i] = await one(chunks[i]); } }));
    result.push(done.join(''));
  }
  return result;
}

export async function handleTranslate(req, env, fetchImpl = fetch) {
  if (req.method === 'GET') return json({ enabled: !!env.ANTHROPIC_API_KEY });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  let b; try { b = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  if (Array.isArray(b.texts)) {                                       // the free route: a list of plain texts and the language to translate into
    if (b.texts.length > 60 || b.texts.some((x) => typeof x !== 'string') || b.texts.join('').length > 12_000) return fail(400, 'The text is empty or too long', { code: 'prompt_too_large' });
    try { return json({ result: await freeTranslate(b.texts, b.to === 'ar' ? 'ar' : 'en', fetchImpl), engine: 'free' }); }
    catch (e) {
      if (e.message === 'quota') return fail(429, 'The free translator has reached its limit for today', { code: 'rate_limited', detail: 'The free translator is full for today. Try again tomorrow, or use the paste option.' });
      return fail(502, 'The free translator did not answer', { code: 'failed', detail: 'The free translator did not answer. Try again in a minute.' });
    }
  }
  if (!env.ANTHROPIC_API_KEY) return fail(503, 'Automatic translation is not set up on the server', { code: 'capability_disabled' });
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt || prompt.length > 30_000) return fail(400, 'The text is empty or too long', { code: 'prompt_too_large' });
  let r;
  try {
    // Netlify can supply its own key and address for Claude (its AI gateway), so use the address it gives when there is one
    r = await fetchImpl((env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.TRANSLATE_MODEL || 'claude-sonnet-5-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) { return fail(502, 'Could not reach the translation service', { code: 'failed', detail: String(e?.message || e).slice(0, 160) }); }
  if (r.status === 429) return fail(429, 'Too many requests', { code: 'rate_limited' });
  if (!r.ok) {
    let why = ''; try { const j = await r.json(); why = (j?.error?.type ? j.error.type + ': ' : '') + (j?.error?.message || ''); } catch {}
    console.error('translate failed', r.status, why);
    return fail(502, 'The translation service returned an error', { code: 'failed', detail: ('HTTP ' + r.status + (why ? ' - ' + why : '')).slice(0, 220) });   // shown to the signed-in admin only
  }
  const data = await r.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result; try { result = JSON.parse(text); } catch { return fail(502, 'The translation could not be read', { code: 'invalid_json' }); }
  return json({ result });
}

/* ---------------- settings: WhatsApp lines, payment methods, message wording ---------------- */
const KINDS = ['stc', 'bank', 'apple', 'qr', 'link', 'other'];
const TEMPLATE_KEYS = ['received', 'payment_issue', 'delay', 'report', 'report_file', 'consult', 'consult_confirm', 'review'];
const MAX_SETTINGS = 1_100_000, MAX_QR = 250_000;
const OLD_GREETING = { en: 'Hello, I would like to ask about the Basirah assessment.', ar: 'السلام عليكم، أرغب في الاستفسار عن تقييم بصيرة.' };
export const DEFAULT_GREETING = { en: 'Hello Basirah 🌿\nI would like to begin my journey of self-insight. Could you tell me more about the assessment?\n\n✨ Basirah by EhsanKey\n{site}', ar: 'السلام عليكم بصيرة 🌿\nأرغب في بدء رحلتي نحو معرفة نفسي، هلّا زوّدتموني بالمزيد عن التقييم؟\n\n✨ بصيرة من إحسان\n{site}' };
const upGreet = (s) => (s && s.wa_greeting ? { ...s, wa_greeting: { en: s.wa_greeting.en === OLD_GREETING.en ? DEFAULT_GREETING.en : s.wa_greeting.en, ar: s.wa_greeting.ar === OLD_GREETING.ar ? DEFAULT_GREETING.ar : s.wa_greeting.ar } } : s);
const emptySettings = () => ({ business_name: 'Basirah', whatsapp: [], wa_greeting: { ...DEFAULT_GREETING }, show_default_qr: true, payments: [], templates: {}, questions: null, review_name: 'choose', packages: null, promo: null, info: null, review_questions: null, updated_at: null });

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
  out.wa_greeting = { en: str(b.wa_greeting?.en, 500) || DEFAULT_GREETING.en, ar: str(b.wa_greeting?.ar, 500) || DEFAULT_GREETING.ar };
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
  const isoOrEmpty = (v) => (typeof v === 'string' && v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : '');
  if (b.packages === null || b.packages === undefined) out.packages = null;           // null = the two original packages built into the website
  else {
    if (!Array.isArray(b.packages) || b.packages.length > PKG_MAX) return { error: 'You can have up to ' + PKG_MAX + ' packages.' };
    out.packages = []; const seenP = new Set();
    for (const [n, x] of b.packages.entries()) {
      let id = typeof x?.id === 'string' && (PKG_IDS.includes(x.id) || /^p[0-9a-f]{6}$/.test(x.id)) ? x.id : 'p' + randomBytes(3).toString('hex');
      while (seenP.has(id)) id = 'p' + randomBytes(3).toString('hex'); seenP.add(id);
      const price = Math.round(Number(x?.price));
      const label = str(x?.name, 80) || 'package ' + (n + 1);
      if (!Number.isFinite(price) || price < 1 || price > 100000) return { error: 'The price of “' + label + '” must be a whole number between 1 and 100000.' };
      const name = str(x?.name, 80), name_ar = str(x?.name_ar, 80);
      if (!name || !name_ar) return { error: 'Write the name of “' + label + '” in both English and Arabic.' };
      let sale_price = null;
      if (x?.sale_price !== null && x?.sale_price !== undefined && x?.sale_price !== '') {
        sale_price = Math.round(Number(x.sale_price));
        if (!Number.isFinite(sale_price) || sale_price < 1 || sale_price >= price) return { error: 'The offer price of “' + label + '” must be a whole number lower than its normal price.' };
      }
      const features = (Array.isArray(x?.features) ? x.features : []).slice(0, 8).map((f) => ({ en: str(f?.en, 90), ar: str(f?.ar, 90) })).filter((f) => f.en || f.ar);
      out.packages.push({
        id, price, name, name_ar, desc: str(x?.desc, 300), desc_ar: str(x?.desc_ar, 300), hidden: x?.hidden === true,
        features, badge: str(x?.badge, 24), badge_ar: str(x?.badge_ar, 24), featured: x?.featured === true,
        consult: x?.consult === undefined ? id === 'consultation' : x.consult === true,
        sale_price, sale_ends: sale_price ? isoOrEmpty(x?.sale_ends) : '', image: imgOf(x?.image),
      });
    }
    for (const id of PKG_IDS) if (!out.packages.some((x) => x.id === id)) return { error: 'The two original packages cannot be removed. Hide them instead.' };
    if (out.packages.every((x) => x.hidden)) return { error: 'Keep at least one package visible.' };
    let seenF = false; for (const x of out.packages) { if (x.featured && (seenF || x.hidden)) x.featured = false; if (x.featured) seenF = true; }   // one highlighted package
  }
  // marketing: announcement bar, price note and promo codes
  const bp = b.promo && typeof b.promo === 'object' ? b.promo : {};
  const bn = bp.banner && typeof bp.banner === 'object' ? bp.banner : {};
  const pids = new Set((out.packages || defaultPkgs()).map((x) => x.id));
  const codes = []; const seenC = new Set();
  if (Array.isArray(bp.codes)) {
    if (bp.codes.length > 40) return { error: 'You can have up to 40 promo codes.' };
    for (const c of bp.codes) {
      const code = normCode(c?.code);
      if (code.length < 3) return { error: 'Every promo code needs at least 3 letters or numbers.' };
      if (seenC.has(code)) return { error: 'The promo code ' + code + ' is listed twice.' };
      seenC.add(code);
      const type = c?.type === 'fixed' ? 'fixed' : 'percent', value = Math.round(Number(c?.value));
      if (!Number.isFinite(value) || value < 1 || (type === 'percent' ? value > 90 : value > 100000)) return { error: 'The discount of ' + code + ' must be ' + (type === 'percent' ? 'between 1% and 90%.' : 'a whole number of riyals.') };
      codes.push({
        code, type, value, active: c?.active !== false, combine: c?.combine !== false,
        packages: (Array.isArray(c?.packages) ? c.packages : []).filter((id) => pids.has(id)),
        starts_at: isoOrEmpty(c?.starts_at), ends_at: isoOrEmpty(c?.ends_at),
        max_uses: Math.max(0, Math.min(100000, Math.round(Number(c?.max_uses)) || 0)), note: str(c?.note, 100), image: imgOf(c?.image),
      });
    }
  }
  out.promo = {
    banner: { on: bn.on === true, en: str(bn.en, 160), ar: str(bn.ar, 160), ends_at: isoOrEmpty(bn.ends_at), image: imgOf(bn.image) },
    note_en: str(bp.note_en, 200), note_ar: str(bp.note_ar, 200), codes,
  };
  if (out.promo.banner.on && !out.promo.banner.en && !out.promo.banner.ar) return { error: 'Write the announcement text, or switch the announcement bar off.' };
  out.review_name = ['choose', 'first', 'full', 'anon'].includes(b.review_name) ? b.review_name : 'choose';   // who decides how a reviewer's name appears
  if (b.review_questions === null || b.review_questions === undefined) out.review_questions = null;      // null = the standard review questions
  else {
    if (!Array.isArray(b.review_questions) || b.review_questions.length > 20) return { error: 'You can have up to 20 review questions.' };
    const seen = new Set(); out.review_questions = [];
    for (const [i, q] of b.review_questions.entries()) {
      const en = str(q?.en, 300), ar = str(q?.ar, 300);
      if (!en && !ar) return { error: 'Review question ' + (i + 1) + ' is empty. Write it, or delete it.' };
      let id = tid(q.id); while (seen.has(id)) id = randomBytes(4).toString('hex'); seen.add(id);
      out.review_questions.push({ id, en, ar, type: RQ_TYPES.includes(q.type) ? q.type : 'text', required: q.required === true, hidden: q.hidden === true });
    }
    if (!out.review_questions.some((q) => !q.hidden)) return { error: 'Keep at least one review question visible.' };
  }
  if (b.info === null || b.info === undefined) out.info = null;
  else {
    const i = b.info, v = (k) => str(i?.[k], 80);
    out.info = { duration_en: v('duration_en'), duration_ar: v('duration_ar'), delivery_en: v('delivery_en'), delivery_ar: v('delivery_ar') };
  }
  for (const k of TEMPLATE_KEYS) {
    const en = str(b.templates?.[k]?.en, 1000), ar = str(b.templates?.[k]?.ar, 1000);
    if (en || ar) out.templates[k] = { en, ar };
  }
  out.updated_at = now();
  if (JSON.stringify(out).length > MAX_SETTINGS) return { error: 'Settings are too large. Remove a QR code or use smaller pictures.' };
  return { settings: out };
}
export const RQ_TYPES = ['stars', 'scale', 'text'];
export const DEFAULT_RQ = [
  { id: 'overall', type: 'stars', required: true, en: 'How was your overall experience with Basirah?', ar: 'كيف كانت تجربتك العامة مع بصيرة؟' },
  { id: 'accuracy', type: 'stars', required: true, en: 'How well did your personality profile describe you?', ar: 'إلى أي مدى وصف ملفك الشخصي حقيقتك؟' },
  { id: 'recommend', type: 'scale', required: true, en: 'How likely are you to recommend Basirah to a friend or colleague? (0 = not likely, 10 = very likely)', ar: 'ما مدى احتمال أن توصي ببصيرة لصديق أو زميل؟ (0 = غير محتمل، 10 = محتمل جداً)' },
  { id: 'valued', type: 'text', required: false, en: 'What did you value most?', ar: 'ما أكثر ما أعجبك؟' },
  { id: 'improve', type: 'text', required: false, en: 'What could we do better?', ar: 'ما الذي يمكننا تحسينه؟' },
];
const publicSettings = (s) => {
  const { templates, updated_at, questions, review_questions, review_name, promo, ...rest } = upGreet(s) || emptySettings();
  const bn = promo?.banner, t = Date.now();
  const live = bn && bn.on && (bn.en || bn.ar) && !(bn.ends_at && Date.parse(bn.ends_at) <= t);
  return {
    ...rest, packages: rest.packages || null, info: rest.info || null, now: new Date(t).toISOString(),
    promo: promo ? { banner: live ? { en: bn.en, ar: bn.ar, ends_at: bn.ends_at, image: bn.image || '' } : null, note_en: promo.note_en, note_ar: promo.note_ar, has_codes: promo.codes.some((c) => c.active && !(c.ends_at && Date.parse(c.ends_at) <= t)) } : null,
    questions: Array.isArray(questions) ? questions.filter((q) => !q.hidden).map(({ id, en, ar, required }) => ({ id, en, ar, required })) : null,
  };
};

async function handleAdminSettings(req, store) {
  const cur = upGreet(await store.get('settings')) || emptySettings();
  if (req.method === 'GET') {
    const uses = {};
    for (const c of cur.promo?.codes || []) uses[c.code] = await promoUsed(store, c.code);
    return json({ settings: cur, promo_uses: uses });
  }
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
  const tm = await store.get('testimonials');
  const res = json({ ...publicSettings(await store.get('settings')), testimonials: Array.isArray(tm?.list) ? tm.list : [] });
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
function reportPage(meta, settings, token, origin = '') {
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
<meta property="og:image" content="${H(origin)}/og.png"><meta property="og:type" content="website"><meta property="og:title" content="${meta.lang === 'ar' ? 'تقريرك من بصيرة جاهز' : 'Your Basirah report is ready'}"><meta property="og:description" content="${meta.lang === 'ar' ? 'اضغط لفتح تقريرك وتحميله بصيغة PDF.' : 'Tap to open and download your report as a PDF.'}">
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
    const html = reportPage(meta, await store.get('settings'), token, new URL(req.url).origin);
    return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers: { ...base, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
  }
  const buf = await store.getBin('pdf/' + token);
  if (!buf) return nf();
  if (action === 'download') await touch('download');
  return new Response(req.method === 'HEAD' ? null : buf, { status: 200, headers: { ...base, 'content-type': 'application/pdf', 'content-disposition': (action === 'download' ? 'attachment' : 'inline') + '; filename="Basirah-Report.pdf"', 'content-length': String(buf.length) } });
}

/* ---------------- stores ---------------- */
/* ---------------- files clients attach: voice answers and payment receipts ---------------- */
const FILE_TYPES = /^(audio\/[a-z0-9.+-]+|video\/webm|image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;
const MAX_FILE = 5 * 1024 * 1024;           // Netlify functions accept about 6 MB per request
const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
export async function handleUpload(req, store) {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!FILE_TYPES.test(type)) return fail(415, 'This kind of file is not accepted');
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return fail(400, 'The file is empty');
  if (buf.length > MAX_FILE) return fail(413, 'The file is too large (limit 5 MB)');
  let id; do { id = randomBytes(12).toString('base64url'); } while (await store.get('uplmeta/' + id));
  await store.setBin('upl/' + id, buf);
  await store.set('uplmeta/' + id, { type, size: buf.length, at: new Date().toISOString() });
  const origin = new URL(req.url).origin;
  return json({ url: origin + '/api/file/' + id + (EXT[type] ? '.' + EXT[type] : '') });
}
export async function handleFile(req, store) {
  const nf = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Method not allowed');
  const m = /^\/api\/file\/([A-Za-z0-9_-]{10,40})(?:\.[a-z0-9]{2,4})?$/.exec(new URL(req.url).pathname);
  if (!m) return nf();
  const meta = await store.get('uplmeta/' + m[1]);
  const buf = meta && (await store.getBin('upl/' + m[1]));
  if (!buf) return nf();
  const h = { 'content-type': meta.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; sandbox" };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');          // Safari needs range requests to play audio
  if (rg && (rg[1] || rg[2])) {
    let a = rg[1] === '' ? Math.max(0, buf.length - +rg[2]) : +rg[1], b = rg[1] === '' || rg[2] === '' ? buf.length - 1 : Math.min(+rg[2], buf.length - 1);
    if (a > b || a >= buf.length) return new Response(null, { status: 416, headers: { ...h, 'content-range': 'bytes */' + buf.length } });
    return new Response(req.method === 'HEAD' ? null : buf.subarray(a, b + 1), { status: 206, headers: { ...h, 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': String(b - a + 1) } });
  }
  return new Response(req.method === 'HEAD' ? null : buf, { status: 200, headers: { ...h, 'content-length': String(buf.length) } });
}
async function dropFiles(store, rec) {
  const ids = new Set([...JSON.stringify(rec || {}).matchAll(/\/api\/file\/([A-Za-z0-9_-]{10,40})/g)].map((x) => x[1]));
  for (const id of ids) { await store.delete('upl/' + id); await store.delete('uplmeta/' + id); }
}

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


/* ---------------- reviews: private link per client, results in the dashboard, chosen ones shown on the website ---------------- */
const stripHidden = (l) => (Array.isArray(l) && l.length ? l : DEFAULT_RQ).filter((q) => !q.hidden);
async function dropReview(store, id) {
  const m = await store.get('rvmeta/' + id);
  if (m) { await store.delete('rvtok/' + m.token); await store.delete('rvmeta/' + id); }
  const had = await store.get('review/' + id);
  if (had) { await store.delete('review/' + id); await rebuildTestimonials(store); }
}
async function rebuildTestimonials(store) {
  const recs = (await Promise.all((await store.list('review/')).map((k) => store.get(k)))).filter(Boolean);
  const list = recs.filter((r) => r.featured && r.share).sort((a, b) => (a.featured_at || '').localeCompare(b.featured_at || ''))
    .map((r) => ({ id: r.sid, quote: r.quote, quote_ar: r.quote_ar || '', name: r.display_name, stars: r.stars || 0 }));
  await store.set('testimonials', { list });
}
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

async function handleAdminReviews(req, store, sid) {
  const m = req.method;
  if (!sid && m === 'GET') {
    const recs = (await Promise.all((await store.list('review/')).map((k) => store.get(k)))).filter(Boolean);
    recs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const sent = (await store.list('rvmeta/')).length;
    return json({ reviews: recs, requested: sent });
  }
  const rv = sid && (await store.get('review/' + sid));
  if (!rv) return fail(404, 'Review not found');
  if (m === 'DELETE') { await store.delete('review/' + sid); await rebuildTestimonials(store); return json({ ok: true }); }
  if (m !== 'PUT') return fail(405, 'Method not allowed');
  let b; try { b = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const next = { ...rv };
  if (b.quote !== undefined) next.quote = str(b.quote, 600);
  if (b.quote_ar !== undefined) next.quote_ar = str(b.quote_ar, 600);
  if (b.display_name !== undefined) next.display_name = str(b.display_name, 60);
  if (b.stars !== undefined) next.stars = Math.max(0, Math.min(5, Math.round(Number(b.stars) || 0)));
  if (b.featured !== undefined) {
    if (b.featured === true) {
      if (!rv.share) return fail(409, 'This client did not agree to have their words shown on the website.');
      if (!(next.quote || next.quote_ar)) return fail(400, 'Choose or write the words to show first.');
      if (!next.display_name) return fail(400, 'Write the name to show, for example “Sara”.');
      next.featured = true; next.featured_at = rv.featured_at || now();
    } else { next.featured = false; }
  } else if (next.featured && !(next.quote || next.quote_ar)) return fail(400, 'A shown review needs words. Remove it from the website first.');
  next.updated_at = now();
  await store.set('review/' + sid, next);
  await rebuildTestimonials(store);
  return json({ review: next });
}

const OGTAGS = (origin, title, desc, img) => `<meta property="og:image" content="${H(origin)}${H(img || '/og.png')}">${img ? '' : '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'}<meta property="og:type" content="website"><meta property="og:title" content="${H(title)}"><meta property="og:description" content="${H(desc)}"><meta name="twitter:card" content="summary_large_image">`;

/* a small page that WhatsApp shows with the Basirah logo; people who tap it go to the website */
/* ---------------- marketing pictures (packages, offers, promo codes) ---------------- */
const IMG_RE = /^\/api\/img\/[A-Za-z0-9_-]{10,40}\.(jpg|png|webp)$/;
const imgOf = (v) => (typeof v === 'string' && IMG_RE.test(v) ? v : '');
const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const sniffImg = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '');
async function handleAdminImage(req, store) {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return fail(400, 'The picture is empty');
  if (buf.length > 1_500_000) return fail(413, 'The picture is too large. Choose a smaller one.');
  const type = sniffImg(buf);
  if (!type) return fail(415, 'Please use a JPG, PNG or WebP picture.');
  const id = randomBytes(12).toString('base64url');
  await store.setBin('img/' + id, buf);
  await store.set('imgmeta/' + id, { type, size: buf.length, at: now() });
  return json({ path: '/api/img/' + id + '.' + IMG_EXT[type] });
}
export async function handleImage(req, store) {
  const nf = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Method not allowed');
  const m = /^\/api\/img\/([A-Za-z0-9_-]{10,40})\.(jpg|png|webp)$/.exec(new URL(req.url).pathname);
  if (!m) return nf();
  const meta = await store.get('imgmeta/' + m[1]);
  const buf = meta && (await store.getBin('img/' + m[1]));
  if (!buf) return nf();
  return new Response(req.method === 'HEAD' ? null : buf, { status: 200, headers: { 'content-type': meta.type, 'content-length': String(buf.length), 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
}

export async function handleShare(req, store) {
  const u = new URL(req.url), origin = u.origin;
  const clean = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  const code = clean(u.searchParams.get('code')), pkg = clean(u.searchParams.get('pkg'));
  const qs = new URLSearchParams(); if (code) qs.set('code', code); if (pkg) qs.set('pkg', pkg);
  const ann = u.searchParams.get('ann') === '1';
  const dest = ann ? '/#pkgs' : qs.toString() ? '/?' + qs.toString() : '/';
  let title = 'Basirah · بصيرة', desc = 'A guided personality insight assessment. Know yourself with clarity.', image = '';
  try {
    const set = store ? await store.get('settings') : null;
    const c = code && Array.isArray(set?.promo?.codes) ? set.promo.codes.find((x) => x.code === code.toUpperCase()) : null;
    const p = pkg && Array.isArray(set?.packages) ? set.packages.find((x) => x.id === pkg) : null;
    const bn = set?.promo?.banner;
    if (ann && bn && (bn.en || bn.ar)) { title = '📣 ' + (bn.en || bn.ar).slice(0, 80); desc = 'Basirah · بصيرة. Tap to see the packages.'; image = bn.image || ''; }
    else if (c) { title = '🎁 A gift from Basirah'; desc = 'A gift is waiting for you. Your promo code is applied automatically.'; image = c.image || ''; }
    if (!image && p) { title = p.name + ' · Basirah'; desc = (saleOn(p) ? 'Now SAR ' + p.sale_price + ' instead of SAR ' + p.price + '. ' : 'SAR ' + p.price + '. ') + (p.desc || ''); image = p.image || ''; }
    else if (p && !c) { title = p.name + ' · Basirah'; }
  } catch { /* the plain Basirah preview is used */ }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${H(title)}</title>${OGTAGS(origin, title, desc.slice(0, 200), imgOf(image))}<meta http-equiv="refresh" content="0;url=${H(dest)}"></head><body><a href="${H(dest)}">Basirah</a><script>location.replace(${JSON.stringify(dest).replace(/</g, '\\u003c')})</script></body></html>`;
  return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=120' } });
}

export async function handleReview(req, store) {
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);       // ['v', token]
  const token = segs[1] || '';
  const origin = new URL(req.url).origin;
  const hdr = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
  const nf = () => new Response('This link is not available.', { status: 404, headers: { ...hdr, 'content-type': 'text/plain; charset=utf-8' } });
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token) || segs.length !== 2) return nf();
  const ptr = await store.get('rvtok/' + token);
  const rec = ptr && (await store.get(keyOf(ptr.sid)));
  if (!rec) return nf();
  const settings = await store.get('settings');
  const qs = stripHidden(settings?.review_questions);
  const done = await store.get('review/' + rec.id);

  if (req.method === 'POST') {
    if (done) return fail(409, 'Your review was already sent. Thank you!');
    let b; try { b = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
    const ans = [];
    for (const q of qs) {
      const raw = b.answers?.[q.id];
      let v;
      if (q.type === 'stars') { v = Math.round(Number(raw)); if (!(v >= 1 && v <= 5)) v = null; }
      else if (q.type === 'scale') { v = raw === '' || raw == null ? null : Math.round(Number(raw)); if (!(v >= 0 && v <= 10)) v = null; }
      else v = str(raw, 1500) || null;
      if (v === null && q.required) return fail(400, 'Please answer: ' + (q.en || q.ar), { missing: q.id });
      if (v !== null) ans.push({ id: q.id, type: q.type, en: q.en, ar: q.ar, value: v });
    }
    if (!ans.length) return fail(400, 'Please answer at least one question.');
    const nameMode = ['first', 'full', 'anon'].includes(settings?.review_name) ? settings.review_name : 'choose';
    const share = b.share === true, disp = nameMode !== 'choose' ? nameMode : ['first', 'full', 'anon'].includes(b.display) ? b.display : 'first';
    const lang = b.lang === 'ar' ? 'ar' : 'en';
    const stars = ans.find((a) => a.type === 'stars')?.value || 0;
    const texts = ans.filter((a) => a.type === 'text');
    const t = now();
    const name = disp === 'full' ? rec.full_name : disp === 'first' ? firstName(rec.full_name) : (lang === 'ar' ? 'عميل بصيرة' : 'A Basirah client');
    const review = { sid: rec.id, created_at: t, updated_at: t, lang, full_name: rec.full_name, package: rec.package, answers: ans, share, display: disp, display_name: name, stars,
      quote: texts[0] && lang !== 'ar' ? texts[0].value : '', quote_ar: texts[0] && lang === 'ar' ? texts[0].value : '', featured: false };
    await store.set('review/' + rec.id, review);
    await store.set(keyOf(rec.id), { ...rec, review_at: t, updated_at: t, history: [...rec.history, { at: t, by: 'client', action: 'Review received' }] });
    return json({ ok: true }, 201);
  }
  if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'Method not allowed');
  const ar0 = (done?.lang || rec.language) === 'ar';
  const both = (en, ar) => `<span data-l="en">${en}</span><span data-l="ar">${ar}</span>`;
  const qHtml = qs.map((q, i) => {
    const lab = `<div class="ql"><span data-l="en">${H(q.en || q.ar)}</span><span data-l="ar">${H(q.ar || q.en)}</span>${q.required ? '' : both(' <i>(optional)</i>', ' <i>(اختياري)</i>')}</div>`;
    let inp;
    if (q.type === 'stars') inp = `<div class="st" role="radiogroup" data-q="${H(q.id)}" data-t="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" aria-label="${n}" data-v="${n}">★</button>`).join('')}</div>`;
    else if (q.type === 'scale') inp = `<div class="sc" role="radiogroup" data-q="${H(q.id)}" data-t="scale">${Array.from({ length: 11 }, (_, n) => `<button type="button" role="radio" aria-checked="false" data-v="${n}">${n}</button>`).join('')}</div>`;
    else inp = `<textarea data-q="${H(q.id)}" data-t="text" rows="3" maxlength="1500"></textarea>`;
    return `<div class="qb" data-req="${q.required ? 1 : 0}">${lab}${inp}</div>`;
  }).join('');
  const first = firstName(rec.full_name);
  const nameMode0 = ['first', 'full', 'anon'].includes(settings?.review_name) ? settings.review_name : 'choose';
  const title = ar0 ? 'رأيك يهمنا' : 'Your voice matters';
  const html = `<!doctype html><html lang="${ar0 ? 'ar' : 'en'}" dir="${ar0 ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Basirah · ${ar0 ? 'تقييمك' : 'Your review'}</title>${OGTAGS(origin, ar0 ? 'شاركنا رأيك في بصيرة' : 'Share your Basirah experience', ar0 ? 'دقيقتان فقط، ورأيك يصنع فرقاً.' : 'It takes two minutes, and it means a lot.')}
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--cream:#FEFAF3;--card:#fff;--teal:#0B4F4C;--sub:#587571;--gold:#B8914A;--line:#DCD3C0;--sage:#E4EDE7;--red:#b24a3a}
@media(prefers-color-scheme:dark){:root{--cream:#121a19;--card:#1b2624;--teal:#7fc4bb;--sub:#a3bab6;--gold:#d3ac66;--line:#33403d;--sage:#26332f;--red:#ef9582}}
*{box-sizing:border-box;margin:0}body{background:var(--cream);color:var(--teal);font:17px/1.6 'Tajawal',system-ui,sans-serif;min-height:100vh;padding:24px 16px 48px}
body{padding-bottom:96px}main{width:100%;max-width:560px;margin:0 auto}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.brand{font:600 30px 'Cormorant Garamond',Georgia,serif;display:flex;align-items:center;gap:10px}.brand img{width:38px;height:38px;border-radius:10px}
.lg button{border:1.5px solid var(--line);background:var(--card);color:var(--teal);border-radius:99px;padding:5px 14px;font:700 14px 'Tajawal',sans-serif;cursor:pointer}.lg button[aria-pressed=true]{background:var(--teal);color:var(--cream);border-color:var(--teal)}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:30px 24px;box-shadow:0 2px 6px rgba(11,79,76,.08),0 24px 48px -24px rgba(11,79,76,.3)}
h1{font:600 36px/1.15 'Cormorant Garamond',Georgia,serif;margin-bottom:6px}[dir=rtl] h1{font-family:'Tajawal',sans-serif;font-weight:700;font-size:30px;line-height:1.4}
.lead{color:var(--sub);margin-bottom:22px}.qb{margin:22px 0}.ql{font-weight:700;margin-bottom:8px}.ql i{font-weight:400;color:var(--sub);font-style:normal;font-size:14px}
.st{display:flex;gap:6px;direction:ltr;justify-content:flex-start}[dir=rtl] .st{justify-content:flex-end}.st button{font-size:40px;line-height:1;background:none;border:0;color:var(--line);cursor:pointer;padding:2px}.st button.on{color:var(--gold)}
.sc{display:flex;flex-wrap:wrap;gap:6px;direction:ltr}.sc button{width:42px;height:42px;border-radius:12px;border:1.5px solid var(--line);background:var(--card);color:var(--teal);font:700 16px 'Tajawal',sans-serif;cursor:pointer}.sc button.on{background:var(--teal);color:var(--cream);border-color:var(--teal)}
textarea,select{width:100%;background:var(--cream);color:var(--teal);border:1.5px solid var(--line);border-radius:14px;padding:12px 14px;font:inherit}
.sh{margin-top:26px;padding:18px;border-radius:16px;background:var(--sage)}.sh label{display:flex;gap:10px;align-items:flex-start;font-weight:700}.sh input[type=checkbox]{width:22px;height:22px;margin-top:3px;accent-color:var(--teal)}.sh .dn{margin-top:12px;display:none}.sh.on .dn{display:block}.sh small{display:block;color:var(--sub);font-weight:400;margin-top:2px}
.b{display:flex;align-items:center;justify-content:center;width:100%;background:var(--teal);color:var(--cream);border:1.5px solid var(--teal);border-radius:99px;padding:15px 24px;font:700 18px 'Tajawal',sans-serif;cursor:pointer;margin-top:24px}.b:disabled{opacity:.6}
.err{color:var(--red);font-weight:700;margin-top:12px;min-height:1.4em}.thx{text-align:center;padding:20px 4px}.thx .big{font:600 44px 'Cormorant Garamond',Georgia,serif;margin-bottom:8px}[dir=rtl] .thx .big{font-family:'Tajawal',sans-serif;font-weight:700;font-size:34px}.thx .sp{font-size:44px;color:var(--gold);margin-bottom:10px}
[data-l]{display:none}html[lang=en] [data-l=en],html[lang=ar] [data-l=ar]{display:inline}
:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
</style></head><body><main>
<div class="top"><span class="brand"><img src="/icons/icon-192.png" alt="">Basirah</span><span class="lg" role="group" aria-label="Language"><button type="button" data-set="en" aria-pressed="${!ar0}">English</button> <button type="button" data-set="ar" aria-pressed="${ar0}">العربية</button></span></div>
<div class="card" id="card">${done ? `<div class="thx"><div class="sp">✦</div><div class="big">${both('Thank you', 'شكراً لك')}</div><p class="lead">${both('Your review was already received. We are grateful for your time.', 'وصلنا تقييمك مسبقاً. نقدّر وقتك وثقتك.')}</p></div>` : `<div id="fm">
<h1>${both('Your voice matters' + (first ? ', ' + H(first) : ''), 'رأيك يهمنا' + (first ? '، ' + H(first) : ''))}</h1>
<p class="lead">${both('You have seen your insight. Tell us how it felt. It takes about two minutes.', 'اطّلعت على بصيرتك، فشاركنا كيف كان شعورك. يستغرق الأمر دقيقتين تقريباً.')}</p>
${qHtml}
<div class="sh" id="sh"><label><input type="checkbox" id="share"><span>${both('You may share my words on the Basirah website', 'يمكنكم عرض كلماتي في موقع بصيرة')}<small>${both('Optional. We never show your full report or contact details.', 'اختياري. لن نعرض تقريرك الكامل ولا بيانات التواصل أبداً.')}</small></span></label>
${nameMode0 === 'choose' ? `<div class="dn"><div class="ql" style="margin-top:4px">${both('How should your name appear?', 'كيف يظهر اسمك؟')}</div><select id="disp"><option value="first">${H(first || 'First name')}</option><option value="full">${H(rec.full_name)}</option><option value="anon">${ar0 ? 'عميل بصيرة' : 'A Basirah client'}</option></select></div></div>` : `<div class="dn"><p class="ql" style="margin-top:4px;font-weight:400">${nameMode0 === 'anon' ? both('Your name will not be shown.', 'لن يظهر اسمك.') : nameMode0 === 'full' ? both('Your full name will be shown.', 'سيظهر اسمك الكامل.') : both('Only your first name will be shown.', 'سيظهر اسمك الأول فقط.')}</p></div>`}
<button class="b" id="go" type="button">${both('Send my review', 'إرسال تقييمي')}</button><p class="err" id="er" role="alert"></p></div>
<div class="thx" id="ty" hidden><div class="sp">✦</div><div class="big">${both('Thank you', 'شكراً لك')}</div><p class="lead">${both('Your words help others begin their own journey of self-knowledge.', 'كلماتك تساعد غيرك على بدء رحلته في معرفة نفسه.')}</p></div>`}</div></main>
<script>
(function(){var L=document.documentElement,lang=L.lang;function set(l){lang=l;L.lang=l;L.dir=l==='ar'?'rtl':'ltr';document.querySelectorAll('[data-set]').forEach(function(b){b.setAttribute('aria-pressed',b.dataset.set===l)})}
document.querySelectorAll('[data-set]').forEach(function(b){b.onclick=function(){set(b.dataset.set)}});
var fm=document.getElementById('fm');if(!fm)return;var val={};
document.querySelectorAll('.st,.sc').forEach(function(g){g.onclick=function(e){var b=e.target.closest('button');if(!b)return;var v=+b.dataset.v;val[g.dataset.q]=v;g.querySelectorAll('button').forEach(function(x){var on=g.dataset.t==='stars'?+x.dataset.v<=v:+x.dataset.v===v;x.classList.toggle('on',on);x.setAttribute('aria-checked',+x.dataset.v===v)})}});
var sh=document.getElementById('sh');document.getElementById('share').onchange=function(){sh.classList.toggle('on',this.checked)};
var T={en:{need:'Please answer the questions marked above.',fail:'We could not send your review. Check your connection and try again.'},ar:{need:'يرجى الإجابة عن الأسئلة المطلوبة.',fail:'تعذّر إرسال تقييمك. تحقق من اتصالك وحاول مجدداً.'}};
document.getElementById('go').onclick=function(){var er=document.getElementById('er'),btn=this;er.textContent='';var a={},miss=false;
document.querySelectorAll('.qb').forEach(function(q){var el=q.querySelector('[data-q]'),id=el.dataset.q,v=el.dataset.t==='text'?el.value.trim():val[id];if(v===undefined||v===''){if(q.dataset.req==='1')miss=true}else a[id]=v});
if(miss){er.textContent=T[lang].need;return}
btn.disabled=true;fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answers:a,share:document.getElementById('share').checked,display:(document.getElementById('disp')||{value:'first'}).value,lang:lang})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(x.ok||x.j.error&&/already/i.test(x.j.error)){fm.hidden=true;document.getElementById('ty').hidden=false;window.scrollTo(0,0)}else{btn.disabled=false;er.textContent=x.j.error||T[lang].fail}}).catch(function(){btn.disabled=false;er.textContent=T[lang].fail})}})();
</script></body></html>`;
  return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers: { ...hdr, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
}
