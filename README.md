# Bookmark app

A small Astro app that saves URLs under locally generated short slugs. Bookmarks
are stored in the browser with `localStorage`, so no account or backend is
required.

## Run locally

```sh
npm install
npm run dev
```

Use `npm run build` to create a production build.

## Architecture

- `src/components/` contains the reusable Astro presentation components.
- `src/domain/bookmark.ts` contains the bookmark model and pure URL/slug helpers.
- `src/storage/bookmark-storage.ts` owns serialization and local storage migration.
- `src/app/bookmark-controller.ts` connects the browser UI to the domain and storage
  modules.

Run `npm test` for the focused domain and storage unit tests.

## Local storage

Current data is stored at `shortlist.bookmarks.v2` in a versioned envelope. On
first load, a valid legacy `shortlist.bookmarks.v1` array is copied into that
envelope without changing bookmark IDs, URLs, slugs, timestamps, or order. The
legacy key remains untouched. Invalid or inaccessible storage is reported in the
UI and is never silently replaced.
