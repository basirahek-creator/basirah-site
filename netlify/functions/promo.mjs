// Public endpoint: the website asks here whether a promo code is valid and what it takes off.
import { getStore } from '@netlify/blobs';
import { handlePromo, netlifyStore } from '../lib/core.mjs';

export default async (req) => handlePromo(req, netlifyStore(getStore));
export const config = { path: '/api/promo' };
