// Cloudflare Pages relay: every back-office address (see _routes.json) is passed on to the Supabase function.
// Needed because Supabase shows web pages as plain text on its own address; here the real type is put back.
export async function onRequest({ request, env }) {
  const target = (env.SUPABASE_FN_URL || '').replace(/\/+$/, '');
  if (!target) return new Response('Setup missing: add SUPABASE_FN_URL in Cloudflare Pages settings.', { status: 503 });
  const u = new URL(request.url);
  const h = new Headers();
  for (const [k, v] of request.headers) if (!/^(host|cf-|x-forwarded|x-real-ip|content-length|connection)/i.test(k)) h.set(k, v);
  h.set('x-site-origin', u.origin);
  h.set('x-site-path', u.pathname + u.search);
  const ip = request.headers.get('cf-connecting-ip'); if (ip) h.set('x-forwarded-for', ip);
  const init = { method: request.method, headers: h, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
  const up = await fetch(target + '/', init);
  const out = new Headers(up.headers);
  const real = out.get('x-real-type');
  if (real) out.set('content-type', real);
  for (const k of ['x-real-type', 'content-security-policy', 'content-encoding', 'content-length', 'x-sb-gateway-version']) out.delete(k);
  return new Response(up.body, { status: up.status, headers: out });
}
