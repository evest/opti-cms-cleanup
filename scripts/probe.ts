/**
 * Phase 0 API probe. STRICTLY READ-ONLY: only GET requests (plus the token POST).
 *
 *   npm run probe -- <profile>
 *
 * Downloads the authenticated OpenAPI spec, lists every resource the cleanup tool will touch,
 * samples the content tree, and checks which well-known root containers exist.
 * Everything is saved under probe-output/<profile>-<timestamp>/ for review.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfile } from '../src/config/profiles.js';
import { ApiError, CmsClient } from '../src/api/client.js';

const profileName = process.argv[2];
if (!profileName) {
  console.error('Usage: npm run probe -- <profile>');
  process.exit(1);
}

const profile = getProfile(profileName);
const client = new CmsClient(profile);
const outDir = join('probe-output', `${profile.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

const save = (file: string, data: unknown) => writeFileSync(join(outDir, file), JSON.stringify(data, null, 2));
const summary: Record<string, string> = {};

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    summary[label] = Array.isArray(result) ? `OK (${result.length} items)` : 'OK';
    return result;
  } catch (err) {
    summary[label] = err instanceof ApiError ? `FAILED ${err.status} ${err.code ?? ''}`.trim() : `ERROR ${(err as Error).message}`;
    save(`${label.replace(/[^\w-]/g, '_')}.error.json`, err instanceof ApiError ? err.body : String(err));
    return undefined;
  }
}

const ROOT_CONTAINER = '43f936c99b234ea397b261c538ad07c9';
// CMS 12-era well-known keys; unverified for SaaS.
const WELL_KNOWN: Record<string, string> = {
  root: ROOT_CONTAINER,
  wastebasket: '2f40ba47f4fc47aea2440b909d4cf988',
  forAllSites: 'e56f85d0e8334e02976a2d11fe4d598c',
  globalAssets: '99d5752961f247c080c0f91eca6af1ac',
};

console.log(`Probing ${profile.name} (${profile.instance} / ${profile.environment}) -> ${outDir}\n`);

// 1. OpenAPI spec (definitive endpoint reference)
const spec = await attempt('openapi-spec', () => client.get<unknown>('/docs/content-openapi.json'));
if (spec) save('content-openapi.json', spec);

// 2. Settings-type resources
const resources = [
  'applications',
  'locales',
  'contenttypes',
  'displaytemplates',
  'blueprints',
  'propertygroups',
  'propertyformats',
  'contentsources',
  'contenttypebindings',
] as const;

const lists: Record<string, any[]> = {};
for (const r of resources) {
  const items = await attempt(r, () => client.getAll<any>(`/${r}`));
  if (items) {
    lists[r] = items;
    save(`${r}.json`, items);
  }
}

const manifest = await attempt('manifest', () => client.get<unknown>('/manifest?includeReadOnly=true'));
if (manifest) save('manifest.json', manifest);

// 3. Content tree: well-known containers, application roots, and a shallow walk
const containers: Record<string, string> = { ...WELL_KNOWN };
for (const app of lists.applications ?? []) {
  for (const field of ['entryPoint', 'contentRoot', 'assetsRoot', 'startPage']) {
    if (typeof app[field] === 'string') containers[`app:${app.key}:${field}`] = app[field];
  }
}

const containerReport: Record<string, unknown> = {};
for (const [label, key] of Object.entries(containers)) {
  const node = await attempt(`content:${label}`, () => client.get<any>(`/content/${key}`));
  const children = node ? await attempt(`items:${label}`, () => client.getAll<any>(`/content/${key}/items`)) : undefined;
  const assets = node ? await attempt(`assets:${label}`, () => client.getAll<any>(`/content/${key}/assets`)) : undefined;
  containerReport[label] = { key, node, children, assets };
}
save('containers.json', containerReport);

// Shallow tree sample from the root (depth 3) to see node shapes and count reachable items
const tree: any[] = [];
async function walk(key: string, depth: number) {
  if (depth > 3) return;
  let children: any[] = [];
  try {
    children = await client.getAll<any>(`/content/${key}/items`);
  } catch (err) {
    tree.push({ depth, parent: key, error: err instanceof ApiError ? `${err.status} ${err.code ?? ''}` : String(err) });
  }
  for (const child of children) {
    tree.push({ depth, parent: key, key: child.key, contentType: child.contentType, displayName: child.displayName });
    if (child.key) await walk(child.key, depth + 1);
  }
}
await walk(ROOT_CONTAINER, 1);
save('tree-sample.json', tree);

// 4. Instance-wide version listing (alternative enumeration strategy)
const versions = await attempt('content-versions-page0', () => client.get<any>('/content/versions?pageIndex=0&pageSize=100'));
if (versions) save('content-versions-page0.json', versions);

// 5. Analysis helpers
const types = lists.contenttypes ?? [];
const analysis = {
  contentTypes: {
    total: types.length,
    bySource: countBy(types, (t) => t.source ?? '(none)'),
    byBaseType: countBy(types, (t) => t.baseType ?? '(none)'),
  },
  propertyGroups: { bySource: countBy(lists.propertygroups ?? [], (g) => g.source ?? '(none)') },
  applications: (lists.applications ?? []).map((a) => ({ key: a.key, displayName: a.displayName, source: a.source, hosts: a.hosts })),
  locales: lists.locales ?? [],
  treeSample: { reachableWithinDepth3: tree.length },
};
save('analysis.json', analysis);
save('summary.json', summary);

console.table(summary);
console.log('\nContent types by source:', analysis.contentTypes.bySource);
console.log('Applications:', JSON.stringify(analysis.applications, null, 2));
console.log(`\nSaved to ${outDir}`);

function countBy<T>(items: T[], fn: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const k = fn(item);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}
