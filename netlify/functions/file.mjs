// Public endpoint: plays or shows a file a client attached (the link is private and cannot be guessed).
import { getStore } from '@netlify/blobs';
import { handleFile, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleFile(req, netlifyStore(getStore));
export const config = { path: '/api/file/*' };
