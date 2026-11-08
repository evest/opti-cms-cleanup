import { ApiError, type CmsClient } from '../api/client.js';
import type { PlanItem, UnresolvedItem } from '../model.js';
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

/** Lists a container's children; 404 means none (orphaned asset folders answer /items but not /assets). */
async function listChildren(client: CmsClient, key: string, kind: 'items' | 'assets'): Promise<ContentNode[]> {
  try {
    return await client.getAll<ContentNode>(`/content/${key}/${kind}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
}

/**
 * Finds all content in the environment.
 *
 * Walks the tree from both system roots (the root's /items does not list "For All Sites"),
 * then cross-checks against the instance-wide version listings. Localized and locale-neutral
 * versions must be fetched with separate calls. See docs/api-notes.md.
 *
 * Some keys in the version history can't be loaded: typically "For this page/block" asset folders whose owning
 * content was deleted. Their /items still works, so their contents are walked and added to the plan.
 */
export async function enumerateContent(
  client: CmsClient,
  baseTypes: Map<string, string | undefined>,
): Promise<{ items: PlanItem[]; notes: string[]; unresolved: UnresolvedItem[] }> {
  const found = new Map<string, Found>();
  const notes: string[] = [];
  const unresolved: UnresolvedItem[] = [];

  // Breadth-first, one level at a time, so depth is known and requests can run in parallel.
  const walk = async (start: { key: string; depth: number }[]) => {
    let level = start;
    while (level.length) {
      const children = await mapLimit(level, CONCURRENCY, async ({ key, depth }) => {
        const [items, assets] = await Promise.all([listChildren(client, key, 'items'), listChildren(client, key, 'assets')]);
        return [...items, ...assets].map((node) => ({ node: { container: key, ...node }, depth: depth + 1 }));
      });
      level = [];
      for (const child of children.flat()) {
        if (found.has(child.node.key) || SYSTEM_CONTAINERS.includes(child.node.key)) continue;
        found.set(child.node.key, child);
        level.push({ key: child.node.key, depth: child.depth });
      }
    }
  };
  await walk(SYSTEM_CONTAINERS.map((key) => ({ key, depth: 0 })));

  // Cross-check: anything that only shows up in the version listings.
  const [localized, neutral] = await Promise.all([
    client.getAll<Version>('/content/versions'),
    client.getAll<Version>('/content/versions?locales=NEUTRAL'),
  ]);

  // Tree nodes carry no displayName (it is per locale); take it from the versions, preferring English.
  const names = new Map<string, string>();
  const types = new Map<string, string | undefined>();
  for (const v of [...neutral, ...localized]) {
    if (v.displayName && (!names.has(v.key) || v.locale === 'en')) names.set(v.key, v.displayName);
    types.set(v.key, v.contentType);
  }
  const missing = [...new Set([...localized, ...neutral].map((v) => v.key))].filter(
    (key) => !found.has(key) && !SYSTEM_CONTAINERS.includes(key),
  );
  await mapLimit(missing, CONCURRENCY, async (key) => {
    try {
      const node = await client.get<ContentNode>(`/content/${key}`);
      const parentDepth = node.container ? found.get(node.container)?.depth : undefined;
      found.set(key, { node: { ...node, key }, depth: parentDepth !== undefined ? parentDepth + 1 : 0 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) unresolved.push({ key, name: names.get(key), contentType: types.get(key) });
      else throw err;
    }
  });
  const added = missing.length - unresolved.length;
  if (added) notes.push(`${added} content item(s) found only in the version history were added to the plan`);

  if (unresolved.length) {
    // Their contents are reachable even though the folders themselves are not.
    await walk(unresolved.map(({ key }) => ({ key, depth: 0 })));
    const unresolvedKeys = new Set(unresolved.map((u) => u.key));
    const inside = [...found.values()].filter((f) => f.node.container && unresolvedKeys.has(f.node.container)).length;
    const assetFolders = unresolved.filter((u) => u.contentType === 'SysContentAssetFolder').length;
    notes.push(
      `${unresolved.length} item(s) in the version history can't be loaded through the API` +
        (assetFolders === unresolved.length
          ? ': "For this page/block" asset folders whose content was deleted.'
          : ` (${assetFolders} of them "For this page/block" asset folders whose content was deleted).`) +
        ` The API can't delete them either (every delete route returns 404), so they are not part of the plan` +
        (inside ? `, but the ${inside} item(s) inside them are.` : ' and are empty.') +
        ' They are invisible in the CMS UI; only Optimizely support can remove them. See "unresolved" in the saved inventory.',
    );
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
  return { items, notes, unresolved };
}
