import { ApiError, type CmsClient } from '../api/client.js';
import { CATEGORIES, CONTENT_GROUPS, type Category, type PlanItem } from '../model.js';
import { mapLimit } from '../util/mapLimit.js';

export type Status = 'done' | 'gone' | 'failed';

export interface Outcome {
  category: Category;
  key: string;
  name?: string;
  action: PlanItem['action'];
  status: Status;
  pass: number;
  error?: string;
  at: string;
}

export interface StepProgress {
  category: Category;
  done: number;
  total: number;
  pass: number;
}

export interface PurgeOptions {
  concurrency?: number;
  onProgress?: (p: StepProgress) => void;
  onStepDone?: (category: Category, outcomes: Outcome[]) => void;
}

/** Thrown when the API key lacks the rights to delete content; nothing more can be done until that is fixed. */
export class AccessDeniedError extends Error {}

const MAX_PASSES = 5;

/** Executes every actionable item of an inventory, category by category, in dependency order. */
export async function purge(client: CmsClient, items: PlanItem[], options: PurgeOptions = {}): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const category of CATEGORIES) {
    const actionable = items.filter((i) => i.category === category && ['delete', 'disable', 'enable'].includes(i.action));
    if (!actionable.length) continue;
    const stepOutcomes = await runStep(client, category, actionable, options);
    outcomes.push(...stepOutcomes);
    options.onStepDone?.(category, stepOutcomes);
  }
  return outcomes;
}

async function runStep(client: CmsClient, category: Category, items: PlanItem[], options: PurgeOptions): Promise<Outcome[]> {
  const concurrency = options.concurrency ?? 4;
  const outcomes: Outcome[] = [];
  const record = (item: PlanItem, status: Status, pass: number, error?: string) =>
    outcomes.push({ category, key: item.key, name: item.name, action: item.action, status, pass, error, at: new Date().toISOString() });

  let pending = items;
  for (let pass = 1; pending.length && pass <= MAX_PASSES; pass++) {
    const failures: { item: PlanItem; error: ApiError | Error }[] = [];
    for (const batch of batches(category, pending)) {
      await mapLimit(batch, concurrency, async (item) => {
        try {
          await apply(client, item);
          record(item, 'done', pass);
        } catch (err) {
          // Already gone, e.g. removed together with its container.
          if (err instanceof ApiError && err.status === 404 && item.action === 'delete') record(item, 'gone', pass);
          else failures.push({ item, error: err as Error });
        }
        options.onProgress?.({ category, done: outcomes.length, total: items.length, pass });
      });
    }

    if (category === 'content' && pass === 1 && failures.length === pending.length && failures.every((f) => isForbidden(f.error))) {
      for (const f of failures) record(f.item, 'failed', pass, describe(f.error));
      throw new AccessDeniedError(
        'The API key is not allowed to delete content (403). In the CMS: Settings > Access Rights > root, give the API key ' +
          'Administer and tick "Apply settings for all subitems", then run again.',
      );
    }

    const noProgress = failures.length === pending.length;
    if (noProgress || pass === MAX_PASSES) {
      for (const f of failures) record(f.item, 'failed', pass, describe(f.error));
      break;
    }
    pending = failures.map((f) => f.item);
  }
  return outcomes;
}

/**
 * Groups items into batches that run one after another; items within a batch run in parallel.
 * Content goes by deletion group (pages, blocks, media, folders), deepest first within each group.
 * Locales enable the default before disabling the rest.
 */
export function batches(category: Category, items: PlanItem[]): PlanItem[][] {
  if (category === 'locales') {
    return [items.filter((i) => i.action === 'enable'), items.filter((i) => i.action !== 'enable')].filter((b) => b.length);
  }
  if (category !== 'content') return [items];

  const byBucket = new Map<string, PlanItem[]>();
  for (const item of items) {
    const group = CONTENT_GROUPS.indexOf(item.content?.group ?? 'blocks');
    const depth = item.content?.depth ?? 0;
    const bucket = `${group}:${depth}`;
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), item]);
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => {
      const [ga, da] = a.split(':').map(Number) as [number, number];
      const [gb, db] = b.split(':').map(Number) as [number, number];
      return ga - gb || db - da;
    })
    .map(([, batch]) => batch);
}

function apply(client: CmsClient, item: PlanItem): Promise<unknown> {
  const key = encodeURIComponent(item.key);
  switch (item.action) {
    case 'delete':
      return item.category === 'content'
        ? client.request('DELETE', `/content/${key}`, { headers: { 'cms-permanent-delete': 'true' } })
        : client.request('DELETE', `/${item.category}/${key}`);
    case 'enable':
    case 'disable':
      return client.request('PATCH', `/${item.category}/${key}`, {
        headers: { 'Content-Type': 'application/merge-patch+json' },
        body: { isEnabled: item.action === 'enable' },
      });
    default:
      throw new Error(`Nothing to apply for action "${item.action}"`);
  }
}

const isForbidden = (err: unknown) => err instanceof ApiError && err.status === 403;

function describe(err: unknown): string {
  if (!(err instanceof ApiError)) return String(err instanceof Error ? err.message : err);
  const body = err.body as { title?: string; detail?: string; code?: string } | undefined;
  return [err.status, err.code, body?.detail ?? body?.title].filter(Boolean).join(' ');
}
