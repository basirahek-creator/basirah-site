// @ts-nocheck
// Built file: paste this whole thing into the Supabase function editor.
// supabase/functions/api/index.ts
import { Buffer as Buffer3 } from "node:buffer";

// netlify/lib/core.mjs
import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";
var PACKAGES = {
  profile: { name: "Full Personality Profile", price: 200 },
  consultation: { name: "Full Analysis + 1-to-1 Consultation", price: 400 }
};
var PKG_IDS = ["profile", "consultation"];
var PKG_MAX = 12;
var defaultPkgs = () => Object.entries(PACKAGES).map(([id, p]) => ({ id, price: p.price, name: p.name, consult: id === "consultation" }));
var pkgList = async (store) => {
  const set = await store.get("settings");
  return Array.isArray(set?.packages) && set.packages.length ? set.packages : defaultPkgs();
};
var saleOn = (p, t = Date.now()) => Number(p.sale_price) > 0 && Number(p.sale_price) < p.price && (!p.sale_ends || Date.parse(p.sale_ends) > t);
var effPrice = (p, t) => saleOn(p, t) ? Number(p.sale_price) : p.price;
var pkgInfo = async (store, id) => {
  const p = (await pkgList(store)).find((x) => x.id === id);
  if (!p) return null;
  return { id: p.id, name: p.name, list: p.price, price: effPrice(p), sale: saleOn(p), consult: p.consult === void 0 ? p.id === "consultation" : p.consult === true };
};
var normCode = (v) => typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24) : "";
var promoWhy = (c, pk, t, used, personUsed = false) => {
  if (!c || c.active === false) return "invalid";
  if (c.starts_at && Date.parse(c.starts_at) > t) return "soon";
  if (c.ends_at && Date.parse(c.ends_at) <= t) return "expired";
  if (c.max_uses > 0 && used >= c.max_uses) return "used_up";
  if (c.once_per_person && personUsed) return "person_used";
  if (Array.isArray(c.packages) && c.packages.length && !c.packages.includes(pk.id)) return "wrong_package";
  if (c.combine === false && pk.sale) return "no_combine";
  return "";
};
var promoMath = (c, base) => {
  if (c.type === "free") return { discount: base, final: 0 };
  const raw = c.type === "percent" ? Math.round(base * c.value / 100) : c.value;
  const discount = Math.max(0, Math.min(raw, base - 1));
  return { discount, final: base - discount };
};
var promoUsed = async (store, code) => (await store.get("promouse/" + code))?.n || 0;
var personKey = (contact) => {
  const s = String(contact || "").trim().toLowerCase();
  if (!s) return "";
  const k = s.includes("@") ? s : normPhone(s) || s.replace(/\s+/g, "");
  return createHash("sha256").update(k).digest("hex").slice(0, 24);
};
async function checkPromo(store, rawCode, pk, contact) {
  const code = normCode(rawCode);
  if (!code || !pk) return { ok: false, reason: "invalid" };
  const set = await store.get("settings");
  const c = Array.isArray(set?.promo?.codes) ? set.promo.codes.find((x) => x.code === code) : null;
  const pkey = personKey(contact);
  const personUsed = c && c.once_per_person && pkey ? !!await store.get("promoperson/" + code + "." + pkey) : false;
  const why = promoWhy(c, pk, Date.now(), c ? await promoUsed(store, code) : 0, personUsed);
  if (why) return { ok: false, reason: why };
  const m = promoMath(c, pk.price);
  return { ok: true, code, type: c.type, value: c.value, base: pk.price, image: c.image || "", free: m.final === 0, once: c.once_per_person === true, pkey, label: c.campaign || c.note || "", campaign: c.campaign || "", ...m };
}
async function handlePromo(req, store) {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  let b;
  try {
    b = await req.json();
  } catch {
    return fail(400, "Invalid JSON");
  }
  const ip = req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
  const rk = "promorl/" + createHash("sha256").update(ip).digest("hex").slice(0, 12) + "-" + Math.floor(Date.now() / 36e5);
  const n = ((await store.get(rk))?.n || 0) + 1;
  if (n > 40) return fail(429, "Too many tries. Please wait a little and try again.");
  await store.set(rk, { n });
  const pk = await pkgInfo(store, b?.package);
  const r = await checkPromo(store, b?.code, pk, str(b?.contact, 200));
  const { pkey, once, label, campaign, ...pub } = r;
  return json(pub);
}
var PAYMENT = ["pending", "verified", "rejected"];
var REPORT = ["not_started", "in_progress", "ready", "delivered"];
var CONSULT = ["not_scheduled", "scheduled", "completed"];
var METHODS = ["Email", "WhatsApp", "Mobile"];
var MAX_BODY = 5e5;
var json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
var fail = (status, error, extra = {}) => json({ error, ...extra }, status);
var str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var keyOf = (id) => "sub/" + id;
async function promoFor(store, raw, pki, contact, subId) {
  const code = normCode(raw);
  if (!code) return {};
  const r = await checkPromo(store, code, pki, contact);
  if (!r.ok) return { promo_invalid: code + " (" + r.reason + ")" };
  await store.set("promouse/" + code, { n: await promoUsed(store, code) + 1 });
  const out = { promo_code: code, discount_sar: r.discount, price_sar: r.final, ...r.campaign ? { promo_campaign: r.campaign } : {} };
  if (r.once && r.pkey) {
    await store.set("promoperson/" + code + "." + r.pkey, { sub: subId, at: now() });
    out.promo_person = r.pkey;
  }
  if (r.free) Object.assign(out, { is_free: true, free_by: "code", free_value_sar: r.base, free_label: r.label || code });
  return out;
}
function makeFree(rec, t, how) {
  rec.payment_status = "verified";
  rec.verified_at = t;
  rec.price_sar = 0;
  rec.pay_flags = [];
  rec.payment_reference = "";
  rec.payment_receipt = "";
  rec.payment_method = how;
  rec.history.push({ at: t, by: rec.free_by === "admin" ? "admin" : "system", action: "Free order (" + (rec.free_by === "admin" ? "gift" : "code " + rec.promo_code) + ")" + (rec.free_label ? ": " + rec.free_label : "") + ". No payment needed, marked as verified" });
}
async function handleSubmit(req, store) {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "Submission too large");
  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    return fail(400, "Invalid JSON");
  }
  if (!b || typeof b !== "object") return fail(400, "Invalid body");
  const id = str(b.submission_id, 16);
  if (!/^BSR-[A-Z0-9]{4,10}$/.test(id)) return fail(400, "Missing or invalid submission_id");
  const pki = await pkgInfo(store, b.package), pkg = pki ? pki.id : null;
  const name = str(b.full_name, 200), contact = str(b.contact, 200);
  if (!pkg || !name || !contact) return fail(400, "Missing required fields");
  if (await store.get(keyOf(id))) return json({ ok: true, duplicate: true });
  const answers = Object.keys(b).map((k) => {
    const m = /^Q(\d{2}) - (.*)$/s.exec(k);
    return m && typeof b[k] === "string" ? { n: +m[1], q: m[2].slice(0, 1e3), a: b[k].slice(0, 8e3) } : null;
  }).filter(Boolean).sort((x, y) => x.n - y.n).slice(0, 80);
  const t = now();
  const rec = {
    id,
    source: "site",
    created_at: t,
    updated_at: t,
    full_name: name,
    package: pkg,
    package_name: pki.name,
    price_sar: pki.price,
    list_price: pki.list,
    ...await promoFor(store, b.promo_code, pki, contact, id),
    contact_method: METHODS.includes(b.contact_method) ? b.contact_method : "Email",
    contact,
    payment_reference: str(b.payment_reference, 200),
    payment_receipt: str(b.payment_receipt, 2e3),
    payment_method: str(b.payment_method, 80),
    language: b.language === "ar" ? "ar" : "en",
    answers,
    consent_at: b.consent_given === true && b.consent_at && !isNaN(Date.parse(b.consent_at)) ? new Date(b.consent_at).toISOString() : null,
    consent_language: b.consent_language === "ar" ? "ar" : "en",
    payment_status: "pending",
    report_status: "not_started",
    consult_status: pki.consult ? "not_scheduled" : null,
    consult_at: null,
    verified_at: null,
    delivered_at: null,
    delivery_note: "",
    notes: "",
    history: [{ at: t, by: "client", action: "Assessment submitted" }]
  };
  if (rec.is_free) makeFree(rec, t, "Free (code " + rec.promo_code + ")");
  else rec.pay_flags = await payFlags(store, rec);
  await store.set(keyOf(id), rec);
  return json({ ok: true, id, free: rec.is_free === true }, 201);
}
var sha = (s) => createHash("sha256").update(String(s)).digest();
var secretOf = (env) => env.ADMIN_SECRET || "basirah-admin:" + env.ADMIN_PASSWORD;
var sign = (secret, p) => createHmac("sha256", secret).update(p).digest("base64url");
function makeToken(env, ttl = 12 * 3600) {
  const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1e3) + ttl })).toString("base64url");
  return p + "." + sign(secretOf(env), p);
}
function tokenOk(env, header) {
  const tok = (header || "").replace(/^Bearer\s+/i, "");
  const [p, g] = tok.split(".");
  if (!p || !g) return false;
  const a = Buffer.from(g), e = Buffer.from(sign(secretOf(env), p));
  if (a.length !== e.length || !timingSafeEqual(a, e)) return false;
  try {
    return JSON.parse(Buffer.from(p, "base64url").toString()).exp > Date.now() / 1e3;
  } catch {
    return false;
  }
}
var failures = 0;
var lockedUntil = 0;
var WEAK_REF = /^(.)\1{3,}$|^(0123|1234|2345|3456|4567|5678|6789|12345|123456|1234567|12345678|123456789|0000|test|xxxx|none|nil|null|paid|done|ok|na|n\/a|payment|transfer)$/i;
var refKey = (r) => String(r || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function payFlags(store, rec) {
  const flags = [];
  const fid = /\/api\/file\/([A-Za-z0-9_-]{10,40})/.exec(rec.payment_receipt || "");
  const claim = async (key, label, code) => {
    const hit = await store.get(key);
    if (hit && hit.sub && hit.sub !== rec.id && await store.get(keyOf(hit.sub))) {
      const o = await store.get(keyOf(hit.sub));
      flags.push({ code, text: label + " (" + (o.full_name || hit.sub) + ", " + hit.sub + ")", other: hit.sub });
    } else await store.set(key, { sub: rec.id, at: now() });
  };
  if (rec.source === "site" && (!fid || /Upload failed/i.test(rec.payment_receipt || ""))) flags.push({ code: "no_receipt", text: "No receipt came through. Ask the client to send it again." });
  if (fid) {
    const meta = await store.get("uplmeta/" + fid[1]);
    if (meta && meta.hash) await claim("rchash/" + meta.hash, "This exact receipt picture was already used on another order", "dup_receipt");
  }
  const k = refKey(rec.payment_reference);
  if (k) {
    if (k.length < 5 || WEAK_REF.test(String(rec.payment_reference).trim()) || WEAK_REF.test(k)) flags.push({ code: "weak_ref", text: "The reference looks unusual (\u201C" + rec.payment_reference + "\u201D). Check it against your bank." });
    else await claim("refkey/" + createHash("sha256").update(k).digest("hex").slice(0, 24), "This reference was already used on another order", "dup_ref");
  }
  return flags;
}
var summary = (r, withReport = /* @__PURE__ */ new Set(), withPdf = /* @__PURE__ */ new Set()) => {
  const { answers, history, ...rest } = r;
  return { ...rest, has_report: withReport.has(r.id), has_pdf: withPdf.has(r.id), answered: answers.filter((a) => a.a && !a.a.startsWith("VOICE ANSWER")).length, voice: answers.filter((a) => a.a.startsWith("VOICE ANSWER")).length };
};
var valuesOf = async (store, prefix) => store.listValues ? store.listValues(prefix) : (await Promise.all((await store.list(prefix)).map((k) => store.get(k)))).filter(Boolean);
async function load(store, id) {
  return id ? store.get(keyOf(id)) : null;
}
var MIG_CHUNK = 2e6;
async function handleExport(req, store) {
  const cur = new URL(req.url).searchParams.get("cursor") || "";
  const [curKey, curOff] = cur.split("|");
  const keys = (await store.list("")).filter((k) => !/^promorl\//.test(k) && !k.startsWith("bin:")).sort();
  const items = [];
  let bytes = 0, next = null;
  const t0 = Date.now();
  for (const key of keys) {
    if (curKey && key < curKey) continue;
    if (items.length && (bytes > MIG_CHUNK || Date.now() - t0 > 5e3)) {
      next = key;
      break;
    }
    let v = null;
    try {
      v = await store.get(key);
    } catch {
      v = null;
    }
    if (v !== null && v !== void 0) {
      items.push({ key, type: "json", value: v });
      bytes += JSON.stringify(v).length;
      continue;
    }
    const buf = await store.getBin(key);
    if (!buf) continue;
    const start = key === curKey ? Number(curOff) || 0 : 0, part = buf.subarray(start, start + MIG_CHUNK);
    items.push({ key, type: "bin", total: buf.length, off: start, b64: Buffer.from(part).toString("base64") });
    bytes += part.length * 1.4;
    if (start + part.length < buf.length) {
      next = key + "|" + (start + part.length);
      break;
    }
  }
  return json({ items, next, keys: keys.length });
}
var SAFE_KEY = /^[A-Za-z0-9_\-./:]{1,200}$/;
async function handleImport(req, store, kind) {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (kind === "import-bin") {
    const key = new URL(req.url).searchParams.get("key") || "";
    if (!SAFE_KEY.test(key) || key.includes("..")) return fail(400, "Bad key");
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return fail(400, "Empty file");
    await store.setBin(key, buf);
    return json({ ok: true, key, bytes: buf.length });
  }
  let b;
  try {
    b = await req.json();
  } catch {
    return fail(400, "Invalid JSON");
  }
  if (!Array.isArray(b?.items) || b.items.length > 500) return fail(400, "Send up to 500 items at a time");
  let n = 0;
  for (const it of b.items) {
    if (it?.type !== "json" || !SAFE_KEY.test(it.key || "") || it.key.includes("..") || it.value === void 0) continue;
    await store.set(it.key, it.value);
    n++;
  }
  return json({ ok: true, imported: n });
}
var migOrigin = (o, env) => !!o && (/^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(o) || /^http:\/\/localhost(:\d+)?$/.test(o) || env.MIGRATE_ORIGIN && o === env.MIGRATE_ORIGIN);
async function handleAdmin(req, store, env, base = "/api/admin") {
  const o = req.headers.get("origin"), p = new URL(req.url).pathname.replace(base, "").replace(/\/+$/, "") || "/";
  const cors = migOrigin(o, env) && (p === "/login" || p === "/export");
  const hdrs = { "access-control-allow-origin": o || "", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin" };
  if (cors && req.method === "OPTIONS") return new Response(null, { status: 204, headers: hdrs });
  const res = await handleAdminInner(req, store, env, base);
  if (!cors) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(hdrs)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
async function handleAdminInner(req, store, env, base = "/api/admin") {
  if (!env.ADMIN_PASSWORD) return fail(503, "ADMIN_PASSWORD is not set on the server");
  const url = new URL(req.url);
  const path = url.pathname.replace(base, "").replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  const m = req.method;
  if (path === "/login" && m === "POST") {
    if (Date.now() < lockedUntil) return fail(429, "Too many attempts. Wait a minute and try again.");
    let body = {};
    try {
      body = await req.json();
    } catch {
    }
    const ok = timingSafeEqual(sha(body.password || ""), sha(env.ADMIN_PASSWORD));
    if (!ok) {
      if (++failures >= 5) {
        lockedUntil = Date.now() + 6e4;
        failures = 0;
      }
      await new Promise((r) => setTimeout(r, 400));
      return fail(401, "Incorrect password");
    }
    failures = 0;
    const ttl = body.remember === true ? 30 * 86400 : 12 * 3600;
    return json({ token: makeToken(env, ttl), expires_in: ttl });
  }
  if (!tokenOk(env, req.headers.get("authorization"))) return fail(401, "Please sign in again");
  if (parts[0] === "export" && m === "GET") return handleExport(req, store);
  if (parts[0] === "import" || parts[0] === "import-bin") return handleImport(req, store, parts[0]);
  if (parts[0] === "docs") return handleDocs(req, store, parts[1]);
  if (parts[0] === "translate") return handleTranslate(req, env);
  if (parts[0] === "settings") return handleAdminSettings(req, store);
  if (parts[0] === "image") return handleAdminImage(req, store);
  if (parts[0] === "reviews") return handleAdminReviews(req, store, parts[1]);
  if (parts[0] !== "submissions") return fail(404, "Not found");
  const id = parts[1];
  if (!id && m === "GET") {
    const withReport = new Set((await store.list("doc/")).filter((k) => k.startsWith("doc/r-")).map((k) => k.slice(6)));
    const withPdf = new Set((await store.list("pdfmeta/")).map((k) => k.slice(8)));
    const recs = (await valuesOf(store, "sub/")).map((r) => summary(r, withReport, withPdf));
    recs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json({ submissions: recs, server_time: now() });
  }
  if (!id && m === "POST") {
    let b;
    try {
      b = await req.json();
    } catch {
      return fail(400, "Invalid JSON");
    }
    const pki = await pkgInfo(store, b.package), pkg = pki ? pki.id : null, name = str(b.full_name, 200), contact = str(b.contact, 200);
    if (!pkg || !name || !contact) return fail(400, "Name, contact and package are required");
    const t = now(), when = b.created_at && !isNaN(Date.parse(b.created_at)) ? new Date(b.created_at).toISOString() : t;
    const nid = "BSR-M" + randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
    const free = b.free === true;
    const rec2 = {
      id: nid,
      source: "manual",
      created_at: when,
      updated_at: t,
      full_name: name,
      package: pkg,
      package_name: pki.name,
      price_sar: pki.price,
      list_price: pki.list,
      contact_method: METHODS.includes(b.contact_method) ? b.contact_method : "Email",
      contact,
      payment_reference: str(b.payment_reference, 200),
      payment_receipt: str(b.payment_receipt, 2e3),
      language: "en",
      answers: [],
      consent_at: null,
      consent_language: "en",
      payment_status: "pending",
      report_status: "not_started",
      consult_status: pki.consult ? "not_scheduled" : null,
      consult_at: null,
      verified_at: null,
      delivered_at: null,
      delivery_note: "",
      notes: str(b.notes, 4e3),
      history: [{ at: t, by: "admin", action: "Added manually" }],
      ...free ? { discount_sar: pki.price, is_free: true, free_by: "admin", free_value_sar: pki.price, free_label: str(b.free_reason, 100) || "Gift" } : {}
    };
    if (free) makeFree(rec2, t, "Free (gift)");
    else rec2.pay_flags = await payFlags(store, rec2);
    await store.set(keyOf(nid), rec2);
    return json({ submission: summary(rec2) }, 201);
  }
  const rec = await load(store, id);
  if (!rec) return fail(404, "Submission not found");
  if (parts[2] === "pdf") return handlePdf(req, store, rec);
  if (parts[2] === "review-link" && m === "POST") {
    let meta = await store.get("rvmeta/" + id);
    const t = now();
    if (!meta) {
      let token;
      do {
        token = randomBytes(8).toString("base64url");
      } while (await store.get("rvtok/" + token));
      meta = { token, sid: id, requested_at: t };
      await store.set("rvtok/" + token, { sid: id });
      await store.set("rvmeta/" + id, meta);
      const next = { ...rec, review_requested_at: t, updated_at: t, history: [...rec.history, { at: t, by: "admin", action: "Review link created" }] };
      await store.set(keyOf(id), next);
      return json({ review_link: { token: meta.token, path: "/v/" + meta.token, requested_at: t }, submission: next });
    }
    return json({ review_link: { token: meta.token, path: "/v/" + meta.token, requested_at: meta.requested_at }, submission: rec });
  }
  if (parts[2] === "contact" && m === "POST") {
    let b = {};
    try {
      b = await req.json();
    } catch {
    }
    const ch = { whatsapp: "WhatsApp", email: "email", copy: "copied to send elsewhere" }[b.channel];
    if (!ch) return fail(400, "Unknown channel");
    const t = now(), what = str(b.what, 80);
    const next = { ...rec, history: [...rec.history, { at: t, by: "admin", action: "Message to client (" + ch + ")" + (what ? ": " + what : "") }], last_contacted_at: t, updated_at: t, ...b.kind === "delay" ? { delay_notice_at: t, delay_notices: (rec.delay_notices || 0) + 1 } : {} };
    await store.set(keyOf(id), next);
    return json({ submission: next });
  }
  if (m === "GET") {
    const d = await store.get("doc/r-" + id);
    const pm = await store.get("pdfmeta/" + id);
    const rm = await store.get("rvmeta/" + id);
    return json({ submission: rec, report_link: d ? { id: d.id, title: d.title || "", updatedAt: d.updatedAt || 0 } : null, pdf_link: pm ? pdfLink(pm) : null, review_link: rm ? { token: rm.token, path: "/v/" + rm.token, requested_at: rm.requested_at } : null });
  }
  if (m === "DELETE") {
    if (rec.promo_code) {
      const used = await promoUsed(store, rec.promo_code);
      if (used > 0) await store.set("promouse/" + rec.promo_code, { n: used - 1 });
      if (rec.promo_person) await store.delete("promoperson/" + rec.promo_code + "." + rec.promo_person);
    }
    await dropFiles(store, rec);
    await store.delete(keyOf(id));
    await store.delete("doc/r-" + id);
    await dropPdf(store, id);
    await dropReview(store, id);
    return json({ ok: true });
  }
  if (m === "PATCH") {
    let b;
    try {
      b = await req.json();
    } catch {
      return fail(400, "Invalid JSON");
    }
    if (b.updated_at && b.updated_at !== rec.updated_at) return fail(409, "This record was changed by someone else. It has been reloaded.", { submission: rec });
    const t = now();
    const next = { ...rec, history: [...rec.history] };
    const L = (action) => next.history.push({ at: t, by: "admin", action });
    if (b.mark_free === true) {
      if (rec.is_free) return fail(409, "This is already a free order.");
      const reason = str(b.free_reason, 100) || "Gift";
      next.was = { price_sar: rec.price_sar, payment_status: rec.payment_status, verified_at: rec.verified_at || null, payment_method: rec.payment_method || "", payment_reference: rec.payment_reference || "", payment_receipt: rec.payment_receipt || "", discount_sar: rec.discount_sar ?? null, pay_flags: rec.pay_flags || [] };
      next.is_free = true;
      next.free_by = "admin";
      next.free_label = reason;
      next.free_value_sar = rec.price_sar || rec.list_price || 0;
      next.discount_sar = rec.list_price || rec.price_sar || 0;
      next.price_sar = 0;
      next.pay_flags = [];
      next.payment_status = "verified";
      next.verified_at = rec.verified_at || t;
      next.payment_method = "Free (gift)";
      next.reject_reason = "";
      L("Marked as a free order: " + reason + ". It no longer counts as revenue (it was SAR " + (rec.price_sar || 0) + ", " + rec.payment_status + ")");
    } else if (b.unmark_free === true) {
      if (!rec.is_free || !rec.was) return fail(409, "This order can not be turned back into a paid order.");
      const w = rec.was;
      next.price_sar = w.price_sar;
      next.payment_status = w.payment_status;
      next.verified_at = w.verified_at;
      next.payment_method = w.payment_method;
      next.payment_reference = w.payment_reference;
      next.payment_receipt = w.payment_receipt;
      next.pay_flags = w.pay_flags || [];
      if (w.discount_sar === null) delete next.discount_sar;
      else next.discount_sar = w.discount_sar;
      for (const k of ["is_free", "free_by", "free_label", "free_value_sar", "was"]) delete next[k];
      L("Turned back into a paid order (SAR " + w.price_sar + ", " + w.payment_status + ")");
    }
    if (b.payment_status !== void 0 && b.payment_status !== rec.payment_status && !b.mark_free && !b.unmark_free) {
      if (!PAYMENT.includes(b.payment_status)) return fail(400, "Invalid payment status");
      if (rec.is_free) return fail(409, "This is a free order, so there is no payment to change.");
      if (rec.payment_status === "verified" && rec.report_status !== "not_started") return fail(409, "Move the report back to \u201CNot started\u201D before changing a verified payment.");
      next.payment_status = b.payment_status;
      next.verified_at = b.payment_status === "verified" ? t : null;
      next.reject_reason = b.payment_status === "rejected" ? str(b.reject_reason, 300) : "";
      L({ verified: "Payment verified", rejected: "Payment rejected", pending: "Payment set back to pending" }[b.payment_status] + (next.reject_reason ? ": " + next.reject_reason : ""));
    }
    if (b.report_status !== void 0 && b.report_status !== rec.report_status) {
      if (!REPORT.includes(b.report_status)) return fail(400, "Invalid report status");
      if (b.report_status !== "not_started" && next.payment_status !== "verified") return fail(409, "Verify the payment before preparing the report.");
      next.report_status = b.report_status;
      next.delivered_at = b.report_status === "delivered" ? t : null;
      L({ not_started: "Report moved back to not started", in_progress: "Report preparation started", ready: "Report marked ready to send", delivered: "Report delivered to client" }[b.report_status]);
    }
    if (b.delivery_note !== void 0) next.delivery_note = str(b.delivery_note, 1e3);
    if (rec.consult_status) {
      if (b.consult_status !== void 0 && b.consult_status !== rec.consult_status) {
        if (!CONSULT.includes(b.consult_status)) return fail(400, "Invalid consultation status");
        next.consult_status = b.consult_status;
        L({ not_scheduled: "Consultation unscheduled", scheduled: "Consultation scheduled", completed: "Consultation completed" }[b.consult_status]);
      }
      if (b.consult_at !== void 0) {
        if (b.consult_at && isNaN(Date.parse(b.consult_at))) return fail(400, "Invalid consultation date");
        next.consult_at = b.consult_at ? new Date(b.consult_at).toISOString() : null;
      }
    }
    if (b.notes !== void 0 && str(b.notes, 4e3) !== rec.notes) {
      next.notes = str(b.notes, 4e3);
      L("Notes updated");
    }
    if (next.history.length === rec.history.length && JSON.stringify({ ...next, history: 0 }) === JSON.stringify({ ...rec, history: 0 })) return json({ submission: rec });
    next.updated_at = t;
    await store.set(keyOf(id), next);
    return json({ submission: next });
  }
  return fail(405, "Method not allowed");
}
var MAX_DOC = 6e5;
async function handleDocs(req, store, id) {
  const m = req.method;
  if (!id && m === "GET") {
    const docs = await valuesOf(store, "doc/");
    return json({ docs });
  }
  if (!id || !/^[A-Za-z0-9_-]{3,60}$/.test(id)) return fail(400, "Invalid document id");
  if (m === "GET") {
    const d = await store.get("doc/" + id);
    return d ? json({ doc: d }) : fail(404, "Document not found");
  }
  if (m === "DELETE") {
    await store.delete("doc/" + id);
    return json({ ok: true });
  }
  if (m === "PUT") {
    const raw = await req.text();
    if (raw.length > MAX_DOC) return fail(413, "Document too large");
    let b;
    try {
      b = JSON.parse(raw);
    } catch {
      return fail(400, "Invalid JSON");
    }
    const docs = b && b.docs && typeof b.docs.en === "string" && typeof b.docs.ar === "string" ? { en: b.docs.en, ar: b.docs.ar } : null;
    if (!docs) return fail(400, "Document text is missing");
    const sid = typeof b.submissionId === "string" && /^BSR-[A-Z0-9]{4,10}$/.test(b.submissionId) ? b.submissionId : null;
    const old = await store.get("doc/" + id);
    const rec = {
      id,
      owner: "admin",
      createdAt: old?.createdAt || Date.now(),
      updatedAt: Date.now(),
      updatedBy: "admin",
      title: str(b.title, 300),
      titleAr: str(b.titleAr, 300),
      forName: str(b.forName, 100),
      docs,
      sync: b.sync && typeof b.sync === "object" ? b.sync : null,
      opts: b.opts && typeof b.opts === "object" ? b.opts : {},
      submissionId: sid
    };
    await store.set("doc/" + id, rec);
    return json({ doc: rec });
  }
  return fail(405, "Method not allowed");
}
function chunkText(t, max = 420) {
  const parts = t.match(/[^.!?؟۔\n]+[.!?؟۔]*\s*|\n+/g) || [t], out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur);
      cur = "";
    }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else cur += p;
  }
  if (cur) out.push(cur);
  return out;
}
async function freeTranslate(texts, to, fetchImpl) {
  const pair = to === "ar" ? "en|ar" : "ar|en";
  const one = async (chunk) => {
    if (!chunk.trim() || !/[\p{L}]/u.test(chunk)) return chunk;
    const r = await fetchImpl("https://api.mymemory.translated.net/get?langpair=" + encodeURIComponent(pair) + "&q=" + encodeURIComponent(chunk));
    const j = await r.json().catch(() => null);
    const out = j?.responseData?.translatedText;
    if (!r.ok || !out || j.responseStatus && Number(j.responseStatus) !== 200 || /MYMEMORY WARNING/i.test(out)) {
      const e = new Error(/MYMEMORY WARNING|ALL AVAILABLE FREE/i.test(String(out)) || r.status === 429 ? "quota" : "failed");
      e.status = r.status;
      throw e;
    }
    return out;
  };
  const result = [];
  for (const t of texts) {
    const chunks = chunkText(String(t));
    const done = new Array(chunks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (next < chunks.length) {
        const i = next++;
        done[i] = await one(chunks[i]);
      }
    }));
    result.push(done.join(""));
  }
  return result;
}
async function handleTranslate(req, env, fetchImpl = fetch) {
  if (req.method === "GET") return json({ enabled: !!env.ANTHROPIC_API_KEY });
  if (req.method !== "POST") return fail(405, "Method not allowed");
  let b;
  try {
    b = await req.json();
  } catch {
    return fail(400, "Invalid JSON");
  }
  if (Array.isArray(b.texts)) {
    if (b.texts.length > 60 || b.texts.some((x) => typeof x !== "string") || b.texts.join("").length > 12e3) return fail(400, "The text is empty or too long", { code: "prompt_too_large" });
    try {
      return json({ result: await freeTranslate(b.texts, b.to === "ar" ? "ar" : "en", fetchImpl), engine: "free" });
    } catch (e) {
      if (e.message === "quota") return fail(429, "The free translator has reached its limit for today", { code: "rate_limited", detail: "The free translator is full for today. Try again tomorrow, or use the paste option." });
      return fail(502, "The free translator did not answer", { code: "failed", detail: "The free translator did not answer. Try again in a minute." });
    }
  }
  if (!env.ANTHROPIC_API_KEY) return fail(503, "Automatic translation is not set up on the server", { code: "capability_disabled" });
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  if (!prompt || prompt.length > 3e4) return fail(400, "The text is empty or too long", { code: "prompt_too_large" });
  let r;
  try {
    r = await fetchImpl((env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.TRANSLATE_MODEL || "claude-sonnet-5-5", max_tokens: 8e3, messages: [{ role: "user", content: prompt }] })
    });
  } catch (e) {
    return fail(502, "Could not reach the translation service", { code: "failed", detail: String(e?.message || e).slice(0, 160) });
  }
  if (r.status === 429) return fail(429, "Too many requests", { code: "rate_limited" });
  if (!r.ok) {
    let why = "";
    try {
      const j = await r.json();
      why = (j?.error?.type ? j.error.type + ": " : "") + (j?.error?.message || "");
    } catch {
    }
    console.error("translate failed", r.status, why);
    return fail(502, "The translation service returned an error", { code: "failed", detail: ("HTTP " + r.status + (why ? " - " + why : "")).slice(0, 220) });
  }
  const data = await r.json();
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return fail(502, "The translation could not be read", { code: "invalid_json" });
  }
  return json({ result });
}
var KINDS = ["stc", "bank", "apple", "qr", "link", "other"];
var TEMPLATE_KEYS = ["received", "payment_issue", "delay", "report", "report_file", "consult", "consult_confirm", "review"];
var MAX_SETTINGS = 11e5;
var MAX_QR = 25e4;
var OLD_GREETING = { en: "Hello, I would like to ask about the Basirah assessment.", ar: "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064A\u0643\u0645\u060C \u0623\u0631\u063A\u0628 \u0641\u064A \u0627\u0644\u0627\u0633\u062A\u0641\u0633\u0627\u0631 \u0639\u0646 \u062A\u0642\u064A\u064A\u0645 \u0628\u0635\u064A\u0631\u0629." };
var PREV_GREETING = { en: "Hello Basirah \u{1F33F}\nI would like to begin my journey of self-insight. Could you tell me more about the assessment?\n\n\u2728 Basirah by EhsanKey\n{site}", ar: "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064A\u0643\u0645 \u0628\u0635\u064A\u0631\u0629 \u{1F33F}\n\u0623\u0631\u063A\u0628 \u0641\u064A \u0628\u062F\u0621 \u0631\u062D\u0644\u062A\u064A \u0646\u062D\u0648 \u0645\u0639\u0631\u0641\u0629 \u0646\u0641\u0633\u064A\u060C \u0647\u0644\u0651\u0627 \u0632\u0648\u0651\u062F\u062A\u0645\u0648\u0646\u064A \u0628\u0627\u0644\u0645\u0632\u064A\u062F \u0639\u0646 \u0627\u0644\u062A\u0642\u064A\u064A\u0645\u061F\n\n\u2728 \u0628\u0635\u064A\u0631\u0629 \u0645\u0646 \u0625\u062D\u0633\u0627\u0646\n{site}" };
var DEFAULT_GREETING = { en: "*Hello Basirah* \u{1F33F}\nI would like to begin my journey of self-insight. Could you tell me more about the assessment?\n\n\u2728 Basirah by EhsanKey\n{site}", ar: "*\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064A\u0643\u0645 \u0628\u0635\u064A\u0631\u0629* \u{1F33F}\n\u0623\u0631\u063A\u0628 \u0641\u064A \u0628\u062F\u0621 \u0631\u062D\u0644\u062A\u064A \u0646\u062D\u0648 \u0645\u0639\u0631\u0641\u0629 \u0646\u0641\u0633\u064A\u060C \u0647\u0644\u0651\u0627 \u0632\u0648\u0651\u062F\u062A\u0645\u0648\u0646\u064A \u0628\u0627\u0644\u0645\u0632\u064A\u062F \u0639\u0646 \u0627\u0644\u062A\u0642\u064A\u064A\u0645\u061F\n\n\u2728 \u0628\u0635\u064A\u0631\u0629 \u0645\u0646 \u0625\u062D\u0633\u0627\u0646\n{site}" };
var upGreet = (s) => s && s.wa_greeting ? { ...s, wa_greeting: { en: [OLD_GREETING.en, PREV_GREETING.en].includes(s.wa_greeting.en) ? DEFAULT_GREETING.en : s.wa_greeting.en, ar: [OLD_GREETING.ar, PREV_GREETING.ar].includes(s.wa_greeting.ar) ? DEFAULT_GREETING.ar : s.wa_greeting.ar } } : s;
var emptySettings = () => ({ business_name: "Basirah", whatsapp: [], wa_greeting: { ...DEFAULT_GREETING }, show_default_qr: true, payments: [], templates: {}, questions: null, review_name: "choose", packages: null, promo: null, info: null, review_questions: null, updated_at: null });
function normPhone(v) {
  const raw = String(v || "").trim();
  let d = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) d = d.slice(2);
  else if (/^05\d{8}$/.test(d)) d = "966" + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = "966" + d;
  return d.length >= 8 && d.length <= 15 ? d : "";
}
var tid = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(v) ? v : randomBytes(4).toString("hex");
function cleanSettings(b, prev) {
  if (!b || typeof b !== "object") return { error: "Invalid settings" };
  const out = emptySettings();
  out.business_name = str(b.business_name, 60) || "Basirah";
  out.show_default_qr = b.show_default_qr !== false;
  out.wa_greeting = { en: str(b.wa_greeting?.en, 500) || DEFAULT_GREETING.en, ar: str(b.wa_greeting?.ar, 500) || DEFAULT_GREETING.ar };
  const wa = Array.isArray(b.whatsapp) ? b.whatsapp.slice(0, 6) : [];
  for (const w of wa) {
    const number = normPhone(w?.number);
    if (!number) return { error: "The WhatsApp number \u201C" + str(w?.number, 30) + "\u201D is not valid. Use the full number, for example 0551234567 or +966551234567." };
    out.whatsapp.push({ id: tid(w.id), label: str(w.label, 40) || "WhatsApp", label_ar: str(w.label_ar, 40), number });
  }
  const pay = Array.isArray(b.payments) ? b.payments.slice(0, 10) : [];
  for (const p of pay) {
    const label = str(p?.label, 60);
    if (!label) return { error: "Every payment method needs a name." };
    let url = str(p.url, 500);
    if (url && !/^https?:\/\//i.test(url)) return { error: "\u201C" + label + "\u201D: the payment link must start with https://" };
    const qr = [];
    for (const q of Array.isArray(p.qr) ? p.qr.slice(0, 4) : []) {
      const src = typeof q?.src === "string" ? q.src : "";
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return { error: "\u201C" + label + "\u201D: a QR code image is not valid. Upload a PNG or JPG." };
      if (src.length > MAX_QR) return { error: "\u201C" + label + "\u201D: a QR code image is too large. Use a smaller picture." };
      qr.push({ src, caption: str(q.caption, 60) });
    }
    const m = { id: tid(p.id), kind: KINDS.includes(p.kind) ? p.kind : "other", label, label_ar: str(p.label_ar, 60), value: str(p.value, 120), holder: str(p.holder, 100), bank: str(p.bank, 100), url, note: str(p.note, 400), note_ar: str(p.note_ar, 400), qr };
    if (!m.value && !m.url && !m.qr.length && !m.note) return { error: "\u201C" + label + "\u201D needs a number, a link, a QR code or a note." };
    out.payments.push(m);
  }
  if (b.questions === null || b.questions === void 0) out.questions = null;
  else {
    if (!Array.isArray(b.questions) || b.questions.length > 80) return { error: "You can have up to 80 questions." };
    const seen = /* @__PURE__ */ new Set();
    out.questions = [];
    for (const [i, q] of b.questions.entries()) {
      const en = str(q?.en, 600), ar = str(q?.ar, 600);
      if (!en && !ar) return { error: "Question " + (i + 1) + " is empty. Write it, or delete it." };
      let id = tid(q.id);
      while (seen.has(id)) id = randomBytes(4).toString("hex");
      seen.add(id);
      out.questions.push({ id, en, ar, required: q.required === true, hidden: q.hidden === true });
    }
    if (!out.questions.some((q) => !q.hidden)) return { error: "Keep at least one question visible." };
  }
  const isoOrEmpty = (v) => typeof v === "string" && v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : "";
  if (b.packages === null || b.packages === void 0) out.packages = null;
  else {
    if (!Array.isArray(b.packages) || b.packages.length > PKG_MAX) return { error: "You can have up to " + PKG_MAX + " packages." };
    out.packages = [];
    const seenP = /* @__PURE__ */ new Set();
    for (const [n, x] of b.packages.entries()) {
      let id = typeof x?.id === "string" && (PKG_IDS.includes(x.id) || /^p[0-9a-f]{6}$/.test(x.id)) ? x.id : "p" + randomBytes(3).toString("hex");
      while (seenP.has(id)) id = "p" + randomBytes(3).toString("hex");
      seenP.add(id);
      const price = Math.round(Number(x?.price));
      const label = str(x?.name, 80) || "package " + (n + 1);
      if (!Number.isFinite(price) || price < 1 || price > 1e5) return { error: "The price of \u201C" + label + "\u201D must be a whole number between 1 and 100000." };
      const name = str(x?.name, 80), name_ar = str(x?.name_ar, 80);
      if (!name || !name_ar) return { error: "Write the name of \u201C" + label + "\u201D in both English and Arabic." };
      let sale_price = null;
      if (x?.sale_price !== null && x?.sale_price !== void 0 && x?.sale_price !== "") {
        sale_price = Math.round(Number(x.sale_price));
        if (!Number.isFinite(sale_price) || sale_price < 1 || sale_price >= price) return { error: "The offer price of \u201C" + label + "\u201D must be a whole number lower than its normal price." };
      }
      const features = (Array.isArray(x?.features) ? x.features : []).slice(0, 8).map((f) => ({ en: str(f?.en, 90), ar: str(f?.ar, 90) })).filter((f) => f.en || f.ar);
      out.packages.push({
        id,
        price,
        name,
        name_ar,
        desc: str(x?.desc, 300),
        desc_ar: str(x?.desc_ar, 300),
        hidden: x?.hidden === true,
        features,
        badge: str(x?.badge, 24),
        badge_ar: str(x?.badge_ar, 24),
        featured: x?.featured === true,
        consult: x?.consult === void 0 ? id === "consultation" : x.consult === true,
        sale_price,
        sale_ends: sale_price ? isoOrEmpty(x?.sale_ends) : "",
        image: imgOf(x?.image)
      });
    }
    for (const id of PKG_IDS) if (!out.packages.some((x) => x.id === id)) return { error: "The two original packages cannot be removed. Hide them instead." };
    if (out.packages.every((x) => x.hidden)) return { error: "Keep at least one package visible." };
    let seenF = false;
    for (const x of out.packages) {
      if (x.featured && (seenF || x.hidden)) x.featured = false;
      if (x.featured) seenF = true;
    }
  }
  const bp = b.promo && typeof b.promo === "object" ? b.promo : {};
  const bn = bp.banner && typeof bp.banner === "object" ? bp.banner : {};
  const pids = new Set((out.packages || defaultPkgs()).map((x) => x.id));
  const codes = [];
  const seenC = /* @__PURE__ */ new Set();
  if (Array.isArray(bp.codes)) {
    if (bp.codes.length > 40) return { error: "You can have up to 40 promo codes." };
    for (const c of bp.codes) {
      const code = normCode(c?.code);
      if (code.length < 3) return { error: "Every promo code needs at least 3 letters or numbers." };
      if (seenC.has(code)) return { error: "The promo code " + code + " is listed twice." };
      seenC.add(code);
      const type = c?.type === "fixed" ? "fixed" : c?.type === "free" ? "free" : "percent";
      const value = type === "free" ? 100 : Math.round(Number(c?.value));
      if (!Number.isFinite(value) || value < 1 || (type === "percent" ? value > 90 : value > 1e5)) return { error: "The discount of " + code + " must be " + (type === "percent" ? "between 1% and 90%." : "a whole number of riyals.") };
      codes.push({
        code,
        type,
        value,
        active: c?.active !== false,
        combine: c?.combine !== false,
        packages: (Array.isArray(c?.packages) ? c.packages : []).filter((id) => pids.has(id)),
        starts_at: isoOrEmpty(c?.starts_at),
        ends_at: isoOrEmpty(c?.ends_at),
        max_uses: Math.max(0, Math.min(1e5, Math.round(Number(c?.max_uses)) || 0)),
        note: str(c?.note, 100),
        image: imgOf(c?.image),
        once_per_person: c?.once_per_person === void 0 ? type === "free" : c.once_per_person === true,
        campaign: str(c?.campaign, 40)
      });
    }
  }
  out.promo = {
    banner: { on: bn.on === true, en: str(bn.en, 160), ar: str(bn.ar, 160), ends_at: isoOrEmpty(bn.ends_at), image: imgOf(bn.image) },
    note_en: str(bp.note_en, 200),
    note_ar: str(bp.note_ar, 200),
    codes
  };
  if (out.promo.banner.on && !out.promo.banner.en && !out.promo.banner.ar) return { error: "Write the announcement text, or switch the announcement bar off." };
  out.review_name = ["choose", "first", "full", "anon"].includes(b.review_name) ? b.review_name : "choose";
  if (b.review_questions === null || b.review_questions === void 0) out.review_questions = null;
  else {
    if (!Array.isArray(b.review_questions) || b.review_questions.length > 20) return { error: "You can have up to 20 review questions." };
    const seen = /* @__PURE__ */ new Set();
    out.review_questions = [];
    for (const [i, q] of b.review_questions.entries()) {
      const en = str(q?.en, 300), ar = str(q?.ar, 300);
      if (!en && !ar) return { error: "Review question " + (i + 1) + " is empty. Write it, or delete it." };
      let id = tid(q.id);
      while (seen.has(id)) id = randomBytes(4).toString("hex");
      seen.add(id);
      out.review_questions.push({ id, en, ar, type: RQ_TYPES.includes(q.type) ? q.type : "text", required: q.required === true, hidden: q.hidden === true });
    }
    if (!out.review_questions.some((q) => !q.hidden)) return { error: "Keep at least one review question visible." };
  }
  if (b.info === null || b.info === void 0) out.info = null;
  else {
    const i = b.info, v = (k) => str(i?.[k], 80);
    out.info = { duration_en: v("duration_en"), duration_ar: v("duration_ar"), delivery_en: v("delivery_en"), delivery_ar: v("delivery_ar") };
  }
  for (const k of TEMPLATE_KEYS) {
    const en = str(b.templates?.[k]?.en, 1e3), ar = str(b.templates?.[k]?.ar, 1e3);
    if (en || ar) out.templates[k] = { en, ar };
  }
  out.updated_at = now();
  if (JSON.stringify(out).length > MAX_SETTINGS) return { error: "Settings are too large. Remove a QR code or use smaller pictures." };
  return { settings: out };
}
var RQ_TYPES = ["stars", "scale", "text"];
var DEFAULT_RQ = [
  { id: "overall", type: "stars", required: true, en: "How was your overall experience with Basirah?", ar: "\u0643\u064A\u0641 \u0643\u0627\u0646\u062A \u062A\u062C\u0631\u0628\u062A\u0643 \u0627\u0644\u0639\u0627\u0645\u0629 \u0645\u0639 \u0628\u0635\u064A\u0631\u0629\u061F" },
  { id: "accuracy", type: "stars", required: true, en: "How well did your personality profile describe you?", ar: "\u0625\u0644\u0649 \u0623\u064A \u0645\u062F\u0649 \u0648\u0635\u0641 \u0645\u0644\u0641\u0643 \u0627\u0644\u0634\u062E\u0635\u064A \u062D\u0642\u064A\u0642\u062A\u0643\u061F" },
  { id: "recommend", type: "scale", required: true, en: "How likely are you to recommend Basirah to a friend or colleague? (0 = not likely, 10 = very likely)", ar: "\u0645\u0627 \u0645\u062F\u0649 \u0627\u062D\u062A\u0645\u0627\u0644 \u0623\u0646 \u062A\u0648\u0635\u064A \u0628\u0628\u0635\u064A\u0631\u0629 \u0644\u0635\u062F\u064A\u0642 \u0623\u0648 \u0632\u0645\u064A\u0644\u061F (0 = \u063A\u064A\u0631 \u0645\u062D\u062A\u0645\u0644\u060C 10 = \u0645\u062D\u062A\u0645\u0644 \u062C\u062F\u0627\u064B)" },
  { id: "valued", type: "text", required: false, en: "What did you value most?", ar: "\u0645\u0627 \u0623\u0643\u062B\u0631 \u0645\u0627 \u0623\u0639\u062C\u0628\u0643\u061F" },
  { id: "improve", type: "text", required: false, en: "What could we do better?", ar: "\u0645\u0627 \u0627\u0644\u0630\u064A \u064A\u0645\u0643\u0646\u0646\u0627 \u062A\u062D\u0633\u064A\u0646\u0647\u061F" }
];
var publicSettings = (s) => {
  const { templates, updated_at, questions, review_questions, review_name, promo, ...rest } = upGreet(s) || emptySettings();
  const bn = promo?.banner, t = Date.now();
  const live = bn && bn.on && (bn.en || bn.ar) && !(bn.ends_at && Date.parse(bn.ends_at) <= t);
  return {
    ...rest,
    packages: rest.packages || null,
    info: rest.info || null,
    now: new Date(t).toISOString(),
    promo: promo ? { banner: live ? { en: bn.en, ar: bn.ar, ends_at: bn.ends_at, image: bn.image || "" } : null, note_en: promo.note_en, note_ar: promo.note_ar, has_codes: promo.codes.some((c) => c.active && !(c.ends_at && Date.parse(c.ends_at) <= t)) } : null,
    questions: Array.isArray(questions) ? questions.filter((q) => !q.hidden).map(({ id, en, ar, required }) => ({ id, en, ar, required })) : null
  };
};
async function handleAdminSettings(req, store) {
  const cur = upGreet(await store.get("settings")) || emptySettings();
  if (req.method === "GET") {
    const uses = {};
    for (const c of cur.promo?.codes || []) uses[c.code] = await promoUsed(store, c.code);
    return json({ settings: cur, promo_uses: uses });
  }
  if (req.method !== "PUT") return fail(405, "Method not allowed");
  const raw = await req.text();
  if (raw.length > MAX_SETTINGS + 2e4) return fail(413, "Settings are too large. Remove a QR code or use smaller pictures.");
  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    return fail(400, "Invalid JSON");
  }
  if (cur.updated_at && b.updated_at !== cur.updated_at) return fail(409, "Settings were changed in another window. They have been reloaded.", { settings: cur });
  const r = cleanSettings(b, cur);
  if (r.error) return fail(400, r.error);
  await store.set("settings", r.settings);
  return json({ settings: r.settings });
}
async function handleSettings(req, store) {
  if (req.method !== "GET") return fail(405, "Method not allowed");
  const tm = await store.get("testimonials");
  const res = json({ ...publicSettings(await store.get("settings")), testimonials: Array.isArray(tm?.list) ? tm.list : [] });
  res.headers.set("cache-control", "public, max-age=30");
  return res;
}
var MAX_PDF = 4e6;
var pdfLink = (m) => ({ token: m.token, path: "/r/" + m.token, size: m.size, at: m.at, opens: m.opens || 0, opened_at: m.opened_at || null, downloaded_at: m.downloaded_at || null });
async function dropPdf(store, id) {
  const m = await store.get("pdfmeta/" + id);
  if (m) {
    await store.delete("pdf/" + m.token);
    await store.delete("pdftok/" + m.token);
    await store.delete("pdfmeta/" + id);
  }
  return !!m;
}
async function handlePdf(req, store, rec) {
  const id = rec.id, t = now();
  if (req.method === "PUT") {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > MAX_PDF) return fail(413, "The PDF is too large to share by link (limit 4 MB).");
    if (buf.length < 100 || buf.subarray(0, 4).toString() !== "%PDF") return fail(400, "That is not a PDF file");
    const old = await store.get("pdfmeta/" + id);
    let token = old?.token;
    if (!token) do {
      token = randomBytes(8).toString("base64url");
    } while (await store.get("pdftok/" + token));
    const meta = { token, size: buf.length, at: t, sid: id, name: str((rec.full_name || "").split(/\s+/)[0], 40), lang: rec.language === "ar" ? "ar" : "en", opens: old?.opens || 0, opened_at: old?.opened_at || null, downloaded_at: old?.downloaded_at || null };
    await store.setBin("pdf/" + token, buf);
    await store.set("pdftok/" + token, { sid: id });
    await store.set("pdfmeta/" + id, meta);
    const next = { ...rec, history: [...rec.history, { at: t, by: "admin", action: old ? "Report PDF updated (same private link)" : "Report PDF published with a private link" }], updated_at: t };
    await store.set(keyOf(id), next);
    return json({ pdf_link: pdfLink(meta), submission: next });
  }
  if (req.method === "GET") {
    const m = await store.get("pdfmeta/" + id), buf = m && await store.getBin("pdf/" + m.token);
    if (!buf) return fail(404, "No PDF has been published for this client yet");
    return new Response(buf, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Basirah-Report.pdf"', "cache-control": "no-store" } });
  }
  if (req.method === "DELETE") {
    const had = await dropPdf(store, id);
    if (!had) return json({ pdf_link: null, submission: rec });
    const next = { ...rec, history: [...rec.history, { at: t, by: "admin", action: "Private report link switched off" }], updated_at: t };
    await store.set(keyOf(id), next);
    return json({ pdf_link: null, submission: next });
  }
  return fail(405, "Method not allowed");
}
var BOT = /whatsapp|facebookexternalhit|bot\b|crawler|spider|preview|slack|telegram|twitterbot|linkedin|skype/i;
var H = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function reportPage(meta, settings, token, origin = "") {
  const lines = settings?.whatsapp || [], name = meta.name || "";
  const kb = meta.size > 1048576 ? (meta.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(meta.size / 1024)) + " KB";
  const sid = meta.sid || "";
  const msgEn = "Hello, I have received my Basirah report (" + sid + ") and would like to talk about it.";
  const msgAr = "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064A\u0643\u0645\u060C \u0627\u0633\u062A\u0644\u0645\u062A \u062A\u0642\u0631\u064A\u0631 \u0628\u0635\u064A\u0631\u0629 \u0627\u0644\u062E\u0627\u0635 \u0628\u064A (" + sid + ") \u0648\u0623\u0631\u063A\u0628 \u0641\u064A \u0645\u0646\u0627\u0642\u0634\u062A\u0647.";
  const wa = (l) => "https://wa.me/" + l.number + "?text=";
  const both = (en, ar) => `<span data-l="en">${en}</span><span data-l="ar">${ar}</span>`;
  const waBtns = lines.map((l) => `<a class="b o" target="_blank" rel="noopener" data-l="en" href="${H(wa(l) + encodeURIComponent(msgEn))}">${H(lines.length > 1 ? "WhatsApp \xB7 " + l.label : "Message us on WhatsApp")}</a><a class="b o" target="_blank" rel="noopener" data-l="ar" href="${H(wa(l) + encodeURIComponent(msgAr))}">${H(lines.length > 1 ? "\u0648\u0627\u062A\u0633\u0627\u0628 \xB7 " + (l.label_ar || l.label) : "\u0631\u0627\u0633\u0644\u0646\u0627 \u0639\u0628\u0631 \u0648\u0627\u062A\u0633\u0627\u0628")}</a>`).join("");
  return `<!doctype html><html lang="${meta.lang === "ar" ? "ar" : "en"}" dir="${meta.lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Basirah \xB7 ${meta.lang === "ar" ? "\u062A\u0642\u0631\u064A\u0631\u0643" : "Your report"}</title>
<meta property="og:image" content="${H(origin)}/og-doc.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:type" content="website"><meta property="og:title" content="${meta.lang === "ar" ? "\u062A\u0642\u0631\u064A\u0631\u0643 \u0645\u0646 \u0628\u0635\u064A\u0631\u0629 \u062C\u0627\u0647\u0632" : "Your Basirah report is ready"}"><meta property="og:description" content="${meta.lang === "ar" ? "\u0627\u0636\u063A\u0637 \u0644\u0641\u062A\u062D \u062A\u0642\u0631\u064A\u0631\u0643 \u0648\u062A\u062D\u0645\u064A\u0644\u0647 \u0628\u0635\u064A\u063A\u0629 PDF." : "Tap to open and download your report as a PDF."}">
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
<div class="top"><span class="brand">Basirah</span><span class="lg" role="group" aria-label="Language"><button type="button" data-set="en" aria-pressed="${meta.lang !== "ar"}">English</button> <button type="button" data-set="ar" aria-pressed="${meta.lang === "ar"}">\u0627\u0644\u0639\u0631\u0628\u064A\u0629</button></span></div>
<div class="card"><div class="ok" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M8 14h8M8 18h5"/></svg></div>
<h1>${both("Your report is ready", "\u062A\u0642\u0631\u064A\u0631\u0643 \u062C\u0627\u0647\u0632")}</h1>
<p class="who">${name ? both("Prepared for " + H(name), "\u0623\u064F\u0639\u062F\u0651 \u062E\u0635\u064A\u0635\u0627\u064B \u0644\u0640 " + H(name)) : both("Prepared just for you", "\u0623\u064F\u0639\u062F\u0651 \u062E\u0635\u064A\u0635\u0627\u064B \u0644\u0643")}</p>
<a class="b" href="/r/${H(token)}/download" data-l="en">Download PDF</a><a class="b" href="/r/${H(token)}/download" data-l="ar">\u062A\u062D\u0645\u064A\u0644 PDF</a>
<a class="b o" href="/r/${H(token)}/view" target="_blank" rel="noopener" data-l="en">Open in your browser</a><a class="b o" href="/r/${H(token)}/view" target="_blank" rel="noopener" data-l="ar">\u0641\u062A\u062D \u0641\u064A \u0627\u0644\u0645\u062A\u0635\u0641\u062D</a>
<p class="meta">PDF \xB7 ${H(kb)}</p>
${lines.length ? `<div class="q"><p>${both("Questions about your report, or would you like to book your consultation?", "\u0644\u062F\u064A\u0643 \u0633\u0624\u0627\u0644 \u0639\u0646 \u062A\u0642\u0631\u064A\u0631\u0643\u060C \u0623\u0648 \u062A\u0631\u063A\u0628 \u0641\u064A \u062D\u062C\u0632 \u0627\u0633\u062A\u0634\u0627\u0631\u062A\u0643\u061F")}</p>${waBtns}</div>` : ""}
</div><footer>${both("Basirah by Ehsankey \xB7 Self-reflection, not diagnosis.", "\u0628\u0635\u064A\u0631\u0629 \u0645\u0646 \u0625\u062D\u0633\u0627\u0646 \xB7 \u062A\u0623\u0645\u0651\u0644 \u0630\u0627\u062A\u064A\u060C \u0648\u0644\u064A\u0633 \u062A\u0634\u062E\u064A\u0635\u0627\u064B.")}</footer></main>
<script>document.querySelectorAll('[data-set]').forEach(function(b){b.onclick=function(){var l=b.dataset.set,h=document.documentElement;h.lang=l;h.dir=l==='ar'?'rtl':'ltr';document.querySelectorAll('[data-set]').forEach(function(x){x.setAttribute('aria-pressed',x===b)})}})</script>
</body></html>`;
}
async function handleReport(req, store) {
  if (!["GET", "HEAD"].includes(req.method)) return fail(405, "Method not allowed");
  const segs = new URL(req.url).pathname.split("/").filter(Boolean);
  const token = segs[1] || "", action = segs[2] || "";
  const nf = () => new Response("This link is not available.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token) || segs.length > 3 || !["", "download", "view"].includes(action)) return nf();
  const ptr = await store.get("pdftok/" + token);
  const meta = ptr && await store.get("pdfmeta/" + ptr.sid);
  if (!meta || meta.token !== token) return nf();
  const human = req.method === "GET" && !BOT.test(req.headers.get("user-agent") || "");
  const touch = async (field) => {
    if (!human) return;
    const m = { ...meta }, t = now();
    if (field === "open") {
      m.opens = (m.opens || 0) + 1;
      m.opened_at = m.opened_at || t;
    } else {
      m.downloaded_at = m.downloaded_at || t;
      m.opened_at = m.opened_at || t;
    }
    await store.set("pdfmeta/" + ptr.sid, m);
  };
  const base = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
  if (!action) {
    await touch("open");
    const html = reportPage(meta, await store.get("settings"), token, new URL(req.url).origin);
    return new Response(req.method === "HEAD" ? null : html, { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
  }
  const buf = await store.getBin("pdf/" + token);
  if (!buf) return nf();
  if (action === "download") await touch("download");
  return new Response(req.method === "HEAD" ? null : buf, { status: 200, headers: { ...base, "content-type": "application/pdf", "content-disposition": (action === "download" ? "attachment" : "inline") + '; filename="Basirah-Report.pdf"', "content-length": String(buf.length) } });
}
var FILE_TYPES = /^(audio\/[a-z0-9.+-]+|video\/webm|image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;
var MAX_FILE = 5 * 1024 * 1024;
var EXT = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
async function handleUpload(req, store) {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!FILE_TYPES.test(type)) return fail(415, "This kind of file is not accepted");
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return fail(400, "The file is empty");
  if (buf.length > MAX_FILE) return fail(413, "The file is too large (limit 5 MB)");
  let id;
  do {
    id = randomBytes(12).toString("base64url");
  } while (await store.get("uplmeta/" + id));
  await store.setBin("upl/" + id, buf);
  await store.set("uplmeta/" + id, { type, size: buf.length, at: (/* @__PURE__ */ new Date()).toISOString(), hash: createHash("sha256").update(buf).digest("hex").slice(0, 32) });
  const origin = new URL(req.url).origin;
  return json({ url: origin + "/api/file/" + id + (EXT[type] ? "." + EXT[type] : "") });
}
async function handleFile(req, store) {
  const nf = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!["GET", "HEAD"].includes(req.method)) return fail(405, "Method not allowed");
  const m = /^\/api\/file\/([A-Za-z0-9_-]{10,40})(?:\.[a-z0-9]{2,4})?$/.exec(new URL(req.url).pathname);
  if (!m) return nf();
  const meta = await store.get("uplmeta/" + m[1]);
  const buf = meta && await store.getBin("upl/" + m[1]);
  if (!buf) return nf();
  const h = { "content-type": meta.type, "accept-ranges": "bytes", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "x-robots-tag": "noindex", "content-security-policy": "default-src 'none'; sandbox" };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  if (rg && (rg[1] || rg[2])) {
    let a = rg[1] === "" ? Math.max(0, buf.length - +rg[2]) : +rg[1], b = rg[1] === "" || rg[2] === "" ? buf.length - 1 : Math.min(+rg[2], buf.length - 1);
    if (a > b || a >= buf.length) return new Response(null, { status: 416, headers: { ...h, "content-range": "bytes */" + buf.length } });
    return new Response(req.method === "HEAD" ? null : buf.subarray(a, b + 1), { status: 206, headers: { ...h, "content-range": `bytes ${a}-${b}/${buf.length}`, "content-length": String(b - a + 1) } });
  }
  return new Response(req.method === "HEAD" ? null : buf, { status: 200, headers: { ...h, "content-length": String(buf.length) } });
}
async function dropFiles(store, rec) {
  const ids = new Set([...JSON.stringify(rec || {}).matchAll(/\/api\/file\/([A-Za-z0-9_-]{10,40})/g)].map((x) => x[1]));
  for (const id of ids) {
    await store.delete("upl/" + id);
    await store.delete("uplmeta/" + id);
  }
}
var stripHidden = (l) => (Array.isArray(l) && l.length ? l : DEFAULT_RQ).filter((q) => !q.hidden);
async function dropReview(store, id) {
  const m = await store.get("rvmeta/" + id);
  if (m) {
    await store.delete("rvtok/" + m.token);
    await store.delete("rvmeta/" + id);
  }
  const had = await store.get("review/" + id);
  if (had) {
    await store.delete("review/" + id);
    await rebuildTestimonials(store);
  }
}
async function rebuildTestimonials(store) {
  const recs = await valuesOf(store, "review/");
  const list = recs.filter((r) => r.featured && r.share).sort((a, b) => (a.featured_at || "").localeCompare(b.featured_at || "")).map((r) => ({ id: r.sid, quote: r.quote, quote_ar: r.quote_ar || "", name: r.display_name, stars: r.stars || 0 }));
  await store.set("testimonials", { list });
}
var firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";
async function handleAdminReviews(req, store, sid) {
  const m = req.method;
  if (!sid && m === "GET") {
    const recs = await valuesOf(store, "review/");
    recs.sort((a, b2) => b2.created_at.localeCompare(a.created_at));
    const sent = (await store.list("rvmeta/")).length;
    return json({ reviews: recs, requested: sent });
  }
  const rv = sid && await store.get("review/" + sid);
  if (!rv) return fail(404, "Review not found");
  if (m === "DELETE") {
    await store.delete("review/" + sid);
    await rebuildTestimonials(store);
    return json({ ok: true });
  }
  if (m !== "PUT") return fail(405, "Method not allowed");
  let b;
  try {
    b = await req.json();
  } catch {
    return fail(400, "Invalid JSON");
  }
  const next = { ...rv };
  if (b.quote !== void 0) next.quote = str(b.quote, 600);
  if (b.quote_ar !== void 0) next.quote_ar = str(b.quote_ar, 600);
  if (b.display_name !== void 0) next.display_name = str(b.display_name, 60);
  if (b.stars !== void 0) next.stars = Math.max(0, Math.min(5, Math.round(Number(b.stars) || 0)));
  if (b.featured !== void 0) {
    if (b.featured === true) {
      if (!rv.share) return fail(409, "This client did not agree to have their words shown on the website.");
      if (!(next.quote || next.quote_ar)) return fail(400, "Choose or write the words to show first.");
      if (!next.display_name) return fail(400, "Write the name to show, for example \u201CSara\u201D.");
      next.featured = true;
      next.featured_at = rv.featured_at || now();
    } else {
      next.featured = false;
    }
  } else if (next.featured && !(next.quote || next.quote_ar)) return fail(400, "A shown review needs words. Remove it from the website first.");
  next.updated_at = now();
  await store.set("review/" + sid, next);
  await rebuildTestimonials(store);
  return json({ review: next });
}
var OGTAGS = (origin, title, desc, img, pageUrl = "") => {
  const src = origin + (img || "/og.png"), stock = !img || /^\/og-/.test(img);
  return `<meta name="description" content="${H(desc)}"><meta property="og:site_name" content="Basirah \xB7 \u0628\u0635\u064A\u0631\u0629"><meta property="og:type" content="website">${pageUrl ? `<meta property="og:url" content="${H(pageUrl)}">` : ""}<meta property="og:title" content="${H(title)}"><meta property="og:description" content="${H(desc)}"><meta property="og:image" content="${H(src)}"><meta property="og:image:secure_url" content="${H(src)}">${stock ? '<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' : ""}<meta property="og:image:alt" content="${H(title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${H(title)}"><meta name="twitter:description" content="${H(desc)}"><meta name="twitter:image" content="${H(src)}">`;
};
var IMG_RE = /^\/api\/img\/[A-Za-z0-9_-]{10,40}\.(jpg|png|webp)$/;
var imgOf = (v) => typeof v === "string" && IMG_RE.test(v) ? v : "";
var IMG_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
var sniffImg = (b) => b[0] === 255 && b[1] === 216 ? "image/jpeg" : b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "";
async function handleAdminImage(req, store) {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return fail(400, "The picture is empty");
  if (buf.length > 15e5) return fail(413, "The picture is too large. Choose a smaller one.");
  const type = sniffImg(buf);
  if (!type) return fail(415, "Please use a JPG, PNG or WebP picture.");
  const id = randomBytes(12).toString("base64url");
  await store.setBin("img/" + id, buf);
  await store.set("imgmeta/" + id, { type, size: buf.length, at: now() });
  return json({ path: "/api/img/" + id + "." + IMG_EXT[type] });
}
async function handleImage(req, store) {
  const nf = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!["GET", "HEAD"].includes(req.method)) return fail(405, "Method not allowed");
  const m = /^\/api\/img\/([A-Za-z0-9_-]{10,40})\.(jpg|png|webp)$/.exec(new URL(req.url).pathname);
  if (!m) return nf();
  const meta = await store.get("imgmeta/" + m[1]);
  const buf = meta && await store.getBin("img/" + m[1]);
  if (!buf) return nf();
  return new Response(req.method === "HEAD" ? null : buf, { status: 200, headers: { "content-type": meta.type, "content-length": String(buf.length), "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
}
var MSG_CARDS = {
  hello: { img: "/og-chat.png", en: ["Basirah \xB7 Begin your journey of self-insight", "A gentle, guided reflection on how you think, decide and grow. About 15 to 20 minutes, at your own pace."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0627\u0628\u062F\u0623 \u0631\u062D\u0644\u062A\u0643 \u0646\u062D\u0648 \u0645\u0639\u0631\u0641\u0629 \u0646\u0641\u0633\u0643", "\u062A\u0623\u0645\u0651\u0644 \u0647\u0627\u062F\u0626 \u0648\u0645\u0648\u062C\u064E\u0651\u0647 \u0641\u064A \u0637\u0631\u064A\u0642\u0629 \u062A\u0641\u0643\u064A\u0631\u0643 \u0648\u0642\u0631\u0627\u0631\u0627\u062A\u0643 \u0648\u0646\u0645\u0648\u0651\u0643. \u0646\u062D\u0648 \u0661\u0665 \u0625\u0644\u0649 \u0662\u0660 \u062F\u0642\u064A\u0642\u0629 \u0648\u0628\u0627\u0644\u0633\u0631\u0639\u0629 \u0627\u0644\u062A\u064A \u062A\u0646\u0627\u0633\u0628\u0643."] },
  help: { img: "/og-card.png", en: ["Basirah \xB7 We are here to help with your payment", "Reply on WhatsApp and we will guide you to the next step."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0646\u062D\u0646 \u0647\u0646\u0627 \u0644\u0645\u0633\u0627\u0639\u062F\u062A\u0643 \u0641\u064A \u0627\u0644\u062F\u0641\u0639", "\u0631\u0627\u0633\u0644\u0646\u0627 \u0639\u0628\u0631 \u0648\u0627\u062A\u0633\u0627\u0628 \u0648\u0633\u0646\u0631\u0634\u062F\u0643 \u0625\u0644\u0649 \u0627\u0644\u062E\u0637\u0648\u0629 \u0627\u0644\u062A\u0627\u0644\u064A\u0629."] },
  done: { img: "/og-check.png", en: ["Basirah \xB7 Your assessment is in", "We are confirming your payment. Your personal insight reaches you within 24 hours."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0648\u0635\u0644\u0646\u0627 \u062A\u0642\u064A\u064A\u0645\u0643", "\u0646\u0624\u0643\u062F \u0627\u0644\u062F\u0641\u0639 \u0627\u0644\u0622\u0646\u060C \u0648\u062A\u0635\u0644\u0643 \u0628\u0635\u064A\u0631\u062A\u0643 \u0627\u0644\u062E\u0627\u0635\u0629 \u062E\u0644\u0627\u0644 \u0662\u0664 \u0633\u0627\u0639\u0629."] },
  consult: { img: "/og-cal.png", en: ["Basirah \xB7 Book your 1-to-1 consultation", "Where insight becomes a plan. Choose a time that suits you."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0627\u062D\u062C\u0632 \u0627\u0633\u062A\u0634\u0627\u0631\u062A\u0643 \u0627\u0644\u0641\u0631\u062F\u064A\u0629", "\u062D\u064A\u062B \u062A\u062A\u062D\u0648\u0644 \u0627\u0644\u0628\u0635\u064A\u0631\u0629 \u0625\u0644\u0649 \u062E\u0637\u0629. \u0627\u062E\u062A\u0631 \u0627\u0644\u0648\u0642\u062A \u0627\u0644\u0630\u064A \u064A\u0646\u0627\u0633\u0628\u0643."] },
  received_free: { img: "/og-gift.png", en: ["Basirah \xB7 Your journey has begun", "Your free access is confirmed. Your personal insight is being prepared with care."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0628\u062F\u0623\u062A \u0631\u062D\u0644\u062A\u0643", "\u062A\u0645 \u062A\u0623\u0643\u064A\u062F \u0648\u0635\u0648\u0644\u0643 \u0627\u0644\u0645\u062C\u0627\u0646\u064A\u060C \u0648\u0646\u064F\u0639\u062F\u0651 \u0628\u0635\u064A\u0631\u062A\u0643 \u0627\u0644\u062E\u0627\u0635\u0629 \u0628\u0639\u0646\u0627\u064A\u0629."] },
  received: { img: "/og-check.png", en: ["Basirah \xB7 Your journey has begun", "We have received your assessment. Your personal insight is prepared with care."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0628\u062F\u0623\u062A \u0631\u062D\u0644\u062A\u0643", "\u0648\u0635\u0644\u0646\u0627 \u062A\u0642\u064A\u064A\u0645\u0643\u060C \u0648\u0646\u064F\u0639\u062F\u0651 \u0628\u0635\u064A\u0631\u062A\u0643 \u0627\u0644\u062E\u0627\u0635\u0629 \u0628\u0639\u0646\u0627\u064A\u0629."] },
  payment_issue: { img: "/og-card.png", en: ["Basirah \xB7 One small step to go", "We could not yet match your payment. A clear receipt photo will set everything in motion."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u062E\u0637\u0648\u0629 \u0635\u063A\u064A\u0631\u0629 \u0645\u062A\u0628\u0642\u064A\u0629", "\u0644\u0645 \u0646\u062A\u0645\u0643\u0646 \u0628\u0639\u062F \u0645\u0646 \u0645\u0637\u0627\u0628\u0642\u0629 \u0627\u0644\u062F\u0641\u0639. \u0635\u0648\u0631\u0629 \u0648\u0627\u0636\u062D\u0629 \u0644\u0644\u0625\u064A\u0635\u0627\u0644 \u062A\u064F\u0633\u0631\u0651\u0639 \u0643\u0644 \u0634\u064A\u0621."] },
  delay: { img: "/og-clock.png", en: ["Basirah \xB7 Your insight is on its way", "Thank you for your patience. We are giving your report the care it deserves."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0628\u0635\u064A\u0631\u062A\u0643 \u0641\u064A \u0627\u0644\u0637\u0631\u064A\u0642 \u0625\u0644\u064A\u0643", "\u0634\u0643\u0631\u0627\u064B \u0644\u0635\u0628\u0631\u0643. \u0646\u0645\u0646\u062D \u062A\u0642\u0631\u064A\u0631\u0643 \u0627\u0644\u0639\u0646\u0627\u064A\u0629 \u0627\u0644\u062A\u064A \u064A\u0633\u062A\u062D\u0642\u0647\u0627."] },
  report_file: { img: "/og-doc.png", en: ["Basirah \xB7 Your insight is ready", "Your personal report, prepared with care."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u0628\u0635\u064A\u0631\u062A\u0643 \u062C\u0627\u0647\u0632\u0629", "\u062A\u0642\u0631\u064A\u0631\u0643 \u0627\u0644\u062E\u0627\u0635\u060C \u0623\u064F\u0639\u062F\u0651 \u0644\u0643 \u0628\u0639\u0646\u0627\u064A\u0629."] },
  consult_confirm: { img: "/og-cal.png", en: ["Basirah \xB7 Your consultation is confirmed", "Come as you are, with the questions on your mind."], ar: ["\u0628\u0635\u064A\u0631\u0629 \xB7 \u062A\u0645 \u062A\u0623\u0643\u064A\u062F \u0627\u0633\u062A\u0634\u0627\u0631\u062A\u0643", "\u062A\u0639\u0627\u0644 \u0643\u0645\u0627 \u0623\u0646\u062A \u0648\u0645\u0639\u0643 \u0623\u0633\u0626\u0644\u062A\u0643."] }
};
async function handleShare(req, store) {
  const u = new URL(req.url), origin = u.origin;
  const clean = (v) => String(v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  const code = clean(u.searchParams.get("code")), pkg = clean(u.searchParams.get("pkg"));
  const qs = new URLSearchParams();
  if (code) qs.set("code", code);
  if (pkg) qs.set("pkg", pkg);
  const ann = u.searchParams.get("ann") === "1";
  const dest = ann ? "/#pkgs" : qs.toString() ? "/?" + qs.toString() : "/";
  let title = "Basirah \xB7 \u0628\u0635\u064A\u0631\u0629", desc = "A guided personality insight assessment. Know yourself with clarity.", image = "", stock = "";
  const mk = MSG_CARDS[clean(u.searchParams.get("m"))];
  if (mk) {
    const ar = u.searchParams.get("l") === "ar";
    [title, desc] = ar ? mk.ar : mk.en;
    stock = mk.img;
  }
  try {
    const set = store ? await store.get("settings") : null;
    const c = code && Array.isArray(set?.promo?.codes) ? set.promo.codes.find((x) => x.code === code.toUpperCase()) : null;
    const p = pkg && Array.isArray(set?.packages) ? set.packages.find((x) => x.id === pkg) : null;
    const bn = set?.promo?.banner;
    if (ann && bn && (bn.en || bn.ar)) {
      title = "\u{1F4E3} " + (bn.en || bn.ar).slice(0, 80);
      desc = "Basirah \xB7 \u0628\u0635\u064A\u0631\u0629. Tap to see the packages.";
      image = bn.image || "";
    } else if (c) {
      title = "\u{1F381} A gift from Basirah";
      desc = c.type === "free" ? "Your assessment is a gift, free of charge. Your code is applied automatically." : "A gift is waiting for you. Your promo code is applied automatically.";
      image = c.image || "";
      if (!image && c.type === "free") stock = "/og-gift.png";
    }
    if (!image && p) {
      title = p.name + " \xB7 Basirah";
      desc = (saleOn(p) ? "Now SAR " + p.sale_price + " instead of SAR " + p.price + ". " : "SAR " + p.price + ". ") + (p.desc || "");
      image = p.image || "";
    } else if (p && !c) {
      title = p.name + " \xB7 Basirah";
    }
  } catch {
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${H(title)}</title>${OGTAGS(origin, title, desc.slice(0, 200), imgOf(image) || stock, u.href)}</head><body><a href="${H(dest)}">Basirah</a><script>location.replace(${JSON.stringify(dest).replace(/</g, "\\u003c")})</script></body></html>`;
  return new Response(req.method === "HEAD" ? null : html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" } });
}
async function handleReview(req, store) {
  const segs = new URL(req.url).pathname.split("/").filter(Boolean);
  const token = segs[1] || "";
  const origin = new URL(req.url).origin;
  const hdr = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
  const nf = () => new Response("This link is not available.", { status: 404, headers: { ...hdr, "content-type": "text/plain; charset=utf-8" } });
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token) || segs.length !== 2) return nf();
  const ptr = await store.get("rvtok/" + token);
  const rec = ptr && await store.get(keyOf(ptr.sid));
  if (!rec) return nf();
  const settings = await store.get("settings");
  const qs = stripHidden(settings?.review_questions);
  const done = await store.get("review/" + rec.id);
  if (req.method === "POST") {
    if (done) return fail(409, "Your review was already sent. Thank you!");
    let b;
    try {
      b = await req.json();
    } catch {
      return fail(400, "Invalid JSON");
    }
    const ans = [];
    for (const q of qs) {
      const raw = b.answers?.[q.id];
      let v;
      if (q.type === "stars") {
        v = Math.round(Number(raw));
        if (!(v >= 1 && v <= 5)) v = null;
      } else if (q.type === "scale") {
        v = raw === "" || raw == null ? null : Math.round(Number(raw));
        if (!(v >= 0 && v <= 10)) v = null;
      } else v = str(raw, 1500) || null;
      if (v === null && q.required) return fail(400, "Please answer: " + (q.en || q.ar), { missing: q.id });
      if (v !== null) ans.push({ id: q.id, type: q.type, en: q.en, ar: q.ar, value: v });
    }
    if (!ans.length) return fail(400, "Please answer at least one question.");
    const nameMode = ["first", "full", "anon"].includes(settings?.review_name) ? settings.review_name : "choose";
    const share = b.share === true, disp = nameMode !== "choose" ? nameMode : ["first", "full", "anon"].includes(b.display) ? b.display : "first";
    const lang = b.lang === "ar" ? "ar" : "en";
    const stars = ans.find((a) => a.type === "stars")?.value || 0;
    const texts = ans.filter((a) => a.type === "text");
    const t = now();
    const name = disp === "full" ? rec.full_name : disp === "first" ? firstName(rec.full_name) : lang === "ar" ? "\u0639\u0645\u064A\u0644 \u0628\u0635\u064A\u0631\u0629" : "A Basirah client";
    const review = {
      sid: rec.id,
      created_at: t,
      updated_at: t,
      lang,
      full_name: rec.full_name,
      package: rec.package,
      answers: ans,
      share,
      display: disp,
      display_name: name,
      stars,
      quote: texts[0] && lang !== "ar" ? texts[0].value : "",
      quote_ar: texts[0] && lang === "ar" ? texts[0].value : "",
      featured: false
    };
    await store.set("review/" + rec.id, review);
    await store.set(keyOf(rec.id), { ...rec, review_at: t, updated_at: t, history: [...rec.history, { at: t, by: "client", action: "Review received" }] });
    return json({ ok: true }, 201);
  }
  if (!["GET", "HEAD"].includes(req.method)) return fail(405, "Method not allowed");
  const ar0 = (done?.lang || rec.language) === "ar";
  const both = (en, ar) => `<span data-l="en">${en}</span><span data-l="ar">${ar}</span>`;
  const qHtml = qs.map((q, i) => {
    const lab = `<div class="ql"><span data-l="en">${H(q.en || q.ar)}</span><span data-l="ar">${H(q.ar || q.en)}</span>${q.required ? "" : both(" <i>(optional)</i>", " <i>(\u0627\u062E\u062A\u064A\u0627\u0631\u064A)</i>")}</div>`;
    let inp;
    if (q.type === "stars") inp = `<div class="st" role="radiogroup" data-q="${H(q.id)}" data-t="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" aria-label="${n}" data-v="${n}">\u2605</button>`).join("")}</div>`;
    else if (q.type === "scale") inp = `<div class="sc" role="radiogroup" data-q="${H(q.id)}" data-t="scale">${Array.from({ length: 11 }, (_, n) => `<button type="button" role="radio" aria-checked="false" data-v="${n}">${n}</button>`).join("")}</div>`;
    else inp = `<textarea data-q="${H(q.id)}" data-t="text" rows="3" maxlength="1500"></textarea>`;
    return `<div class="qb" data-req="${q.required ? 1 : 0}">${lab}${inp}</div>`;
  }).join("");
  const first = firstName(rec.full_name);
  const nameMode0 = ["first", "full", "anon"].includes(settings?.review_name) ? settings.review_name : "choose";
  const title = ar0 ? "\u0631\u0623\u064A\u0643 \u064A\u0647\u0645\u0646\u0627" : "Your voice matters";
  const html = `<!doctype html><html lang="${ar0 ? "ar" : "en"}" dir="${ar0 ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Basirah \xB7 ${ar0 ? "\u062A\u0642\u064A\u064A\u0645\u0643" : "Your review"}</title>${OGTAGS(origin, ar0 ? "\u0634\u0627\u0631\u0643\u0646\u0627 \u0631\u0623\u064A\u0643 \u0641\u064A \u0628\u0635\u064A\u0631\u0629" : "Share your Basirah experience", ar0 ? "\u062F\u0642\u064A\u0642\u062A\u0627\u0646 \u0641\u0642\u0637\u060C \u0648\u0631\u0623\u064A\u0643 \u064A\u0635\u0646\u0639 \u0641\u0631\u0642\u0627\u064B." : "It takes two minutes, and it means a lot.", "/og-star.png")}
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
<div class="top"><span class="brand"><img src="/icons/icon-192.png" alt="">Basirah</span><span class="lg" role="group" aria-label="Language"><button type="button" data-set="en" aria-pressed="${!ar0}">English</button> <button type="button" data-set="ar" aria-pressed="${ar0}">\u0627\u0644\u0639\u0631\u0628\u064A\u0629</button></span></div>
<div class="card" id="card">${done ? `<div class="thx"><div class="sp">\u2726</div><div class="big">${both("Thank you", "\u0634\u0643\u0631\u0627\u064B \u0644\u0643")}</div><p class="lead">${both("Your review was already received. We are grateful for your time.", "\u0648\u0635\u0644\u0646\u0627 \u062A\u0642\u064A\u064A\u0645\u0643 \u0645\u0633\u0628\u0642\u0627\u064B. \u0646\u0642\u062F\u0651\u0631 \u0648\u0642\u062A\u0643 \u0648\u062B\u0642\u062A\u0643.")}</p></div>` : `<div id="fm">
<h1>${both("Your voice matters" + (first ? ", " + H(first) : ""), "\u0631\u0623\u064A\u0643 \u064A\u0647\u0645\u0646\u0627" + (first ? "\u060C " + H(first) : ""))}</h1>
<p class="lead">${both("You have seen your insight. Tell us how it felt. It takes about two minutes.", "\u0627\u0637\u0651\u0644\u0639\u062A \u0639\u0644\u0649 \u0628\u0635\u064A\u0631\u062A\u0643\u060C \u0641\u0634\u0627\u0631\u0643\u0646\u0627 \u0643\u064A\u0641 \u0643\u0627\u0646 \u0634\u0639\u0648\u0631\u0643. \u064A\u0633\u062A\u063A\u0631\u0642 \u0627\u0644\u0623\u0645\u0631 \u062F\u0642\u064A\u0642\u062A\u064A\u0646 \u062A\u0642\u0631\u064A\u0628\u0627\u064B.")}</p>
${qHtml}
<div class="sh" id="sh"><label><input type="checkbox" id="share"><span>${both("You may share my words on the Basirah website", "\u064A\u0645\u0643\u0646\u0643\u0645 \u0639\u0631\u0636 \u0643\u0644\u0645\u0627\u062A\u064A \u0641\u064A \u0645\u0648\u0642\u0639 \u0628\u0635\u064A\u0631\u0629")}<small>${both("Optional. We never show your full report or contact details.", "\u0627\u062E\u062A\u064A\u0627\u0631\u064A. \u0644\u0646 \u0646\u0639\u0631\u0636 \u062A\u0642\u0631\u064A\u0631\u0643 \u0627\u0644\u0643\u0627\u0645\u0644 \u0648\u0644\u0627 \u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u062A\u0648\u0627\u0635\u0644 \u0623\u0628\u062F\u0627\u064B.")}</small></span></label>
${nameMode0 === "choose" ? `<div class="dn"><div class="ql" style="margin-top:4px">${both("How should your name appear?", "\u0643\u064A\u0641 \u064A\u0638\u0647\u0631 \u0627\u0633\u0645\u0643\u061F")}</div><select id="disp"><option value="first">${H(first || "First name")}</option><option value="full">${H(rec.full_name)}</option><option value="anon">${ar0 ? "\u0639\u0645\u064A\u0644 \u0628\u0635\u064A\u0631\u0629" : "A Basirah client"}</option></select></div></div>` : `<div class="dn"><p class="ql" style="margin-top:4px;font-weight:400">${nameMode0 === "anon" ? both("Your name will not be shown.", "\u0644\u0646 \u064A\u0638\u0647\u0631 \u0627\u0633\u0645\u0643.") : nameMode0 === "full" ? both("Your full name will be shown.", "\u0633\u064A\u0638\u0647\u0631 \u0627\u0633\u0645\u0643 \u0627\u0644\u0643\u0627\u0645\u0644.") : both("Only your first name will be shown.", "\u0633\u064A\u0638\u0647\u0631 \u0627\u0633\u0645\u0643 \u0627\u0644\u0623\u0648\u0644 \u0641\u0642\u0637.")}</p></div>`}
<button class="b" id="go" type="button">${both("Send my review", "\u0625\u0631\u0633\u0627\u0644 \u062A\u0642\u064A\u064A\u0645\u064A")}</button><p class="err" id="er" role="alert"></p></div>
<div class="thx" id="ty" hidden><div class="sp">\u2726</div><div class="big">${both("Thank you", "\u0634\u0643\u0631\u0627\u064B \u0644\u0643")}</div><p class="lead">${both("Your words help others begin their own journey of self-knowledge.", "\u0643\u0644\u0645\u0627\u062A\u0643 \u062A\u0633\u0627\u0639\u062F \u063A\u064A\u0631\u0643 \u0639\u0644\u0649 \u0628\u062F\u0621 \u0631\u062D\u0644\u062A\u0647 \u0641\u064A \u0645\u0639\u0631\u0641\u0629 \u0646\u0641\u0633\u0647.")}</p></div>`}</div></main>
<script>
(function(){var L=document.documentElement,lang=L.lang;function set(l){lang=l;L.lang=l;L.dir=l==='ar'?'rtl':'ltr';document.querySelectorAll('[data-set]').forEach(function(b){b.setAttribute('aria-pressed',b.dataset.set===l)})}
document.querySelectorAll('[data-set]').forEach(function(b){b.onclick=function(){set(b.dataset.set)}});
var fm=document.getElementById('fm');if(!fm)return;var val={};
document.querySelectorAll('.st,.sc').forEach(function(g){g.onclick=function(e){var b=e.target.closest('button');if(!b)return;var v=+b.dataset.v;val[g.dataset.q]=v;g.querySelectorAll('button').forEach(function(x){var on=g.dataset.t==='stars'?+x.dataset.v<=v:+x.dataset.v===v;x.classList.toggle('on',on);x.setAttribute('aria-checked',+x.dataset.v===v)})}});
var sh=document.getElementById('sh');document.getElementById('share').onchange=function(){sh.classList.toggle('on',this.checked)};
var T={en:{need:'Please answer the questions marked above.',fail:'We could not send your review. Check your connection and try again.'},ar:{need:'\u064A\u0631\u062C\u0649 \u0627\u0644\u0625\u062C\u0627\u0628\u0629 \u0639\u0646 \u0627\u0644\u0623\u0633\u0626\u0644\u0629 \u0627\u0644\u0645\u0637\u0644\u0648\u0628\u0629.',fail:'\u062A\u0639\u0630\u0651\u0631 \u0625\u0631\u0633\u0627\u0644 \u062A\u0642\u064A\u064A\u0645\u0643. \u062A\u062D\u0642\u0642 \u0645\u0646 \u0627\u062A\u0635\u0627\u0644\u0643 \u0648\u062D\u0627\u0648\u0644 \u0645\u062C\u062F\u062F\u0627\u064B.'}};
document.getElementById('go').onclick=function(){var er=document.getElementById('er'),btn=this;er.textContent='';var a={},miss=false;
document.querySelectorAll('.qb').forEach(function(q){var el=q.querySelector('[data-q]'),id=el.dataset.q,v=el.dataset.t==='text'?el.value.trim():val[id];if(v===undefined||v===''){if(q.dataset.req==='1')miss=true}else a[id]=v});
if(miss){er.textContent=T[lang].need;return}
btn.disabled=true;fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answers:a,share:document.getElementById('share').checked,display:(document.getElementById('disp')||{value:'first'}).value,lang:lang})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(x.ok||x.j.error&&/already/i.test(x.j.error)){fm.hidden=true;document.getElementById('ty').hidden=false;window.scrollTo(0,0)}else{btn.disabled=false;er.textContent=x.j.error||T[lang].fail}}).catch(function(){btn.disabled=false;er.textContent=T[lang].fail})}})();
</script></body></html>`;
  return new Response(req.method === "HEAD" ? null : html, { status: 200, headers: { ...hdr, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
}

// netlify/lib/router.mjs
async function route(req, store, env) {
  const p = new URL(req.url).pathname;
  if (p === "/api/health") {
    let check = null, error = "";
    try {
      check = store.selfCheck ? await store.selfCheck() : { table: true, files: true };
    } catch (e) {
      error = String(e.message || e).slice(0, 200);
    }
    const ok = !!check && check.table && check.files;
    return new Response(JSON.stringify({ ok, table: !!check?.table, files: !!check?.files, password_set: !!env.ADMIN_PASSWORD, error }), { status: ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  if (p === "/api/admin" || p.startsWith("/api/admin/")) return handleAdmin(req, store, env);
  if (p === "/api/submissions") return handleSubmit(req, store);
  if (p === "/api/settings") return handleSettings(req, store);
  if (p === "/api/promo") return handlePromo(req, store);
  if (p === "/api/upload") return handleUpload(req, store);
  if (p.startsWith("/api/file/")) return handleFile(req, store);
  if (p.startsWith("/api/img/")) return handleImage(req, store);
  if (p === "/s") return handleShare(req, store);
  if (p.startsWith("/r/")) return handleReport(req, store);
  if (p.startsWith("/v/")) return handleReview(req, store);
  return new Response("Not found", { status: 404 });
}

// netlify/lib/supabase-store.mjs
import { Buffer as Buffer2 } from "node:buffer";
var BIN = /^(upl|img|pdf)\//;
var PAGE = 1e3;
function supabaseStore({ url, key, bucket = "basirah", table = "kv", fetchImpl = fetch }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base || !key) throw new Error("Supabase address or key is missing");
  const auth = { apikey: key, authorization: "Bearer " + key };
  const rest = (path, init = {}) => fetchImpl(base + "/rest/v1/" + path, { ...init, headers: { ...auth, ...init.headers || {} } });
  const sto = (path, init = {}) => fetchImpl(base + "/storage/v1/" + path, { ...init, headers: { ...auth, ...init.headers || {} } });
  const must = async (r, what) => {
    if (!r.ok) throw new Error("Supabase " + what + " failed (" + r.status + "): " + (await r.text()).slice(0, 200));
    return r;
  };
  const objPath = (k) => "object/" + bucket + "/" + String(k).split("/").map(encodeURIComponent).join("/");
  const eq = (k) => "key=eq." + encodeURIComponent(k);
  async function pages(prefix, select) {
    const out = [];
    for (let off = 0; ; off += PAGE) {
      const r = await must(await rest(table + "?select=" + select + "&key=like." + encodeURIComponent(prefix.replace(/[%*]/g, "") + "*") + "&order=key&limit=" + PAGE + "&offset=" + off), "list");
      const rows = await r.json();
      for (const x of rows) if (x.key.startsWith(prefix)) out.push(x);
      if (rows.length < PAGE) return out;
    }
  }
  return {
    async get(k) {
      const r = await must(await rest(table + "?select=value&" + eq(k) + "&limit=1"), "read");
      const rows = await r.json();
      return rows.length ? rows[0].value : null;
    },
    async set(k, v) {
      await must(await rest(table + "?on_conflict=key", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ key: k, value: v, updated_at: (/* @__PURE__ */ new Date()).toISOString() }]) }), "write");
    },
    async delete(k) {
      await must(await rest(table + "?" + eq(k), { method: "DELETE", headers: { prefer: "return=minimal" } }), "delete");
      if (BIN.test(k)) {
        const r = await sto(objPath(k), { method: "DELETE" });
        if (!r.ok && r.status !== 404 && r.status !== 400) await must(r, "file delete");
      }
    },
    async list(prefix = "sub/") {
      return (await pages(prefix, "key")).map((x) => x.key);
    },
    async listValues(prefix = "sub/") {
      return (await pages(prefix, "key,value")).map((x) => x.value).filter(Boolean);
    },
    // many records in one go (Supabase counts every call)
    async getBin(k) {
      const r = await sto(objPath(k));
      if (r.status === 404 || r.status === 400) return null;
      await must(r, "file read");
      return Buffer2.from(await r.arrayBuffer());
    },
    async setBin(k, buf) {
      await must(await sto(objPath(k), { method: "POST", headers: { "content-type": "application/octet-stream", "x-upsert": "true" }, body: new Uint8Array(buf) }), "file write");
    },
    // used by /api/health: proves that the table and the bucket both work
    async selfCheck() {
      const k = "health/check", t = String(Date.now());
      await this.set(k, { t });
      const back = await this.get(k);
      await this.setBin("upl/health-check", Buffer2.from(t));
      const bin = await this.getBin("upl/health-check");
      await this.delete("upl/health-check");
      return { table: back && back.t === t, files: !!bin && bin.toString() === t };
    }
  };
}

// supabase/functions/api/index.ts
globalThis.Buffer = Buffer3;
var PREFIX = /^\/(functions\/v1\/)?api(?=\/|$)/;
Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const store = supabaseStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
  const u = new URL(req.url);
  const path = req.headers.get("x-site-path") || (u.pathname.replace(PREFIX, "") || "/") + u.search;
  const site = req.headers.get("x-site-origin") || u.origin;
  const inner = new URL(path, site);
  const h = new Headers(req.headers);
  h.delete("x-site-origin");
  h.delete("x-site-path");
  const body = ["GET", "HEAD"].includes(req.method) ? void 0 : await req.arrayBuffer();
  let res;
  try {
    res = await route(new Request(inner, { method: req.method, headers: h, body }), store, env);
  } catch (e) {
    console.error(e);
    res = new Response(JSON.stringify({ error: "Server error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const out = new Headers(res.headers);
  const ct = out.get("content-type") || "";
  if (/text\/html|application\/pdf|image\/svg/i.test(ct)) out.set("x-real-type", ct);
  return new Response(res.body, { status: res.status, headers: out });
});
