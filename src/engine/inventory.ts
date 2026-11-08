import type { CmsClient } from '../api/client.js';
import type { Category, Inventory, PlanItem } from '../model.js';
import { enumerateContent } from '../resources/content.js';
import { classifyBySource, classifyContentSource, classifyLocale } from '../rules.js';

interface Resource {
  key: string;
  displayName?: string;
  source?: string | null;
  type?: string | null;
  isEnabled?: boolean | null;
  baseType?: string;
}

/** Builds the full, read-only picture of what a purge would do. */
export async function buildInventory(client: CmsClient): Promise<Inventory> {
  const { profile } = client;
  const list = (path: string) => client.getAll<Resource>(path);

  const [contentTypes, blueprints, displayTemplates, bindings, sources, propertyGroups, applications, locales, formats] =
    await Promise.all([
      list('/contenttypes'),
      list('/blueprints'),
      list('/displaytemplates'),
      list('/contenttypebindings'),
      list('/contentsources'),
      list('/propertygroups'),
      list('/applications'),
      list('/locales'),
      list('/propertyformats'),
    ]);

  const baseTypes = new Map(contentTypes.map((t) => [t.key, t.baseType]));
  const content = await enumerateContent(client, baseTypes);

  const item = (category: Category, r: Resource, decision: Pick<PlanItem, 'action' | 'reason'>): PlanItem => ({
    category,
    key: r.key,
    name: r.displayName,
    ...decision,
  });

  const items: PlanItem[] = [
    ...content.items,
    ...blueprints.map((r) => item('blueprints', r, { action: 'delete' })),
    ...displayTemplates.map((r) => item('displaytemplates', r, { action: 'delete' })),
    ...bindings.map((r) => item('contenttypebindings', r, { action: 'delete' })),
    ...sources.map((r) => item('contentsources', r, classifyContentSource(r))),
    ...contentTypes.map((r) => item('contenttypes', r, classifyBySource(r))),
    ...propertyGroups.map((r) => item('propertygroups', r, classifyBySource(r))),
    ...applications.map((r) => item('applications', r, classifyBySource(r))),
    ...locales.map((r) => item('locales', r, classifyLocale(r))),
    ...formats.map((r) =>
      item('manual', { ...r, displayName: `Property format: ${r.displayName ?? r.key}` }, { action: 'manual', reason: 'read-only in the API' }),
    ),
    {
      category: 'manual',
      key: 'webhooks',
      name: 'Webhooks',
      action: 'manual',
      reason: 'managed in Optimizely Graph, not the CMS API',
    },
    { category: 'manual', key: 'api-keys', name: 'API keys', action: 'manual', reason: 'managed in the CMS UI (Settings > API Keys)' },
  ];

  return {
    profile: profile.name,
    instance: profile.instance,
    environment: profile.environment,
    cmsUrl: profile.cmsUrl,
    generatedAt: new Date().toISOString(),
    items,
    notes: content.notes,
  };
}
