// Public endpoint: a client opens their report PDF from its private link.
import { getStore } from '@netlify/blobs';
import { handleReport, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleReport(req, netlifyStore(getStore));
export const config = { path: '/r/*' };
