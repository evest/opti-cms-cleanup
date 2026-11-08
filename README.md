# opti-cms-cleanup

CLI to inventory and purge content, content types and settings in an Optimizely SaaS CMS environment
(Test1, Test2 or Production), using the CMS REST API v1.

## Setup

1. `npm install`
2. Copy `profiles.example.json` to `profiles.json` and add one profile per instance environment.
3. Copy `.env.example` to `.env` and add each profile's API key (CMS: Settings > API Keys).
   Variable names come from the profile name: `contentgurus-test1` → `CONTENTGURUS_TEST1_CLIENT_ID` / `CONTENTGURUS_TEST1_CLIENT_SECRET`.
4. Before a purge: in the CMS, Settings > Access Rights → root → give the API key **Administer** and tick
   **"Apply settings for all subitems"**. Without it, content deletes fail with 403.

## Usage

```sh
npm run cleanup -- profiles                         # list targets and whether credentials are set
npm run cleanup -- inventory -p contentgurus-test1  # read-only: what a purge would do
npm run cleanup -- inventory -p contentgurus-test1 -v   # ...listing every item
```

Each inventory is saved to `logs/<profile>-<timestamp>-inventory.json`.

## What a purge does

See `docs/api-notes.md` for the verified API behaviour and the deletion order. In short:

- **Deleted:** all content (pages, blocks, media, folders), blueprints, display templates, content type bindings,
  custom content types, custom property groups (tabs) and applications.
- **Kept:** system containers, built-in types, tabs and content sources (anything with a `source`, and DAM/global-contract sources).
- **Locales:** never deleted. `en` stays enabled; all others are disabled.
- **Manual:** property formats (read-only in the API), webhooks (Optimizely Graph) and API keys.

## After a purge

1. Reset Optimizely Graph so it drops the deleted content and types. Either one is enough:
   - run the scheduled job **"Optimizely Graph Full Synchronization"**, or
   - Settings > Data Sync & Management > Smooth Rebuild > **"Reset to Default"** (fully resets Graph).

   Neither is exposed by the CMS API, so the tool only reminds you.
2. Remove the API key's Administer access rights if they were only granted for the cleanup.
3. Review webhooks (Optimizely Graph) and API keys.

## Development

```sh
npm test            # unit tests (vitest)
npm run typecheck
npm run probe -- <profile>          # phase 0 API probe (read-only)
npm run probe:content -- <profile>  # content enumeration probe (read-only)
```
