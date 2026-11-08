import { ApiError, type CmsClient } from '../api/client.js';
import type { PlanItem } from '../model.js';
import { contentGroupFor, SYSTEM_CONTAINERS } from '../rules.js';
import { mapLimit } from '../util/mapLimit.js';

interface ContentNode {
  key: string;
  container?: string;
  contentType?: string;
  displayName?: string;
}

interface Version extends ContentNode {
  locale?: string;
}

interface Found {
  node: ContentNode;
  depth: number;
}

const CONCURRENCY = 8;

/**
 * Finds all content in the environment.
 *
 * Walks the tree from both system roots (the root's /items does not list "For All Sites"),
 * then cross-checks against the instance-wide version listings. Localized and locale-neutral
 * versions must be fetched with separate calls. See docs/api-notes.md.
 */
export async function enumerateContent(
  client: CmsClient,
  baseTypes: Map<string, string | undefined>,
): Promise<{ items: PlanItem[]; notes: string[] }> {
  const found = new Map<string, Found>();
  const notes: string[] = [];

  // Breadth-first, one level at a time, so depth is known and requests can run in parallel.
  let level = SYSTEM_CONTAINERS.map((key) => ({ key, depth: 0 }));
  while (level.length) {
    const children = await mapLimit(level, CONCURRENCY, async ({ key, depth }) => {
      const [items, assets] = await Promise.all([
        client.getAll<ContentNode>(`/content/${key}/items`),
        client.getAll<ContentNode>(`/content/${key}/assets`),
      ]);
      return [...items, ...assets].map((node) => ({ node: { container: key, ...node }, depth: depth + 1 }));
    });
    level = [];
    for (const child of children.flat()) {
      if (found.has(child.node.key) || SYSTEM_CONTAINERS.includes(child.node.key)) continue;
      found.set(child.node.key, child);
      level.push({ key: child.node.key, depth: child.depth });
    }
  }

  // Cross-check: anything that only shows up in the version listings.
  const [localized, neutral] = await Promise.all([
    client.getAll<Version>('/content/versions'),
    client.getAll<Version>('/content/versions?locales=NEUTRAL'),
  ]);

  // Tree nodes carry no displayName (it is per locale); take it from the versions, preferring English.
  const names = new Map<string, string>();
  for (const v of [...neutral, ...localized]) {
    if (v.displayName && (!names.has(v.key) || v.locale === 'en')) names.set(v.key, v.displayName);
  }
  const missing = [...new Set([...localized, ...neutral].map((v) => v.key))].filter(
    (key) => !found.has(key) && !SYSTEM_CONTAINERS.includes(key),
  );
  if (missing.length) {
    notes.push(`${missing.length} content item(s) found only via /content/versions, not the tree walk`);
    await mapLimit(missing, CONCURRENCY, async (key) => {
      try {
        const node = await client.get<ContentNode>(`/content/${key}`);
        const parentDepth = node.container ? found.get(node.container)?.depth : undefined;
        found.set(key, { node: { ...node, key }, depth: parentDepth !== undefined ? parentDepth + 1 : 0 });
      } catch (err) {
        // Most likely in the trash; the user is asked to empty it before a purge.
        notes.push(`Could not load ${key}: ${err instanceof ApiError ? err.status : String(err)}`);
      }
    });
  }

  const items = [...found.values()].map(({ node, depth }): PlanItem => {
    const contentType = node.contentType ?? '?';
    const baseType = baseTypes.get(contentType);
    return {
      category: 'content',
      key: node.key,
      name: node.displayName ?? names.get(node.key),
      action: 'delete',
      content: { contentType, baseType, group: contentGroupFor(baseType), container: node.container, depth },
    };
  });
  return { items, notes };
}
