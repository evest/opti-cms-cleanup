import type { PlanItem } from '../model.js';

export const defaultTypes = (items: PlanItem[]) => items.filter((i) => i.category === 'contenttypes' && i.type?.isDefault);

/**
 * Keeps the default content types instead of deleting them. Anything they depend on (content types and tabs their
 * properties point to, transitively) is kept too, because deleting it would fail while the kept type uses it.
 * Mutates the plan and returns warnings to show the user.
 */
export function keepDefaultTypes(items: PlanItem[]): string[] {
  const byKey = new Map(
    items.filter((i) => i.category === 'contenttypes' || i.category === 'propertygroups').map((i) => [`${i.category}:${i.key}`, i]),
  );
  const warnings: string[] = [];
  const queue: { item: PlanItem; keptFor: string }[] = [];

  for (const item of defaultTypes(items)) {
    item.action = 'skip';
    item.reason = 'default type, kept';
    queue.push({ item, keptFor: item.name ?? item.key });
    const props = item.type?.properties ?? [];
    if (props.length) {
      warnings.push(`${item.name ?? item.key} is kept as-is, but has properties added by the installation: ${props.join(', ')}`);
    }
  }

  const dependencies: string[] = [];
  while (queue.length) {
    const { item, keptFor } = queue.shift()!;
    for (const ref of item.type?.references ?? []) {
      for (const category of ['contenttypes', 'propertygroups']) {
        const dep = byKey.get(`${category}:${ref}`);
        if (!dep || dep.action !== 'delete') continue;
        dep.action = 'skip';
        dep.reason = `used by kept default type ${keptFor}`;
        dependencies.push(`${dep.name ?? dep.key} (${category === 'propertygroups' ? 'tab' : 'type'})`);
        queue.push({ item: dep, keptFor });
      }
    }
  }
  if (dependencies.length) {
    warnings.push(`Also kept, because the kept default types use them: ${dependencies.join(', ')}`);
  }
  return warnings;
}
