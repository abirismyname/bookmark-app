# Bookmark app

A small Astro app that saves URLs under locally generated short slugs. Add
editable titles, tags, and notes, then search across every bookmark field,
filter by tag, and sort by date or title. Bookmarks stay in browser
`localStorage`, so no account or backend is required.

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
- `src/storage/bookmark-storage.ts` owns serialization and local storage migration.
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
