import { describe, expect, it } from 'vitest';
import { ApiError, type CmsClient } from '../api/client.js';
import type { ContentGroup, PlanItem } from '../model.js';
import { batches, purge, reasonOf } from './purge.js';

const content = (key: string, group: ContentGroup, depth: number): PlanItem => ({
  category: 'content',
  key,
  action: 'delete',
  content: { contentType: 'X', group, depth },
});

describe('batches', () => {
  it('orders content by group (pages, blocks, media, folders), deepest first within a group', () => {
    const items = [
      content('folder1', 'folders', 1),
      content('img', 'media', 2),
      content('start', 'pages', 1),
      content('folder2', 'folders', 2),
      content('child', 'pages', 3),
      content('block', 'blocks', 2),
      content('mid', 'pages', 2),
    ];
    expect(batches('content', items).map((b) => b.map((i) => i.key))).toEqual([
      ['child'],
      ['mid'],
      ['start'],
      ['block'],
      ['img'],
      ['folder2'],
      ['folder1'],
    ]);
  });

  it('keeps items of the same group and depth in one parallel batch', () => {
    const items = [content('a', 'media', 2), content('b', 'media', 2)];
    expect(batches('content', items)).toHaveLength(1);
  });

  it('enables the default locale before disabling others', () => {
    const items: PlanItem[] = [
      { category: 'locales', key: 'no', action: 'disable' },
      { category: 'locales', key: 'en', action: 'enable' },
    ];
    expect(batches('locales', items).map((b) => b.map((i) => i.key))).toEqual([['en'], ['no']]);
  });

  it('runs other categories as a single batch', () => {
    const items: PlanItem[] = [
      { category: 'contenttypes', key: 'A', action: 'delete' },
      { category: 'contenttypes', key: 'B', action: 'delete' },
    ];
    expect(batches('contenttypes', items)).toHaveLength(1);
  });
});

const fakeClient = (fail: (method: string, path: string) => ApiError | undefined) => {
  const calls: string[] = [];
  const client = {
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const err = fail(method, path);
      if (err) throw err;
      return undefined;
    },
  } as unknown as CmsClient;
  return { client, calls };
};

const plan: PlanItem[] = [
  { category: 'contenttypes', key: 'ArticlePage', action: 'delete' },
  content('page', 'pages', 1),
  { category: 'applications', key: 'site', action: 'delete' },
  { category: 'locales', key: 'no', action: 'disable' },
];

describe('purge', () => {
  it('deletes applications before content, and content before types', async () => {
    const { client, calls } = fakeClient(() => undefined);
    const result = await purge(client, plan);
    expect(result.stoppedAfter).toBeUndefined();
    expect(calls).toEqual([
      'DELETE /applications/site',
      'DELETE /content/page',
      'DELETE /contenttypes/ArticlePage',
      'PATCH /locales/no',
    ]);
  });

  it('stops after content when any content item fails, leaving types and locales untouched', async () => {
    const { client, calls } = fakeClient((method, path) =>
      path.startsWith('/content/') ? new ApiError(403, method, path, { detail: 'Access was denied' }) : undefined,
    );
    const result = await purge(client, plan);
    expect(result.stoppedAfter).toBe('content');
    expect(calls).not.toContain('DELETE /contenttypes/ArticlePage');
    expect(calls).not.toContain('PATCH /locales/no');
    expect(result.outcomes.find((o) => o.key === 'page')).toMatchObject({ status: 'failed', httpStatus: 403 });
  });

  it('does not retry access-denied failures', async () => {
    const { client, calls } = fakeClient((method, path) =>
      path === '/content/page' ? new ApiError(403, method, path, {}) : undefined,
    );
    const items = [content('page', 'pages', 1), content('other', 'pages', 1)];
    await purge(client, items);
    expect(calls.filter((c) => c === 'DELETE /content/page')).toHaveLength(1);
  });

  it('treats 404 on delete as already gone', async () => {
    const { client } = fakeClient((method, path) => new ApiError(404, method, path, {}));
    const result = await purge(client, [content('page', 'pages', 1)]);
    expect(result.outcomes[0]?.status).toBe('gone');
    expect(result.stoppedAfter).toBeUndefined();
  });
});

describe('reasonOf', () => {
  it('groups messages that differ only by keys and names', () => {
    const a = reasonOf("403 Access was denied to delete content with key '0a1b2c3d4e5f60718293a4b5c6d7e8f9'.");
    const b = reasonOf("403 Access was denied to delete content with key '1b2c3d4e5f60718293a4b5c6d7e8f90a'.");
    expect(a).toBe(b);
    expect(reasonOf("409 DependencyConflict Unable to delete content type 'Hero' as content instances of this type exist.")).toBe(
      reasonOf("409 DependencyConflict Unable to delete content type 'Card' as content instances of this type exist."),
    );
  });
});

describe('purge content rounds', () => {
  const types: PlanItem = { category: 'contenttypes', key: 'SiteSettings', action: 'delete' };

  it('deletes content that appears after the first round before moving on to types', async () => {
    const { client, calls } = fakeClient(() => undefined);
    const scans = [[content('orphan', 'blocks', 0)], []];
    const rounds: number[] = [];
    const result = await purge(client, [content('page', 'pages', 1), types], {
      rescanContent: async () => scans.shift() ?? [],
      onContentRound: (round) => rounds.push(round),
    });
    expect(calls).toEqual(['DELETE /content/page', 'DELETE /content/orphan', 'DELETE /contenttypes/SiteSettings']);
    expect(rounds).toEqual([2]);
    expect(result.stoppedAfter).toBeUndefined();
  });

  it('stops before types when content keeps reappearing', async () => {
    const { client, calls } = fakeClient(() => undefined);
    const result = await purge(client, [content('page', 'pages', 1), types], {
      rescanContent: async () => [content('stubborn', 'blocks', 0)],
    });
    expect(result.stoppedAfter).toBe('content');
    expect(calls).not.toContain('DELETE /contenttypes/SiteSettings');
    expect(result.outcomes.at(-1)).toMatchObject({ key: 'stubborn', status: 'failed', error: 'still present after 4 delete rounds' });
  });
});
