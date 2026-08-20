# Shortlist

Shortlist is an installable, local-first bookmark manager built with Astro. Save
URLs, add titles, tags, and notes, search or filter the collection, and keep
portable JSON backups. There are no accounts, analytics, backend, or remote
sync: bookmark data stays in this browser's `localStorage`.

## Features

- Save `http` and `https` URLs with collision-resistant six-character slugs.
- Edit titles, tags, and notes; search every field; filter by tag; sort by date
  or title.
- Export deterministic JSON backups and preview imports before applying them.
- Skip or replace duplicate URLs while preserving stable saved IDs and slugs.
- Diagnose malformed storage, download raw recovery data, and require explicit
  confirmation before reset.
- Install as a PWA and reopen the production app shell offline after one
  successful online load.
- Keyboard, screen-reader, reduced-motion, touch, phone, tablet, narrow
  landscape, and desktop support.

## Install and offline use

Open the deployed production app in a browser that supports installable web
apps, then use the browser's **Install app** or **Add to Home Screen** action.
The manifest supplies standalone display metadata and 192 px, 512 px, maskable,
and Apple touch icons.

The service worker precaches the versioned production shell: HTML, JavaScript,
CSS, manifest, and local icons. After the first successful load completes and
the service worker takes control, navigation and core bookmark management work
offline. Updates activate automatically, delete obsolete caches, and use
content-hashed assets so a reopened app is not stranded on an old asset graph.

Offline limitations:

- A bookmark destination is still a normal external link and requires whatever
  network access or independent browser cache that site needs.
- Shortlist does not request, inspect, or cache external bookmark destinations.
- Bookmark records and imports are never placed in Cache Storage. They remain
  exclusively in `localStorage`.
- Clearing browser site data removes local bookmarks and the offline app shell.
  Export backups regularly.
- Installation UI and service-worker support vary by browser and platform.

## Privacy and local architecture

All application logic runs in the browser. Import uses the File API; export and
recovery downloads use temporary object URLs. No bookmark, note, query, file, or
diagnostic is transmitted by Shortlist. Because exports contain all bookmark
fields, including notes, treat backup files as private.

| Area | Responsibility |
| --- | --- |
| `src/components/` | Semantic Astro presentation components |
| `src/domain/bookmark.ts` | Bookmark model, URL validation, slugs, metadata, search, filtering, sorting |
| `src/domain/bookmark-transfer.ts` | Strict export codec and import schema migration |
| `src/domain/bookmark-import-plan.ts` | Duplicate and identifier-conflict planning |
| `src/storage/bookmark-storage.ts` | Versioned persistence, migration, diagnostics, reset |
| `src/app/bookmark-controller.ts` | Browser events, rendering, focus, announcements |
| `astro.config.mjs` | Static PWA manifest and Workbox precache policy |
| `tests/e2e/` | Built-app browser and offline behavior |

Astro emits a static site. There is no server-side application layer.

## Storage and preservation guarantees

Current records use `shortlist.bookmarks.v3`:

```json
{
  "version": 3,
  "bookmarks": [
    {
      "id": "9f1c7c8e-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
      "url": "https://example.com/docs",
      "slug": "abc234",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "title": "Example docs",
      "tags": ["reference", "work"],
      "notes": "Useful documentation"
    }
  ]
}
```

On first load, a valid version 2 envelope or legacy
`shortlist.bookmarks.v1` array is copied into version 3. IDs, URLs, slugs,
timestamps, and order are preserved; a hostname title and empty tags/notes are
added. Older keys are deliberately left untouched. PWA installation, service
worker updates, and Cache Storage cleanup never clear, move, or rewrite these
`localStorage` keys.

If the newest present storage version is invalid or inaccessible, Shortlist
does not silently fall back or overwrite it. The recovery panel reports the
key, size, JSON shape, and a short preview.

## Import, export, duplicates, and recovery

Export creates a version 1 interchange document with schema
`https://shortlist.local/schemas/bookmarks`. Import accepts that format plus
storage versions 1, 2, and 3. Validation rejects the entire file before writing
when it is not JSON, exceeds 1 MiB or 5,000 records, declares an unsupported
schema/version, contains unexpected or ill-typed fields, has a non-HTTP(S) URL,
or exceeds metadata limits.

Every import is previewed:

- **Skip duplicates** keeps an existing normalized URL unchanged.
- **Replace duplicates** updates metadata and timestamp while preserving the
  existing ID and slug. Legacy backups keep existing metadata that those old
  formats could not represent.
- An ID or slug collision on another URL receives a new collision-free value;
  unrelated records are not overwritten.

The complete planned collection is persisted before the UI changes. Recovery
offers exact raw-payload downloads first. Reset removes only known Shortlist
keys, older versions first, and requires a second confirmation.

## Development

Requires Node.js 22 or a compatible current LTS release.

```sh
npm ci
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Astro development mode |
| `npm test` | Run domain and storage unit tests |
| `npm run check` | Run Astro and TypeScript checks |
| `npm run build` | Generate the production PWA in `dist/` |
| `npx playwright install chromium` | Install the E2E browser once |
| `npm run test:e2e` | Build, serve, and test the production app |
| `npm run validate` | Run unit, check, build, and full E2E validation |

CI installs Chromium with Playwright and runs `npm run validate`. E2E tests use
Astro's local production preview and make no third-party network requests.

## Browser support

The core app needs modern `localStorage`, File, Blob, URL, and Web Crypto APIs.
The tested browser target is current Chromium. Current Firefox and Safari
support the core local bookmark experience; PWA installation UI and standalone
behavior differ. Private browsing, enterprise policy, quota limits, or disabled
site storage can prevent persistence. Shortlist surfaces those failures rather
than claiming data was saved.

## Four-layer stack

1. **PR #8:** modular domain, storage, component, and controller foundation.
2. **PR #9:** titles, tags, notes, search, filtering, sorting, and storage v3.
3. **PR #10:** safe import/export, duplicate planning, and recovery tooling.
4. **This layer:** installable offline PWA, accessibility/responsive polish,
   built-app E2E coverage, documentation, and CI.

## Manual demo

1. Open Shortlist, save `https://example.com/docs`, then edit it to **Example
   docs**, tags **work, reference**, and a short note.
2. Save a second URL; search the note, filter **work**, change sorting, and reset
   the view.
3. Export JSON. Re-import it with each duplicate strategy and inspect the
   preview before cancelling or applying.
4. Reload to show persistence. In DevTools, seed malformed
   `shortlist.bookmarks.v3` data, reload, download the raw backup, open reset,
   cancel with Escape, then confirm reset.
5. Install the app, load it once online, switch the browser offline, and reload.
   The shell and saved local bookmarks remain available; opening an external
   bookmark still requires network access.
