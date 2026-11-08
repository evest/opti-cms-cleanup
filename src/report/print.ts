import pc from 'picocolors';
import type { Profile } from '../config/profiles.js';
import type { Outcome } from '../engine/purge.js';
import { CATEGORIES, CONTENT_GROUPS, type Action, type Inventory, type PlanItem } from '../model.js';

const ACTIONS: Action[] = ['delete', 'disable', 'enable', 'skip', 'none', 'manual'];

const LABELS: Record<string, string> = {
  content: 'Content',
  blueprints: 'Blueprints',
  displaytemplates: 'Display templates',
  contenttypebindings: 'Content type bindings',
  contentsources: 'Content sources',
  contenttypes: 'Content types',
  propertygroups: 'Property groups (tabs)',
  applications: 'Applications',
  locales: 'Locales',
  manual: 'Manual steps',
};

const colorAction = (action: Action, text: string) =>
  ({ delete: pc.red, disable: pc.yellow, enable: pc.green, skip: pc.dim, none: pc.dim, manual: pc.cyan })[action](text);

export function printTarget(profile: Pick<Profile, 'name' | 'instance' | 'environment' | 'cmsUrl'>): void {
  const line = `${profile.instance} / ${profile.environment}  (profile: ${profile.name})`;
  console.log();
  if (profile.environment === 'Production') {
    console.log(pc.bgRed(pc.white(pc.bold(`  PRODUCTION  ${line}  `))));
  } else {
    console.log(pc.bold(`Target: ${line}`));
  }
  console.log(pc.dim(`        ${profile.cmsUrl}`));
  console.log();
}

export function printSummary(inv: Inventory): void {
  const rows = CATEGORIES.map((category) => {
    const items = inv.items.filter((i) => i.category === category);
    const counts = Object.fromEntries(ACTIONS.map((a) => [a, items.filter((i) => i.action === a).length]));
    return { category, total: items.length, counts };
  });

  const header = ['', 'total', ...ACTIONS];
  const body = rows.map((r) => [LABELS[r.category]!, String(r.total), ...ACTIONS.map((a) => (r.counts[a] ? String(r.counts[a]) : ''))]);
  const widths = header.map((h, col) => Math.max(h.length, ...body.map((row) => row[col]!.length)));
  const fmt = (cells: string[]) => cells.map((c, col) => (col === 0 ? c.padEnd(widths[col]!) : c.padStart(widths[col]!))).join('  ');

  console.log(pc.bold(fmt(header)));
  for (const row of body) {
    console.log(
      row
        .map((c, col) => {
          const padded = col === 0 ? c.padEnd(widths[col]!) : c.padStart(widths[col]!);
          return col >= 2 && c ? colorAction(ACTIONS[col - 2]!, padded) : padded;
        })
        .join('  '),
    );
  }

  const content = inv.items.filter((i) => i.category === 'content');
  if (content.length) {
    const byGroup = CONTENT_GROUPS.map((g) => `${g} ${content.filter((i) => i.content?.group === g).length}`).join(', ');
    console.log(pc.dim(`\nContent by deletion group: ${byGroup}`));
  }
  for (const note of inv.notes) console.log(pc.yellow(`Note: ${note}`));
}

export function printDetails(inv: Inventory): void {
  for (const category of CATEGORIES) {
    const items = inv.items.filter((i) => i.category === category);
    if (!items.length) continue;
    console.log(pc.bold(`\n${LABELS[category]} (${items.length})`));
    for (const item of sortForDisplay(items)) {
      const action = colorAction(item.action, item.action.padEnd(7));
      const extra = item.content ? pc.dim(` [${item.content.contentType}, ${item.content.group}, depth ${item.content.depth}]`) : '';
      const reason = item.reason ? pc.dim(` - ${item.reason}`) : '';
      console.log(`  ${action} ${item.name ?? item.key}${item.name ? pc.dim(` (${item.key})`) : ''}${extra}${reason}`);
    }
  }
}

export const printLabel = (category: string) => LABELS[category] ?? category;

/** One line per purge step, plus every failure with its reason. */
export function printOutcomes(category: string, outcomes: Outcome[]): void {
  const count = (s: Outcome['status']) => outcomes.filter((o) => o.status === s).length;
  const passes = Math.max(...outcomes.map((o) => o.pass));
  const parts = [
    pc.green(`${count('done')} done`),
    count('gone') ? pc.dim(`${count('gone')} already gone`) : '',
    count('failed') ? pc.red(`${count('failed')} failed`) : '',
    passes > 1 ? pc.dim(`${passes} passes`) : '',
  ].filter(Boolean);
  const icon = count('failed') ? pc.red('✗') : pc.green('✓');
  console.log(`${icon} ${printLabel(category)}: ${parts.join(', ')}`);
  for (const o of outcomes.filter((o) => o.status === 'failed')) {
    console.log(pc.red(`    ${o.name ?? o.key}${o.name ? pc.dim(` (${o.key})`) : ''}: ${o.error}`));
  }
}

function sortForDisplay(items: PlanItem[]): PlanItem[] {
  return [...items].sort(
    (a, b) =>
      ACTIONS.indexOf(a.action) - ACTIONS.indexOf(b.action) ||
      (a.content && b.content ? CONTENT_GROUPS.indexOf(a.content.group) - CONTENT_GROUPS.indexOf(b.content.group) : 0) ||
      (a.name ?? a.key).localeCompare(b.name ?? b.key),
  );
}
