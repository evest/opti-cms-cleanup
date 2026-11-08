#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { CmsClient } from './api/client.js';
import { credentialEnvNames, getProfile, loadProfiles } from './config/profiles.js';
import { buildInventory } from './engine/inventory.js';
import { confirm, verifyTarget } from './engine/preflight.js';
import { AccessDeniedError, purge, type Outcome } from './engine/purge.js';
import { CATEGORIES, type Category } from './model.js';
import { printDetails, printLabel, printOutcomes, printSummary, printTarget } from './report/print.js';
import { saveCsv, saveReport } from './report/save.js';

const program = new Command()
  .name('cleanup')
  .description('Inventory and purge content, types and settings in an Optimizely SaaS CMS environment');

program
  .command('profiles')
  .description('List configured target profiles and whether their credentials are set')
  .action(() => {
    const profiles = Object.entries(loadProfiles());
    if (!profiles.length) {
      console.log('No profiles in profiles.json');
      return;
    }
    for (const [name, p] of profiles) {
      const { clientIdEnv, clientSecretEnv } = credentialEnvNames(name, p);
      const ok = process.env[clientIdEnv] && process.env[clientSecretEnv];
      const creds = ok ? pc.green('credentials set') : pc.red(`missing ${clientIdEnv} / ${clientSecretEnv}`);
      const env = p.environment === 'Production' ? pc.red(p.environment) : p.environment;
      console.log(`${pc.bold(name.padEnd(24))} ${p.instance} / ${env}  ${pc.dim(p.cmsUrl)}  ${creds}`);
    }
  });

program
  .command('inventory')
  .description('Read-only: list everything in the environment and what a purge would do with it')
  .requiredOption('-p, --profile <name>', 'target profile from profiles.json')
  .option('-v, --verbose', 'list every item, not just the summary')
  .action(async (opts: { profile: string; verbose?: boolean }) => {
    const profile = getProfile(opts.profile);
    printTarget(profile);
    const client = new CmsClient(profile);
    await verifyTarget(client);

    console.log(pc.dim('Scanning environment...\n'));
    const inventory = await buildInventory(client);

    printSummary(inventory);
    if (opts.verbose) printDetails(inventory);

    const path = saveReport(profile.name, 'inventory', inventory);
    console.log(pc.dim(`\nFull inventory saved to ${path}`));
  });

const PURGEABLE: Category[] = CATEGORIES.filter((c) => c !== 'manual');

program
  .command('purge')
  .description('Delete content, types and settings. Dry run unless --execute is given')
  .requiredOption('-p, --profile <name>', 'target profile from profiles.json')
  .option('--execute', 'actually apply the changes (default is a dry run)')
  .option('--only <categories>', `comma-separated subset of: ${PURGEABLE.join(', ')}`)
  .option('--trash-emptied', 'skip the "have you emptied the trash?" question')
  .option('-y, --yes', 'skip the final "proceed?" question')
  .option('-c, --concurrency <n>', 'parallel requests per batch', '4')
  .action(
    async (opts: { profile: string; execute?: boolean; only?: string; trashEmptied?: boolean; yes?: boolean; concurrency: string }) => {
      const only = parseOnly(opts.only);
      const profile = getProfile(opts.profile);
      printTarget(profile);
      const client = new CmsClient(profile);
      await verifyTarget(client);

      console.log(pc.dim('Scanning environment...\n'));
      const inventory = await buildInventory(client);
      if (only) inventory.items = inventory.items.filter((i) => only.includes(i.category));
      printSummary(inventory);
      saveReport(profile.name, 'inventory', inventory);

      const actionable = inventory.items.filter((i) => ['delete', 'disable', 'enable'].includes(i.action));
      if (!actionable.length) {
        console.log(pc.green('\nNothing to do.'));
        return;
      }
      if (!opts.execute) {
        console.log(pc.yellow(`\nDry run: ${actionable.length} change(s) would be made. Re-run with --execute to apply them.`));
        return;
      }

      console.log();
      if (!opts.trashEmptied) {
        console.log('The CMS API cannot reliably find content in the trash, so empty it in the CMS UI first.');
        if (!(await confirm('Have you emptied the trash for this environment?'))) return abort();
      }
      const where = `${profile.instance} / ${profile.environment}`;
      if (!opts.yes && !(await confirm(pc.bold(`Permanently apply ${actionable.length} change(s) to ${where}?`)))) return abort();

      console.log();
      const clearLine = () => process.stdout.isTTY && process.stdout.write('\r\x1b[K');
      const outcomes: Outcome[] = [];
      try {
        await purge(client, inventory.items, {
          concurrency: Number(opts.concurrency) || 4,
          onProgress: (p) => {
            if (process.stdout.isTTY) process.stdout.write(`\r${printLabel(p.category)}: ${p.done}/${p.total} (pass ${p.pass})   `);
          },
          onStepDone: (category, stepOutcomes) => {
            clearLine();
            outcomes.push(...stepOutcomes);
            printOutcomes(category, stepOutcomes);
          },
        });
      } catch (err) {
        if (!(err instanceof AccessDeniedError)) throw err;
        clearLine();
        console.error(pc.red(`\n${err.message}`));
        process.exitCode = 1;
      } finally {
        if (outcomes.length) {
          saveReport(profile.name, 'purge-log', outcomes);
          const csv = saveCsv(profile.name, 'purge-log', outcomes, ['category', 'key', 'name', 'action', 'status', 'pass', 'error', 'at']);
          console.log(pc.dim(`\nLog saved to ${csv} (and .json)`));
        }
      }
      if (process.exitCode) return;

      console.log(pc.bold('\nAfter purge:\n'));
      const after = await buildInventory(client);
      if (only) after.items = after.items.filter((i) => only.includes(i.category));
      printSummary(after);
      saveReport(profile.name, 'inventory-after', after);
      printNextSteps();
    },
  );

/** Follow-up work the API cannot do; shown after every executed purge. */
function printNextSteps() {
  console.log(pc.bold('\nRecommended next steps in the CMS UI:'));
  console.log('  1. Reset Optimizely Graph so it drops the deleted content and types. Either one is enough:');
  console.log('     - run the scheduled job "Optimizely Graph Full Synchronization", or');
  console.log('     - Settings > Data Sync & Management > Smooth Rebuild > "Reset to Default" (full Graph reset)');
  console.log("  2. Remove the API key's Administer access rights on the root if they were only granted for this cleanup.");
  console.log('  3. Review webhooks (Optimizely Graph) and API keys; they are not managed through the CMS API.');
}

function parseOnly(value: string | undefined): Category[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const invalid = parts.filter((p) => !PURGEABLE.includes(p as Category));
  if (invalid.length) throw new Error(`Unknown --only value(s): ${invalid.join(', ')}. Use: ${PURGEABLE.join(', ')}`);
  return parts as Category[];
}

function abort() {
  console.log(pc.yellow('Aborted. Nothing was changed.'));
}

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
