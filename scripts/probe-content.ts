/**
 * Phase 0 content-enumeration probe. STRICTLY READ-ONLY (GET only).
 *
 *   npm run probe:content -- <profile>
 *
 * Compares strategies for finding ALL content, since /content/{key}/items hides some children
 * and /content/versions excludes locale-neutral content by default.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProfile } from '../src/config/profiles.js';
import { ApiError, CmsClient } from '../src/api/client.js';

const profileName = process.argv[2];
if (!profileName) {
  console.error('Usage: npm run probe:content -- <profile>');
  process.exit(1);
}

const profile = getProfile(profileName);
const client = new CmsClient(profile);
const outDir = join('probe-output', `${profile.name}-content-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });
const save = (file: string, data: unknown) => writeFileSync(join(outDir, file), JSON.stringify(data, null, 2));

const ROOT = '43f936c99b234ea397b261c538ad07c9';
const FOR_ALL_SITES = 'e56f85d0e8334e02976a2d11fe4d598c';

async function tryGetAll(path: string): Promise<any[] | string> {
  try {
    return await client.getAll<any>(path);
  } catch (err) {
    return err instanceof ApiError ? `FAILED ${err.status} ${err.code ?? ''}` : String(err);
  }
}

// A. Instance-wide versions: default, NEUTRAL only, and all known locales + NEUTRAL
const locales = (await client.getAll<any>('/locales')).map((l) => l.key as string);
const versionQueries: Record<string, string> = {
  default: '/content/versions',
  neutral: '/content/versions?locales=NEUTRAL',
  allLocalesPlusNeutral: `/content/versions?${[...locales, 'NEUTRAL'].map((l) => `locales=${encodeURIComponent(l)}`).join('&')}`,
};
const versionKeys: Record<string, Set<string>> = {};
const versionStats: Record<string, unknown> = {};
const versionTypes = new Map<string, string>();
for (const [label, path] of Object.entries(versionQueries)) {
  const items = await tryGetAll(path);
  if (typeof items === 'string') {
    versionStats[label] = items;
    continue;
  }
  versionKeys[label] = new Set(items.map((v) => v.key));
  for (const v of items) versionTypes.set(v.key, v.contentType);
  versionStats[label] = { versions: items.length, distinctKeys: versionKeys[label].size };
  save(`versions-${label}.json`, items);
}

// B. Root children with explicit type filters, to see what the default hides
const rootFilters: Record<string, unknown> = {};
for (const filter of ['', 'SysContentFolder', '_folder', '_page', '_experience', '_component', '_media', '_image', '_video']) {
  const items = await tryGetAll(`/content/${ROOT}/items${filter ? `?contentTypes=${filter}` : ''}`);
  rootFilters[filter || '(default)'] =
    typeof items === 'string' ? items : items.map((i) => `${i.contentType} ${i.key} ${i.displayName ?? ''}`.trim());
}
save('root-filters.json', rootFilters);

// C. Full recursive walk (items + assets) from root and For All Sites
const walked = new Map<string, { container: string; contentType: string; via: string }>();
const walkErrors: string[] = [];
async function walk(key: string) {
  for (const kind of ['items', 'assets'] as const) {
    const children = await tryGetAll(`/content/${key}/${kind}`);
    if (typeof children === 'string') {
      walkErrors.push(`${kind} ${key}: ${children}`);
      continue;
    }
    for (const child of children) {
      if (walked.has(child.key)) continue;
      walked.set(child.key, { container: key, contentType: child.contentType, via: kind });
      await walk(child.key);
    }
  }
}
await walk(ROOT);
await walk(FOR_ALL_SITES);
save('walk.json', Object.fromEntries(walked));

// D. Compare
const walkKeys = new Set(walked.keys());
const allVersionKeys = new Set(Object.values(versionKeys).flatMap((s) => [...s]));
const onlyInVersions = [...allVersionKeys].filter((k) => !walkKeys.has(k));
const onlyInWalk = [...walkKeys].filter((k) => !allVersionKeys.has(k));

// For items only found via versions, look up their container to see where the walk missed them
const missedDetail: unknown[] = [];
for (const key of onlyInVersions.slice(0, 25)) {
  try {
    const node = await client.get<any>(`/content/${key}`);
    missedDetail.push({ key, contentType: node.contentType ?? versionTypes.get(key), container: node.container });
  } catch (err) {
    missedDetail.push({ key, error: err instanceof ApiError ? err.status : String(err) });
  }
}

const countTypes = (keys: Iterable<string>, lookup: (k: string) => string | undefined) =>
  [...keys].reduce<Record<string, number>>((acc, k) => {
    const t = lookup(k) ?? '?';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});

const report = {
  versionStats,
  walk: { nodes: walked.size, errors: walkErrors.length, byType: countTypes(walkKeys, (k) => walked.get(k)?.contentType), viaAssets: [...walked.values()].filter((w) => w.via === 'assets').length },
  union: walkKeys.size + onlyInVersions.length,
  onlyInVersions: { count: onlyInVersions.length, byType: countTypes(onlyInVersions, (k) => versionTypes.get(k)), sample: missedDetail },
  onlyInWalk: { count: onlyInWalk.length, byType: countTypes(onlyInWalk, (k) => walked.get(k)?.contentType) },
  rootFilters,
};
save('report.json', report);
if (walkErrors.length) save('walk-errors.json', walkErrors);
console.log(JSON.stringify(report, null, 2));
console.log(`\nSaved to ${outDir}`);
