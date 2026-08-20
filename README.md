# Bookmark app

A small Astro app that saves URLs under locally generated short slugs. Add
editable titles, tags, and notes, then search across every bookmark field,
filter by tag, and sort by date or title. Export and import the whole
collection as JSON, and recover from unreadable local data. Bookmarks stay in
browser `localStorage`, so no account or backend is required.

## Run locally

```sh
npm install
npm run dev
```

Use `npm run build` to create a production build.

## Architecture

- `src/components/` contains the reusable Astro presentation components.
- `src/domain/bookmark.ts` contains the bookmark model plus pure URL, slug,
  metadata, search, filter, and sorting helpers.
- `src/domain/bookmark-transfer.ts` is the pure export codec plus import
  validation and schema migration.
- `src/domain/bookmark-import-plan.ts` is the pure merge planner for duplicates
  and identifier conflicts.
- `src/storage/bookmark-storage.ts` owns serialization, local storage migration,
  raw payload recovery, and explicit reset.
- `src/app/bookmark-controller.ts` connects the browser UI to the domain and storage
  modules.

Run `npm test` for the focused domain and storage unit tests.

## Local storage

Current data is stored at `shortlist.bookmarks.v3` in a versioned envelope.
Version 3 adds `title`, `tags`, and `notes` to each bookmark. On first load, a
valid version 2 envelope or legacy `shortlist.bookmarks.v1` array is copied into
version 3 with a hostname-based title, an empty tag list, and empty notes.
Bookmark IDs, URLs, slugs, timestamps, and order are retained, and older keys
remain untouched. Invalid or inaccessible data at the newest available version
is reported in the UI and is never overwritten or bypassed by older data.

## Export and import

Export writes a deterministic JSON document for a given collection and export
timestamp: bookmarks stay in collection order, keys keep a fixed order, and the
file is pretty printed with two spaces and a trailing newline.

```json
{
  "schema": "https://shortlist.local/schemas/bookmarks",
  "version": 1,
  "exportedAt": "2025-03-04T05:06:07.000Z",
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

`schema` and `version` are what future releases read to migrate older files, so
both are required and must match exactly.

### Privacy

Export and import run entirely in the browser. Files are read with the File API
and written with an object URL; nothing is uploaded, and no network request is
made. The export contains every field of every bookmark, including notes, so
treat the file as private data.

### Schema compatibility

Import accepts four documented shapes and migrates each explicitly:

| Format | Shape | Fields read |
| --- | --- | --- |
| Export version 1 | `{ schema, version: 1, exportedAt, bookmarks }` | all fields |
| Storage version 3 | `{ version: 3, bookmarks }` | all fields |
| Storage version 2 | `{ version: 2, bookmarks }` | `id`, `url`, `slug`, `createdAt` |
| Storage version 1 | bare array | `id`, `url`, `slug`, `createdAt` |

Version 1 and 2 records gain a hostname title, an empty tag list, and empty
notes, exactly as the storage migration does.

Validation is strict, because import files are untrusted input. A file is
rejected whole, with no change to saved data, when it is not `.json`, is larger
than 1 MiB (`MAX_IMPORT_BYTES`), holds more than 5,000 bookmarks
(`MAX_BOOKMARK_COLLECTION`), is not valid JSON, declares an unknown schema or
version, carries an unexpected top-level or bookmark property, has an ill-typed
field, uses a URL that is not `http` or `https`, or exceeds the title, tag, or
notes limits. Errors name the offending bookmark by position.

Identifiers are treated separately in storage backups, because older storage
accepted empty `id`, `slug`, and `createdAt` values. Those legacy values are
repaired during the import plan with a fresh ID, a fresh 6-character slug, or
the current time. The current interchange format requires valid identifiers and
timestamps; malformed or ill-typed current exports are rejected.

### Duplicates and conflicts

Import is previewed before anything is written. The preview reports how many
bookmarks were read, how many will be added, replaced, or skipped, and the
resulting collection size.

- **Duplicate URL** — identity is the normalized URL, matched against saved
  bookmarks and against earlier entries in the same file. *Skip duplicates*
  keeps the saved bookmark unchanged. *Replace duplicates* overwrites the title,
  tags, notes, and timestamp, but keeps the saved `id` and short link so
  existing references stay valid. Version 1 and 2 backups never carried title,
  tag, or note data, so replacing from those legacy formats keeps the existing
  metadata instead of overwriting it with migration defaults.
- **ID or short link conflict on a different URL** — the incoming record keeps
  its URL and metadata and receives a newly generated, collision-free ID or
  slug. No unrelated record is dropped or overwritten.

Applying an import persists the entire planned collection first and only then
updates what is on screen, so a storage failure leaves the previous collection
exactly as it was.

## Recovery

Invalid or inaccessible data at the newest available version is never
overwritten or bypassed by older data. When it cannot be read, the app shows
which key failed, its size, whether it is valid JSON, and the first characters
of the payload.

From there nothing is destructive by default:

- **Download raw data** saves the stored bytes exactly as written, before any
  other action. When older Shortlist keys also exist, **Download all stored
  versions** saves every key and its exact raw value in one recovery bundle
  before reset can remove them.
- **Import a valid file** replaces the unreadable data, because the existing
  bookmarks cannot be trusted. The preview says so explicitly and still requires
  confirmation.
- **Reset local data** requires a second explicit confirmation and only then
  removes the Shortlist keys. Older keys are removed first, so a partial failure
  still leaves the newest raw payload in place to download and reports any older
  key that was already removed.
