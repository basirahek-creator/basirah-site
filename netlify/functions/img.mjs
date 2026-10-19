// Public endpoint: serves the pictures you upload for packages, offers and promo codes.
import { getStore } from '@netlify/blobs';
import { handleImage, netlifyStore } from '../lib/core.mjs';

export default async (req) => handleImage(req, netlifyStore(getStore));
export const config = { path: '/api/img/*' };
