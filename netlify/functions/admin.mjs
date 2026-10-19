// Admin API used by /admin. Every route except /login needs the signed token returned by /login.
import { getStore } from '@netlify/blobs';
import { handleAdmin, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleAdmin(req, netlifyStore(getStore), process.env);
export const config = { path: ['/api/admin', '/api/admin/*'] };
