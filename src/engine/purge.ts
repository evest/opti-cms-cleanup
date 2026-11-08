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
  /** HTTP status of the last failure, if any. */
  httpStatus?: number;
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
  /**
   * Scans for content again. After deleting content the CMS can expose items the first scan didn't see
   * (e.g. orphans under containers that were not loadable), so the content step repeats until a scan comes back empty.
   */
  rescanContent?: () => Promise<PlanItem[]>;
  onContentRound?: (round: number, found: number) => void;
}

export interface PurgeResult {
  outcomes: Outcome[];
  /** Set when the purge stopped early because a step that later steps depend on did not fully succeed. */
  stoppedAfter?: Category;
}

/**
 * Steps that must fully succeed before the purge continues. Deleting templates, types and tabs while
 * content remains would fail (types in use) or leave a broken site, so the purge stops instead.
 */
const GATING_STEPS = new Set<Category>(['applications', 'content']);

const MAX_PASSES = 5;
/** Delete-and-rescan rounds for content, including the first. */
const MAX_CONTENT_ROUNDS = 4;

/** Executes every actionable item of an inventory, category by category, in dependency order. */
export async function purge(client: CmsClient, items: PlanItem[], options: PurgeOptions = {}): Promise<PurgeResult> {
  const outcomes: Outcome[] = [];
  for (const category of CATEGORIES) {
    const actionable = items.filter((i) => i.category === category && ['delete', 'disable', 'enable'].includes(i.action));
    if (!actionable.length) continue;
    const stepOutcomes = await runStep(client, category, actionable, options);
    if (category === 'content' && options.rescanContent) await deleteRemainingContent(client, stepOutcomes, options);
    outcomes.push(...stepOutcomes);
    options.onStepDone?.(category, stepOutcomes);
    if (GATING_STEPS.has(category) && stepOutcomes.some((o) => o.status === 'failed')) {
      return { outcomes, stoppedAfter: category };
    }
  }
  return { outcomes };
}

/** Rescans and deletes newly found content until nothing is left; whatever survives every round is recorded as failed. */
async function deleteRemainingContent(client: CmsClient, outcomes: Outcome[], options: PurgeOptions): Promise<void> {
  for (let round = 2; ; round++) {
    if (outcomes.some((o) => o.status === 'failed')) return;
    const remaining = (await options.rescanContent!()).filter((i) => i.category === 'content' && i.action === 'delete');
    if (!remaining.length) return;
    if (round > MAX_CONTENT_ROUNDS) {
      const at = new Date().toISOString();
      for (const item of remaining) {
        outcomes.push({ category: 'content', key: item.key, name: item.name, action: item.action, status: 'failed', pass: round - 1, error: `still present after ${MAX_CONTENT_ROUNDS} delete rounds`, at });
      }
      return;
    }
    options.onContentRound?.(round, remaining.length);
    outcomes.push(...(await runStep(client, 'content', remaining, options)));
  }
}

async function runStep(client: CmsClient, category: Category, items: PlanItem[], options: PurgeOptions): Promise<Outcome[]> {
  const concurrency = options.concurrency ?? 4;
  const outcomes: Outcome[] = [];
  const record = (item: PlanItem, status: Status, pass: number, error?: unknown) =>
    outcomes.push({
      category,
      key: item.key,
      name: item.name,
      action: item.action,
      status,
      pass,
      httpStatus: error instanceof ApiError ? error.status : undefined,
      error: error === undefined ? undefined : describe(error),
      at: new Date().toISOString(),
    });

  let pending = items;
  for (let pass = 1; pending.length && pass <= MAX_PASSES; pass++) {
    const failures: { item: PlanItem; error: unknown }[] = [];
    for (const batch of batches(category, pending)) {
      await mapLimit(batch, concurrency, async (item) => {
        try {
          await apply(client, item);
          record(item, 'done', pass);
        } catch (err) {
          // Already gone, e.g. removed together with its container.
          if (err instanceof ApiError && err.status === 404 && item.action === 'delete') record(item, 'gone', pass);
          else failures.push({ item, error: err });
        }
        options.onProgress?.({ category, done: outcomes.length, total: items.length, pass });
      });
    }

    // Access denied won't change between passes, and neither does anything else if nothing moved.
    const noProgress = failures.length === pending.length || failures.every((f) => isForbidden(f.error));
    if (noProgress || pass === MAX_PASSES) {
      for (const f of failures) record(f.item, 'failed', pass, f.error);
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

export const isForbidden = (err: unknown) => err instanceof ApiError && err.status === 403;

function describe(err: unknown): string {
  if (!(err instanceof ApiError)) return String(err instanceof Error ? err.message : err);
  const body = err.body as { title?: string; detail?: string; code?: string } | undefined;
  return [err.status, err.code, body?.detail ?? body?.title].filter(Boolean).join(' ');
}

/** Turns an error message into a groupable reason by removing item-specific keys. */
export function reasonOf(error: string | undefined): string {
  return (error ?? 'unknown error').replace(/'[^']*'/g, "'…'").replace(/\b[0-9a-f]{32}\b/g, '…');
}
