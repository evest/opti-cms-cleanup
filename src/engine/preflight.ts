import { randomUUID } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import { ApiError, type CmsClient } from '../api/client.js';
import { ROOT_CONTAINER } from '../rules.js';

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

/** Thrown when the API key lacks the rights to delete content; nothing more can be done until that is fixed. */
export class AccessDeniedError extends Error {}

export const ACCESS_RIGHTS_HELP =
  'In the CMS: Settings > Access Rights > select the root > give the API key Administer, and tick ' +
  '"Apply settings for all subitems" when saving. Then run the purge again.';

const PROBE_NAME = 'opti-cms-cleanup access check (safe to delete)';

/**
 * The API cannot report content access rights, so this proves them: it creates a throwaway folder under the
 * root and permanently deletes it. Content under the root inherits the root's rights when they are applied
 * to all subitems. Run before any change, so a missing grant stops the purge with nothing touched.
 */
export async function checkContentAccess(client: CmsClient): Promise<void> {
  // The create response has no body, so supply the key to be able to delete the folder again.
  const key = randomUUID().replace(/-/g, '');
  try {
    await client.request('POST', '/content', {
      body: { key, contentType: 'SysContentFolder', container: ROOT_CONTAINER, initialVersion: { displayName: PROBE_NAME } },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new AccessDeniedError(`The API key is not allowed to create or delete content (403). ${ACCESS_RIGHTS_HELP}`);
    }
    throw new Error(`Access check failed: could not create a test folder: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await client.request('DELETE', `/content/${key}`, { headers: { 'cms-permanent-delete': 'true' } });
  } catch (err) {
    const leftover = `A test folder "${PROBE_NAME}" (${key}) was left under the root; the next purge removes it.`;
    if (err instanceof ApiError && err.status === 403) {
      throw new AccessDeniedError(`The API key is not allowed to delete content (403). ${ACCESS_RIGHTS_HELP}\n${leftover}`);
    }
    throw new Error(`Access check failed: could not delete the test folder: ${err instanceof Error ? err.message : String(err)}\n${leftover}`);
  }
}

// One reader for all questions: a reader per question would swallow piped answers meant for the next one.
let reader: { rl: Interface; lines: AsyncIterator<string> } | undefined;

/**
 * Asks a yes/no question; an empty answer means `defaultYes`. If input ends without an answer (e.g. piped input
 * ran out), the default is used, which is the safe choice for every question the tool asks.
 */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!reader) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    reader = { rl, lines: rl[Symbol.asyncIterator]() };
  }
  process.stdout.write(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'} `);
  const next = await reader.lines.next();
  const answer = next.done ? '' : next.value.trim();
  if (next.done) process.stdout.write('\n');
  return answer ? /^y(es)?$/i.test(answer) : defaultYes;
}

/** Releases stdin so the process can exit once all questions are answered. */
export function closePrompts(): void {
  reader?.rl.close();
  reader = undefined;
}
