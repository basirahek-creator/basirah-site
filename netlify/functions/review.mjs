// Public endpoint: review
import { getStore } from '@netlify/blobs';
import { handleReview, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleReview(req, netlifyStore(getStore));
export const config = { path: '/v/*' };
