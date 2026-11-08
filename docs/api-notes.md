# SaaS CMS REST API v1 — notes for the cleanup tool

Status: **verified** against a Test1 environment on 2026-11-08 with `npm run probe` and `npm run probe:content` (read-only).
Spec: `GET /v1/docs/content-openapi.json` ("Optimizely CMS REST API - Content v1.1"), saved by the probe under `probe-output/`.
Background evidence: the official CLI in [episerver/content-js-sdk](https://github.com/episerver/content-js-sdk). Docs: https://docs.optimizely.com/cms-saas/api/

## Auth
- `POST https://api.cms.optimizely.com/oauth/token`, JSON `{grant_type: "client_credentials", client_id, client_secret}` ✅
- Token lifetime 300 s. The API key (Settings > API Keys) determines the target.

## Access rights (required before a purge)
- The token's identity is the API client (`sub` = client ID) with scope `api:admin`. That covers settings
  (types, tabs, templates, locales), but **content deletes return 403** ("Access was denied to delete content")
  unless the API client has content access rights. Verified on a Test1 environment, both soft and permanent delete.
- Fix (per environment, in the CMS UI): Settings > Access Rights → root → give the API key **Administer**,
  tick **"Apply settings for all subitems"** when saving. This also covers the Recycle Bin (CMS id 2).
- Token claims include `siteUrl` and `instanceId` → the tool verifies `siteUrl` matches the profile's `cmsUrl`.

## Conventions
- Base `https://api.cms.optimizely.com/v1`
- Paging: `pageIndex` / `pageSize` (max 10000) → `{items, pageIndex, pageSize}`; `totalCount` was **absent** in practice, so stop on a short page.
- Errors are ProblemDetails (`title`, `status`, `code`, `traceId`). 429 sends `Retry-After`. `If-Match` optional on deletes.

## Resources (as found on a Test1 environment)
| Resource | Count | Delete | Built-in marker → skip |
|---|---|---|---|
| contenttypes | 51 | `DELETE /contenttypes/{key}` | `source` present: `globalcontract` (8), `graph` (12, DAM), `_system` (1: SysContentFolder). 30 custom have no `source` |
| displaytemplates | 47 | `DELETE /displaytemplates/{key}` | no `source` field; all custom |
| propertygroups | 23 | `DELETE /propertygroups/{key}` | `source: "_system"` (6: Content, Scheduling, Settings, Shortcut, Categories, DynamicBlocks) |
| contentsources | 9 | `DELETE /contentsources/{key}` | **all built-in** (`type` `graph` = DAM, `globalcontract`) → never delete. Only delete other `type`s if they ever appear |
| contenttypebindings | 0 | `DELETE /contenttypebindings/{key}` | — |
| blueprints | 0 (confirmed none on this instance) | `DELETE /blueprints/{key}` | fields `key, displayName, contentType, content`; reference a content type, so delete before types |
| applications | 0 | `DELETE /applications/{key}` | `source` field. None on the Test1 environment; 4 on the production environment, all custom (no `source`) and deleted fine |
| locales | 14 | **never deleted** — `PATCH /locales/{key}` `{"isEnabled": false}` (`Content-Type: application/merge-patch+json`) | no default/master flag; fields `key, displayName, isEnabled, routeSegment, sortOrder` |
| propertyformats | 7 | **none** (read-only) | report only |
| webhooks, API keys | — | **not in v1** | report as manual (webhooks belong to Optimizely Graph) |

## Content
- Delete: `DELETE /content/{key}` + header **`cms-permanent-delete: true`** (soft delete otherwise; `POST /content/{key}:undelete`).
- `GET /content/{key}` on a container returns only `{key, container, contentType, locales}`.

### Enumeration (verified, both strategies agree: 61 items)
1. **Tree walk** from root `43f936c99b234ea397b261c538ad07c9` **and** "For All Sites" `e56f85d0e8334e02976a2d11fe4d598c`, via `/content/{key}/items` (+ `/assets`, empty here).
   - Root `/items` **does not list "For All Sites"**, even with `contentTypes=SysContentFolder`, so it must be walked explicitly.
   - Root holds the site tree (start page `LandingPageExperience`); For All Sites holds shared folders, media, shared blocks.
2. **Instance-wide versions**: `GET /content/versions` (localized: 52 keys) **plus** `GET /content/versions?locales=NEUTRAL` (neutral: 35 keys) as **separate calls**.
   Combining `locales=en&...&locales=NEUTRAL` in one call returned only the localized set.
- Plan: walk the tree (gives `container` for leaves-first ordering) and cross-check against versions; anything only in versions is looked up with `GET /content/{key}` and appended.
- Wastebasket (`2f40ba47…`) and global assets (`99d57529…`) return **404**, so these CMS 12 keys don't exist in SaaS.
- The Recycle Bin (CMS id 2) is not reachable via the API (`/content/2` → 404), hence the "empty the trash first" step.
- System containers to skip: the root and For All Sites (both `SysContentFolder`/system). Folders under For All Sites are user-created and deletable.

## Verified by delete experiments (Test1 environment, 2026-11-08)
- **Deleting a folder permanently deletes its descendants** (folder and child both 404 afterwards, also with
  `cms-accept-resource: deleted`). The purge logs such children as "already gone".
- **Referenced content can be deleted**: an image used by a published block
  deleted without a conflict, leaving a broken reference. Order pages → blocks → media → folders is kept anyway.
- Full purge (2026-11-08): 56 content, 47 display templates, 30 content types, 17 property groups, 3 locales, all in a
  single pass with no failures and no 409s. Display templates and tabs delete fine in the documented order.

## Verified on a production environment (2026-11-08, run without access rights)
- Without content access rights every content delete returns 403, while settings (templates, types, tabs,
  applications, locales) can still be changed with `api:admin`. A purge must therefore check content access
  **before** touching anything, and stop if content can't be fully deleted.
- **Content that is an application's entry point can't be deleted** while the application exists:
  `400 InvalidOperation Cannot delete content ... is set as entry point for the 'x' application.` → applications go first.
- There is no API to read content access rights (`accessRights` exists only on content types and locales).
  The tool probes instead: `POST /content` a `SysContentFolder` under the root, then delete it permanently.
- `POST /content` returns **201 with an empty body**, so the caller must supply `key` (32 hex chars) to know
  what was created.
- Items listed in `/content/versions` but 404 on `GET /content/{key}` persisted after emptying the trash
  (10-17 on production). They turned out to be orphaned asset folders, see below.

## Content that appears only after other deletions (production environment, 2026-11-08)
- After a purge with 132 content deletions, 2 `SiteSettings` blocks remained. They were
  **not** in the pre-purge scan (neither the tree walk nor `/content/versions`), but showed up in the version listing
  afterwards. Their containers were already 404 before the purge, and `/content/{key}/path`
  returns only the item itself, i.e. orphans. `GET /content/{key}` works on them.
- Paging is not the cause: `/content/versions` returns full pages, then a short last page, then an empty page.
- The content type then failed with `409 DependencyConflict`. Fix: after the content step the purge rescans and
  deletes newly found content, up to 4 rounds in total; leftover content stops the purge before types.

## Unresolved items = orphaned "For this page/block" asset folders (production environment, 2026-11-09)
- All 14 keys that are in `/content/versions` but 404 on `GET /content/{key}` are `SysContentAssetFolder`s named after
  content (e.g. "Home"): the per-item asset folders the CMS creates, whose owning
  content was deleted earlier. Each has 2 published neutral versions.
- On these folders `GET /content/{key}`, `/versions`, `/path`, `/versions/{v}` and `cms-accept-resource: deleted|*`
  all return 404, and `/assets` returns 404 too, **but `/items` works**. Two of them held the orphaned `SiteSettings`
  blocks.
- The enumeration therefore walks `/items` of every unresolved key and adds what it finds; 404s on `/items`/`/assets`
  count as no children. The two `SiteSettings` blocks inside were deleted fine (permanent delete).
- **The folders themselves cannot be deleted through the API** (verified 2026-11-09 with the user's approval):
  `DELETE /content/{key}` (permanent and soft) and `DELETE /content/{key}/versions/{version}` all return 404
  "Unable to find content". They are reported (key, name, type) but not part of the plan; they are empty, invisible
  in the CMS UI, and only Optimizely support can remove them.

## Decisions (from the user)
- **Locales are never deleted.** Reset to the default setup: `en` enabled, every other locale disabled.
- **Empty the trash first.** The CMS API is known to have trouble finding content that sits in the trash, so before any
  destructive run the tool tells the user to empty the trash in the CMS UI and waits for confirmation (y/N).
  The tool itself always deletes permanently (`cms-permanent-delete: true`), so it never adds to the trash.
- Blueprints are in scope and deleted (before content types).
- **Default content types** (BlankExperience, BlankSection, GenericMedia, ImageMedia, VideoMedia) exist on every new
  instance, without a `source`. The purge asks whether to keep them (`--keep-defaults` / `--delete-defaults`).
  Kept ones stay as-is (the user chose "keep as-is, but warn" over resetting); their added properties are listed,
  and types/tabs they reference (`contentType`, `allowedTypes`, `restrictedTypes`, `group`, also under `items`) are
  kept too. On the production environment BlankExperience had 2 added component properties and ImageMedia an `AltText`.
  They are identified by key: `createdBy` is empty on all CLI-synced types too, so it can't tell them apart.
- Token requests: parallel callers share one in-flight request (9 parallel list calls used to fetch 9 tokens and
  hit `429` on `/oauth/token`), and 429/5xx are retried.

## Revised deletion order
1. Pre-flight: show target + inventory, require "trash emptied?" confirmation, then `Proceed? (y/N)`,
   then the access probe (create + delete a folder under the root); 403 → stop with nothing changed
2. Applications (entry-point content can't be deleted otherwise), then content, permanent (skip root +
   For All Sites), referrers before referenced. If either step has failures, stop here:
   a. Pages and experiences (`_page`, `_experience`), leaves first
   b. Shared blocks (`_component`, `_section`, ...)
   c. Media (`_media`, `_image`, `_video`)
   d. Folders (`_folder`), leaves first
   Items that fail (e.g. still referenced) are retried in later passes until no progress. Afterwards content is
   rescanned and new items deleted, up to 4 rounds; leftover content stops the purge here.
3. Blueprints
4. Display templates
5. Content type bindings (+ any non-built-in content sources)
6. Content types without `source`, multi-pass until no progress
7. Property groups without `source`
8. Locales: disable all except `en` (enable `en` if needed)
9. Report manual items: property formats, webhooks (Graph), API keys
10. Recommend a Graph reset, either one: scheduled job "Optimizely Graph Full Synchronization", or Settings > Data Sync & Management >
    Smooth Rebuild > "Reset to Default". Both verified on a Test1 environment; neither is available in the v1 API
