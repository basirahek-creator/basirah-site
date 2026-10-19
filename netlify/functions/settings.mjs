// Public endpoint: the website reads the WhatsApp lines and payment methods from here.
import { getStore } from '@netlify/blobs';
import { handleSettings, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleSettings(req, netlifyStore(getStore));
export const config = { path: '/api/settings' };
