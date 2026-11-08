/** Resource categories, in the order the purge engine processes them. */
export const CATEGORIES = [
  'content',
  'blueprints',
  'displaytemplates',
  'contenttypebindings',
  'contentsources',
  'contenttypes',
  'propertygroups',
  'applications',
  'locales',
  'manual',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * delete  - will be deleted
 * disable - will be disabled (locales)
 * enable  - will be enabled (the default locale, if disabled)
 * skip    - built-in/system, left untouched
 * none    - already in the desired state
 * manual  - cannot be changed via the API; listed for the user
 */
export type Action = 'delete' | 'disable' | 'enable' | 'skip' | 'none' | 'manual';

/** Content is deleted in this order so items that reference others go before what they reference. */
export const CONTENT_GROUPS = ['pages', 'blocks', 'media', 'folders'] as const;
export type ContentGroup = (typeof CONTENT_GROUPS)[number];

export interface PlanItem {
  category: Category;
  key: string;
  name?: string;
  action: Action;
  reason?: string;
  content?: {
    contentType: string;
    baseType?: string;
    group: ContentGroup;
    container?: string;
    /** Distance from a system root; deeper items are deleted first. */
    depth: number;
  };
}

export interface Inventory {
  profile: string;
  instance: string;
  environment: string;
  cmsUrl: string;
  generatedAt: string;
  items: PlanItem[];
  /** Notes about the enumeration itself, e.g. items found only via the versions cross-check. */
  notes: string[];
}
