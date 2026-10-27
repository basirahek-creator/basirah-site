// A store with the same shape as the Netlify one, kept in Supabase:
//   small records  -> one Postgres table  (kv: key, value)
//   files          -> one private Storage bucket (receipts, voice answers, pictures, PDFs)
// It only uses fetch, so it runs in a Supabase Edge Function (Deno) and in Node for the tests.
import { Buffer } from 'node:buffer';

const BIN = /^(upl|img|pdf)\//;                 // keys that are files, not records
const PAGE = 1000;

export function supabaseStore({ url, key, bucket = 'basirah', table = 'kv', fetchImpl = fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base || !key) throw new Error('Supabase address or key is missing');
  const auth = { apikey: key, authorization: 'Bearer ' + key };
  const rest = (path, init = {}) => fetchImpl(base + '/rest/v1/' + path, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const sto = (path, init = {}) => fetchImpl(base + '/storage/v1/' + path, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const must = async (r, what) => { if (!r.ok) throw new Error('Supabase ' + what + ' failed (' + r.status + '): ' + (await r.text()).slice(0, 200)); return r; };
  const objPath = (k) => 'object/' + bucket + '/' + String(k).split('/').map(encodeURIComponent).join('/');
  const eq = (k) => 'key=eq.' + encodeURIComponent(k);

  async function pages(prefix, select) {
    const out = [];
    for (let off = 0; ; off += PAGE) {
      const r = await must(await rest(table + '?select=' + select + '&key=like.' + encodeURIComponent(prefix.replace(/[%*]/g, '') + '*') + '&order=key&limit=' + PAGE + '&offset=' + off), 'list');
      const rows = await r.json();
      for (const x of rows) if (x.key.startsWith(prefix)) out.push(x);     // LIKE treats _ as a wildcard, so check the start again
      if (rows.length < PAGE) return out;
    }
  }

  return {
    async get(k) {
      const r = await must(await rest(table + '?select=value&' + eq(k) + '&limit=1'), 'read');
      const rows = await r.json();
      return rows.length ? rows[0].value : null;
    },
    async set(k, v) {
      await must(await rest(table + '?on_conflict=key', { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key: k, value: v, updated_at: new Date().toISOString() }]) }), 'write');
    },
    async delete(k) {
      await must(await rest(table + '?' + eq(k), { method: 'DELETE', headers: { prefer: 'return=minimal' } }), 'delete');
      if (BIN.test(k)) { const r = await sto(objPath(k), { method: 'DELETE' }); if (!r.ok && r.status !== 404 && r.status !== 400) await must(r, 'file delete'); }
    },
    async list(prefix = 'sub/') { return (await pages(prefix, 'key')).map((x) => x.key); },
    async listValues(prefix = 'sub/') { return (await pages(prefix, 'key,value')).map((x) => x.value).filter(Boolean); },   // many records in one go (Supabase counts every call)
    async getBin(k) {
      const r = await sto(objPath(k));
      if (r.status === 404 || r.status === 400) return null;
      await must(r, 'file read');
      return Buffer.from(await r.arrayBuffer());
    },
    async setBin(k, buf) {
      await must(await sto(objPath(k), { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' }, body: new Uint8Array(buf) }), 'file write');
    },
    // used by /api/health: proves that the table and the bucket both work
    async selfCheck() {
      const k = 'health/check', t = String(Date.now());
      await this.set(k, { t });
      const back = await this.get(k);
      await this.setBin('upl/health-check', Buffer.from(t));
      const bin = await this.getBin('upl/health-check');
      await this.delete('upl/health-check'); await this.delete(k);
      return { table: back && back.t === t, files: !!bin && bin.toString() === t };
    },
  };
}
