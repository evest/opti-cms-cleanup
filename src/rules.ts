import type { Action, ContentGroup } from './model.js';

/** Well-known system containers in SaaS CMS (verified, see docs/api-notes.md). */
export const ROOT_CONTAINER = '43f936c99b234ea397b261c538ad07c9';
export const FOR_ALL_SITES = 'e56f85d0e8334e02976a2d11fe4d598c';
export const SYSTEM_CONTAINERS = [ROOT_CONTAINER, FOR_ALL_SITES];

/** The only locale left enabled after a purge. */
export const DEFAULT_LOCALE = 'en';

/** Content sources of these types are built in (DAM via Graph, global contracts). */
const BUILT_IN_SOURCE_TYPES = new Set(['graph', 'globalcontract']);

type Decision = { action: Action; reason?: string };

/** Content types, property groups (tabs) and applications carry a `source` when created by the system. */
export function classifyBySource(item: { source?: string | null }): Decision {
  return item.source ? { action: 'skip', reason: `built-in (source: ${item.source})` } : { action: 'delete' };
}

export function classifyContentSource(item: { type?: string | null }): Decision {
  return item.type && BUILT_IN_SOURCE_TYPES.has(item.type)
    ? { action: 'skip', reason: `built-in (type: ${item.type})` }
    : { action: 'delete' };
}

export function classifyLocale(item: { key: string; isEnabled?: boolean | null }): Decision {
  if (item.key === DEFAULT_LOCALE) {
    return item.isEnabled ? { action: 'none', reason: 'default locale, stays enabled' } : { action: 'enable', reason: 'default locale' };
  }
  return item.isEnabled ? { action: 'disable' } : { action: 'none', reason: 'already disabled' };
}

export function contentGroupFor(baseType: string | undefined): ContentGroup {
  switch (baseType) {
    case '_page':
    case '_experience':
      return 'pages';
    case '_media':
    case '_image':
    case '_video':
      return 'media';
    case '_folder':
      return 'folders';
    default:
      // _component, _section, _element and anything unknown: treat as shared blocks
      return 'blocks';
  }
}
