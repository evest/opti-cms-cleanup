import { createInterface } from 'node:readline/promises';
import type { CmsClient } from '../api/client.js';

const normalizeUrl = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '');

/**
 * The credentials decide which instance is targeted, so a mixed-up .env would silently hit the wrong one.
 * The token's siteUrl claim must match the profile's cmsUrl.
 */
export async function verifyTarget(client: CmsClient): Promise<{ siteUrl?: string; instanceId?: string }> {
  const claims = await client.tokens.getClaims();
  const { cmsUrl, name } = client.profile;
  if (!claims.siteUrl) return claims;
  if (normalizeUrl(claims.siteUrl) !== normalizeUrl(cmsUrl)) {
    throw new Error(
      `Profile "${name}" expects ${cmsUrl}, but its API key belongs to ${claims.siteUrl}. Check profiles.json and .env.`,
    );
  }
  return claims;
}

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} (y/N) `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
