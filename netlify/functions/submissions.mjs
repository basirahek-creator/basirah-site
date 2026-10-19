// Public endpoint: the website posts each finished assessment here (in addition to the Formspree email).
import { getStore } from '@netlify/blobs';
import { handleSubmit, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleSubmit(req, netlifyStore(getStore));
export const config = { path: '/api/submissions' };
