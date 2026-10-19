// Public endpoint: share
import { getStore } from '@netlify/blobs';
import { handleShare, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleShare(req, netlifyStore(getStore));
export const config = { path: '/s' };
