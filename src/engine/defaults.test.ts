import { describe, expect, it } from 'vitest';
import type { PlanItem } from '../model.js';
import { keepDefaultTypes } from './defaults.js';
import { referencesOf } from './inventory.js';

const type = (key: string, isDefault: boolean, properties: string[] = [], references: string[] = []): PlanItem => ({
  category: 'contenttypes',
  key,
  name: key,
  action: 'delete',
  type: { isDefault, properties, references },
});

describe('keepDefaultTypes', () => {
  it('keeps default types and leaves other custom types for deletion', () => {
    const items = [type('BlankSection', true), type('Hero', false)];
    expect(keepDefaultTypes(items)).toEqual([]);
    expect(items.map((i) => i.action)).toEqual(['skip', 'delete']);
  });

  it('keeps types and tabs a kept default type depends on, transitively, and warns about added properties', () => {
    const items: PlanItem[] = [
      type('BlankExperience', true, ['SeoSettings', 'Admin'], ['PageSeoSettings', 'PageAdminSettings', 'SeoTab', 'Content']),
      type('PageSeoSettings', false, ['Meta'], ['MetaBlock']),
      type('MetaBlock', false),
      type('PageAdminSettings', false),
      type('Hero', false),
      { category: 'propertygroups', key: 'SeoTab', name: 'SEO', action: 'delete' },
      { category: 'propertygroups', key: 'Content', name: 'Content', action: 'skip', reason: 'built-in' },
    ];
    const warnings = keepDefaultTypes(items);

    const action = (key: string) => items.find((i) => i.key === key)?.action;
    expect(action('BlankExperience')).toBe('skip');
    expect(action('PageSeoSettings')).toBe('skip');
    expect(action('MetaBlock')).toBe('skip');
    expect(action('PageAdminSettings')).toBe('skip');
    expect(action('SeoTab')).toBe('skip');
    expect(action('Hero')).toBe('delete');
    expect(items.find((i) => i.key === 'Content')?.reason).toBe('built-in');
    expect(items.find((i) => i.key === 'MetaBlock')?.reason).toBe('used by kept default type BlankExperience');
    expect(warnings[0]).toContain('BlankExperience is kept as-is, but has properties added by the installation: SeoSettings, Admin');
    expect(warnings[1]).toContain('PageSeoSettings (type)');
    expect(warnings[1]).toContain('SEO (tab)');
  });
});

describe('referencesOf', () => {
  it('collects referenced types and tabs, not display names or formats', () => {
    const refs = referencesOf({
      Seo: { type: 'component', contentType: 'PageSeoSettings', displayName: 'Image', group: 'SeoTab', allowedTypes: [] },
      Cards: { type: 'array', displayName: 'Cards', items: { type: 'content', allowedTypes: ['Card'], restrictedTypes: ['Hero'] } },
      Alt: { type: 'string', format: 'shortString', displayName: 'Alt text', group: 'Content' },
    });
    expect(refs.sort()).toEqual(['Card', 'Content', 'Hero', 'PageSeoSettings', 'SeoTab']);
  });
});
