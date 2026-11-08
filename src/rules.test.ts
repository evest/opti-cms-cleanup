import { describe, expect, it } from 'vitest';
import { classifyBySource, classifyContentSource, classifyLocale, contentGroupFor } from './rules.js';

describe('classifyBySource', () => {
  it('deletes items without a source', () => {
    expect(classifyBySource({}).action).toBe('delete');
    expect(classifyBySource({ source: null }).action).toBe('delete');
  });

  it.each(['_system', 'globalcontract', 'graph'])('skips items with source %s', (source) => {
    expect(classifyBySource({ source })).toEqual({ action: 'skip', reason: `built-in (source: ${source})` });
  });
});

describe('classifyContentSource', () => {
  it.each(['graph', 'globalcontract'])('skips built-in %s sources', (type) => {
    expect(classifyContentSource({ type }).action).toBe('skip');
  });

  it('deletes other sources', () => {
    expect(classifyContentSource({ type: 'custom' }).action).toBe('delete');
  });
});

describe('classifyLocale', () => {
  it('keeps en enabled, or enables it', () => {
    expect(classifyLocale({ key: 'en', isEnabled: true }).action).toBe('none');
    expect(classifyLocale({ key: 'en', isEnabled: false }).action).toBe('enable');
  });

  it('disables other enabled locales and leaves disabled ones alone', () => {
    expect(classifyLocale({ key: 'no', isEnabled: true }).action).toBe('disable');
    expect(classifyLocale({ key: 'de', isEnabled: false }).action).toBe('none');
  });

  it('never deletes a locale', () => {
    for (const isEnabled of [true, false]) {
      for (const key of ['en', 'sv']) expect(classifyLocale({ key, isEnabled }).action).not.toBe('delete');
    }
  });
});

describe('contentGroupFor', () => {
  it.each([
    ['_page', 'pages'],
    ['_experience', 'pages'],
    ['_component', 'blocks'],
    ['_section', 'blocks'],
    [undefined, 'blocks'],
    ['_media', 'media'],
    ['_image', 'media'],
    ['_video', 'media'],
    ['_folder', 'folders'],
  ] as const)('%s -> %s', (baseType, group) => {
    expect(contentGroupFor(baseType)).toBe(group);
  });
});
