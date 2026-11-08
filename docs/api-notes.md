# SaaS CMS REST API v1 — notes for the cleanup tool

Status: **verified** against `contentgurus-test1` on 2026-11-08 with `npm run probe` and `npm run probe:content` (read-only).
Spec: `GET /v1/docs/content-openapi.json` ("Optimizely CMS REST API - Content v1.1"), saved by the probe under `probe-output/`.
Background evidence: the official CLI in [episerver/content-js-sdk](https://github.com/episerver/content-js-sdk). Docs: https://docs.optimizely.com/cms-saas/api/

## Auth
- `POST https://api.cms.optimizely.com/oauth/token`, JSON `{grant_type: "client_credentials", client_id, client_secret}` ✅
- Token lifetime 300 s. The API key (Settings > API Keys) determines the target.

## Access rights (required before a purge)
- The token's identity is the API client (`sub` = client ID) with scope `api:admin`. That covers settings
  (types, tabs, templates, locales), but **content deletes return 403** ("Access was denied to delete content")
  unless the API client has content access rights. Verified on contentgurus-test1, both soft and permanent delete.
- Fix (per environment, in the CMS UI): Settings > Access Rights → root → give the API key **Administer**,
  tick **"Apply settings for all subitems"** when saving. This also covers the Recycle Bin (CMS id 2).
- Token claims include `siteUrl` and `instanceId` → the tool verifies `siteUrl` matches the profile's `cmsUrl`.

## Conventions
- Base `https://api.cms.optimizely.com/v1`
- Paging: `pageIndex` / `pageSize` (max 10000) → `{items, pageIndex, pageSize}`; `totalCount` was **absent** in practice, so stop on a short page.
- Errors are ProblemDetails (`title`, `status`, `code`, `traceId`). 429 sends `Retry-After`. `If-Match` optional on deletes.

## Resources (as found on contentgurus-test1)
| Resource | Count | Delete | Built-in marker → skip |
|---|---|---|---|
| contenttypes | 51 | `DELETE /contenttypes/{key}` | `source` present: `globalcontract` (8), `graph` (12, DAM), `_system` (1: SysContentFolder). 30 custom have no `source` |
| displaytemplates | 47 | `DELETE /displaytemplates/{key}` | no `source` field; all custom |
| propertygroups | 23 | `DELETE /propertygroups/{key}` | `source: "_system"` (6: Content, Scheduling, Settings, Shortcut, Categories, DynamicBlocks) |
| contentsources | 9 | `DELETE /contentsources/{key}` | **all built-in** (`type` `graph` = DAM, `globalcontract`) → never delete. Only delete other `type`s if they ever appear |
| contenttypebindings | 0 | `DELETE /contenttypebindings/{key}` | — |
| blueprints | 0 (confirmed none on this instance) | `DELETE /blueprints/{key}` | fields `key, displayName, contentType, content`; reference a content type, so delete before types |
| applications | 0 | `DELETE /applications/{key}` | `source` field. contentgurus-test1 has none defined (confirmed); untested on an instance with apps |
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

## Verified by delete experiments (contentgurus-test1, 2026-11-08)
- **Deleting a folder permanently deletes its descendants** (folder and child both 404 afterwards, also with
  `cms-accept-resource: deleted`). The purge logs such children as "already gone".
- **Referenced content can be deleted**: an image used by a published block (Microsoft.png ← Partner Logos)
  deleted without a conflict, leaving a broken reference. Order pages → blocks → media → folders is kept anyway.
- Full purge (2026-11-08): 56 content, 47 display templates, 30 content types, 17 property groups, 3 locales, all in a
  single pass with no failures and no 409s. Display templates and tabs delete fine in the documented order.

## Decisions (from the user)
- **Locales are never deleted.** Reset to the default setup: `en` enabled, every other locale disabled.
- **Empty the trash first.** The CMS API is known to have trouble finding content that sits in the trash, so before any
  destructive run the tool tells the user to empty the trash in the CMS UI and waits for confirmation (y/N).
  The tool itself always deletes permanently (`cms-permanent-delete: true`), so it never adds to the trash.
- Blueprints are in scope and deleted (before content types).

## Revised deletion order
1. Pre-flight: show target + inventory, require "trash emptied?" confirmation, then `Proceed? (y/N)`
2. Content, permanent (skip root + For All Sites), referrers before referenced:
   a. Pages and experiences (`_page`, `_experience`), leaves first
   b. Shared blocks (`_component`, `_section`, ...)
   c. Media (`_media`, `_image`, `_video`)
   d. Folders (`_folder`), leaves first
   Items that fail (e.g. still referenced) are retried in later passes until no progress.
3. Blueprints
4. Display templates
5. Content type bindings (+ any non-built-in content sources)
6. Content types without `source`, multi-pass until no progress
7. Property groups without `source`
8. Applications without `source`
9. Locales: disable all except `en` (enable `en` if needed)
10. Report manual items: property formats, webhooks (Graph), API keys
11. Recommend a Graph reset, either one: scheduled job "Optimizely Graph Full Synchronization", or Settings > Data Sync & Management >
    Smooth Rebuild > "Reset to Default". Both verified on contentgurus-test1; neither is available in the v1 API
