// Public endpoint: the website sends a client's voice answer or payment receipt here and gets back a link.
import { getStore } from '@netlify/blobs';
import { handleUpload, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleUpload(req, netlifyStore(getStore));
export const config = { path: '/api/upload' };
