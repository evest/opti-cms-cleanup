# Cleanup for Optimizely SaaS CMS

A command-line tool that **wipes** an **Optimizely SaaS CMS** environment back to a near-empty state:
content, content types, display templates, tabs and other settings, through the CMS REST API.

Useful for resetting demo, training and test instances, or for preparing an environment for a fresh
content model. Every instance has three environments (Test1, Test2, Production), and the tool targets
the one you choose.

> [!WARNING]
> A purge **permanently deletes** data. It does not move items to the trash and cannot be undone.
> Always run a dry run first and check the target shown at the top of the output.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Setup](#setup)
- [Usage](#usage)
- [What gets deleted and what is kept](#what-gets-deleted-and-what-is-kept)
- [After a purge](#after-a-purge)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Features

- **One profile per environment.** Point at `acme-test1`, `acme-prod` and so on; secrets stay in `.env`.
- **Target verification.** The API token reveals which instance the credentials belong to; the tool refuses to
  run if that doesn't match the profile's CMS URL.
- **Read-only inventory.** See everything in the environment and exactly what a purge would do with each item.
- **Dry run by default.** Nothing changes unless you pass `--execute` and confirm.
- **Built-ins are left alone.** System containers, built-in content types, system tabs and DAM content sources are skipped.
- **Dependency-aware ordering with retries.** Content goes first, then templates, types and tabs; failures are retried
  in later passes.
- **Full audit log.** Every item's outcome is written to `logs/` as CSV and JSON.

## Requirements

- Node.js 22 or later
- An Optimizely SaaS CMS instance and an **API key** for each environment you want to target
- For a purge, the API key needs **Administer** access rights on the content root (see [Setup](#setup), step 4)

## Setup

1. **Install dependencies**

   ```sh
   npm install
   ```

2. **Create an API key** in the CMS for the environment: **Settings > API Keys**. Note the client ID and secret.

3. **Add a profile and its credentials**

   ```sh
   cp profiles.example.json profiles.json
   cp .env.example .env
   ```

   `profiles.json` describes the targets (no secrets):

   ```json
   {
     "acme-test1": {
       "instance": "Acme",
       "environment": "Test1",
       "cmsUrl": "https://app-acmetest1.cms.optimizely.com"
     }
   }
   ```

   `environment` is one of `Test1`, `Test2` or `Production`. `cmsUrl` must be the environment's CMS URL;
   it is checked against the API key before anything runs.

   `.env` holds the secrets. Variable names are derived from the profile name, uppercased with `-` turned into `_`:

   ```sh
   ACME_TEST1_CLIENT_ID=...
   ACME_TEST1_CLIENT_SECRET=...
   ```

   To use different variable names, set `clientIdEnv` / `clientSecretEnv` in the profile.
   Both `profiles.json` and `.env` are gitignored.

4. **Grant delete rights (needed for a purge only).** In the CMS go to **Settings > Access Rights**, select the root,
   give the API key **Administer**, and tick **"Apply settings for all subitems"** when saving. This covers all content,
   including the Recycle Bin. Without it, content deletes fail with `403 Forbidden`.

5. **Check the setup**

   ```sh
   npm run cleanup -- profiles
   ```

## Usage

```sh
npm run cleanup -- <command> [options]
```

### `profiles`

Lists configured profiles and whether their credentials are set.

### `inventory`

A read-only scan showing everything in the environment and what a purge would do.

```sh
npm run cleanup -- inventory -p acme-test1       # summary
npm run cleanup -- inventory -p acme-test1 -v    # every item, with its reason
```

```
Target: Acme / Test1  (profile: acme-test1)
        https://app-acmetest1.cms.optimizely.com

                        total  delete  disable  enable  skip  none  manual
Content                    61      61
Blueprints                  0
Display templates          47      47
Content type bindings       0
Content sources             9                              9
Content types              51      30                     21
Property groups (tabs)     23      17                      6
Applications                0
Locales                    14                3                  11
Manual steps                9                                            9

Content by deletion group: pages 18, blocks 8, media 27, folders 8
```

### `purge`

Applies the changes. **Dry run unless `--execute` is given.**

```sh
npm run cleanup -- purge -p acme-test1                       # dry run
npm run cleanup -- purge -p acme-test1 --execute             # apply, with confirmations
npm run cleanup -- purge -p acme-test1 --execute --only content,displaytemplates
```

| Option | Description |
|---|---|
| `-p, --profile <name>` | Target profile from `profiles.json` (required) |
| `--execute` | Apply the changes. Without it, the command only reports what would happen |
| `--only <categories>` | Comma-separated subset: `content`, `blueprints`, `displaytemplates`, `contenttypebindings`, `contentsources`, `contenttypes`, `propertygroups`, `applications`, `locales` |
| `--trash-emptied` | Skip the "have you emptied the trash?" question |
| `-y, --yes` | Skip the final confirmation |
| `-c, --concurrency <n>` | Parallel requests per batch (default 4) |

Before applying anything, `purge --execute`:

1. verifies the API key belongs to the profile's CMS URL,
2. scans the environment fresh and shows the summary,
3. asks you to **empty the trash in the CMS UI** first, because the API cannot reliably find content in the trash,
4. asks for a final confirmation.

A Production profile is highlighted in red. Afterwards the tool rescans the environment, prints what is left
and lists the [follow-up steps](#after-a-purge).

```
✓ Content: 56 done
✓ Display templates: 47 done
✓ Content types: 30 done
✓ Property groups (tabs): 17 done
✓ Locales: 3 done

Log saved to logs/acme-test1-2026-11-08T21-06-21-120Z-purge-log.csv (and .json)
```

## What gets deleted and what is kept

| Resource | Purge action |
|---|---|
| Content: pages, experiences, blocks, media, folders | **Deleted permanently** |
| Blueprints | **Deleted** |
| Display templates | **Deleted** |
| Content type bindings | **Deleted** |
| Content types | **Deleted** when custom. Built-in types (those with a `source`, e.g. `_system`, `globalcontract`, `graph`) are kept |
| Property groups (tabs) | **Deleted** when custom. System tabs (Content, Settings, Scheduling, ...) are kept |
| Applications | **Deleted** when custom |
| Content sources | Built-in DAM and global-contract sources are kept; others are deleted |
| Locales | **Never deleted.** `en` stays enabled (or is enabled); all other locales are disabled |
| System containers (root, "For All Sites") | Kept |
| Property formats | Listed only: read-only in the API |
| Webhooks, API keys | Listed only: not managed through the CMS API |

## After a purge

These steps can't be done through the CMS API, so the tool only reminds you:

1. **Reset Optimizely Graph** so it drops the deleted content and types. Either one is enough:
   - run the scheduled job **"Optimizely Graph Full Synchronization"**, or
   - **Settings > Data Sync & Management > Smooth Rebuild > "Reset to Default"** (fully resets Graph).
2. **Remove the API key's Administer access rights** if they were only granted for the cleanup.
3. **Review webhooks** (managed in Optimizely Graph) **and API keys.**

## How it works

- **Authentication:** OAuth client credentials against `https://api.cms.optimizely.com/oauth/token`. Tokens last
  5 minutes and are refreshed automatically. The token's `siteUrl` claim is used for target verification.
- **Finding content:** there is no "list all content" endpoint. The tool walks the tree from both system roots
  (the site root and "For All Sites", which the root does not list as a child), then cross-checks against the
  instance-wide version listings (localized and locale-neutral). Items found only in the cross-check are added.
- **Deletion order:**
  1. Content, with items that reference others before what they reference: pages and experiences, then shared
     blocks, then media, then folders, deepest items first.
  2. Blueprints.
  3. Display templates.
  4. Content type bindings and content sources.
  5. Content types.
  6. Property groups.
  7. Applications.
  8. Locales: enable the default, then disable the rest.
- **Retries:** failed items are retried in up to 5 passes until no more progress is made, which handles
  types that reference each other. Items already removed with their folder are logged as "already gone".
  HTTP 429 and 5xx responses are retried with backoff.

Verified API behaviour, edge cases and the evidence behind these choices are in [`docs/api-notes.md`](docs/api-notes.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing ACME_TEST1_CLIENT_ID and/or ACME_TEST1_CLIENT_SECRET` | The `.env` variable names don't match the profile name. They must be uppercase with `_`, e.g. `ACME_TEST1_CLIENT_ID` |
| `Profile "x" expects <url>, but its API key belongs to <url>` | The credentials in `.env` are for a different environment than `cmsUrl` in `profiles.json` |
| `The API key is not allowed to delete content (403)` | Grant the API key Administer on the root, with "Apply settings for all subitems" (see [Setup](#setup), step 4) |
| `Token request failed: 401` | Wrong client ID or secret, or the API key was deleted |
| Content still appears on the site or in Graph queries | Reset Optimizely Graph (see [After a purge](#after-a-purge)) |

## Development

```sh
npm test              # unit tests (vitest)
npm run typecheck     # tsc --noEmit
npm run probe -- <profile>           # read-only API probe: downloads the OpenAPI spec and lists all resources
npm run probe:content -- <profile>   # read-only comparison of content enumeration strategies
```

The probes write to `probe-output/` (gitignored). The authenticated OpenAPI spec is available at
`GET https://api.cms.optimizely.com/v1/docs/content-openapi.json`.

### Project structure

```
src/
  cli.ts                  commands: profiles, inventory, purge
  model.ts                categories, actions, plan items
  rules.ts                what is built-in / skipped, locale rules, content grouping
  config/profiles.ts      profiles.json + .env loading
  api/auth.ts             token retrieval, refresh and claims
  api/client.ts           HTTP client with retries and paging
  resources/content.ts    content enumeration (tree walk + versions cross-check)
  engine/inventory.ts     builds the plan for all categories
  engine/purge.ts         ordered execution with retry passes
  engine/preflight.ts     target verification and confirmations
  report/                 console output, JSON and CSV logs
scripts/                  read-only API probes
docs/api-notes.md         verified API behaviour
```

## License

[MIT](LICENSE)
