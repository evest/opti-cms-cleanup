import { describe, expect, it } from 'vitest';
import type { ContentGroup, PlanItem } from '../model.js';
import { batches } from './purge.js';

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
