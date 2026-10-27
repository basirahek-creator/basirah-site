// One place that decides which handler answers which address (used by the Supabase function and the tests).
import { handleAdmin, handleSubmit, handleSettings, handlePromo, handleReport, handleUpload, handleFile, handleReview, handleShare, handleImage } from './core.mjs';

export async function route(req, store, env) {
  const p = new URL(req.url).pathname;
  if (p === '/api/health') {
    let check = null, error = '';
    try { check = store.selfCheck ? await store.selfCheck() : { table: true, files: true }; } catch (e) { error = String(e.message || e).slice(0, 200); }
    const ok = !!check && check.table && check.files;
    return new Response(JSON.stringify({ ok, table: !!check?.table, files: !!check?.files, password_set: !!env.ADMIN_PASSWORD, error }), { status: ok ? 200 : 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  if (p === '/api/admin' || p.startsWith('/api/admin/')) return handleAdmin(req, store, env);
  if (p === '/api/submissions') return handleSubmit(req, store);
  if (p === '/api/settings') return handleSettings(req, store);
  if (p === '/api/promo') return handlePromo(req, store);
  if (p === '/api/upload') return handleUpload(req, store);
  if (p.startsWith('/api/file/')) return handleFile(req, store);
  if (p.startsWith('/api/img/')) return handleImage(req, store);
  if (p === '/s') return handleShare(req, store);
  if (p.startsWith('/r/')) return handleReport(req, store);
  if (p.startsWith('/v/')) return handleReview(req, store);
  return new Response('Not found', { status: 404 });
}
