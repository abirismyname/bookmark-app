import {
  isBookmark,
  isBookmarkCore,
  withMetadataDefaults,
  type Bookmark,
} from "../domain/bookmark";

export const LEGACY_BOOKMARKS_KEY = "shortlist.bookmarks.v1";
export const VERSION_2_BOOKMARKS_KEY = "shortlist.bookmarks.v2";
export const CURRENT_BOOKMARKS_KEY = "shortlist.bookmarks.v3";
export const CURRENT_STORAGE_VERSION = 3;

export interface BookmarkStorageEnvelope {
  version: typeof CURRENT_STORAGE_VERSION;
  bookmarks: Bookmark[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type BookmarkStorageErrorKind =
  | "read"
  | "invalid"
  | "write"
  | "migration";

export class BookmarkStorageError extends Error {
  constructor(
    message: string,
    readonly kind: BookmarkStorageErrorKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BookmarkStorageError";
  }
}

export interface LoadedBookmarks {
  bookmarks: Bookmark[];
  source: "empty" | "current" | "version2" | "legacy";
}

export function serializeBookmarks(bookmarks: readonly Bookmark[]): string {
  const envelope: BookmarkStorageEnvelope = {
    version: CURRENT_STORAGE_VERSION,
    bookmarks: [...bookmarks],
  };

  return JSON.stringify(envelope);
}

export function parseBookmarkEnvelope(serialized: string): Bookmark[] {
  const value = parseJson(serialized, "Current bookmark storage is not valid JSON.");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidStorage("Current bookmark storage has an invalid format.");
  }

  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== CURRENT_STORAGE_VERSION ||
    !Array.isArray(envelope.bookmarks) ||
    !envelope.bookmarks.every(isBookmark)
  ) {
    throw invalidStorage("Current bookmark storage has an invalid format.");
  }

  return envelope.bookmarks;
}

export function parseLegacyBookmarks(serialized: string): Bookmark[] {
  const value = parseJson(serialized, "Legacy bookmark storage is not valid JSON.");
  if (!Array.isArray(value) || !value.every(isBookmarkCore)) {
    throw invalidStorage("Legacy bookmark storage has an invalid format.");
  }

  return value.map(withMetadataDefaults);
}

export function parseVersion2Envelope(serialized: string): Bookmark[] {
  const value = parseJson(serialized, "Version 2 bookmark storage is not valid JSON.");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidStorage("Version 2 bookmark storage has an invalid format.");
  }

  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 2 ||
    !Array.isArray(envelope.bookmarks) ||
    !envelope.bookmarks.every(isBookmarkCore)
  ) {
    throw invalidStorage("Version 2 bookmark storage has an invalid format.");
  }

  return envelope.bookmarks.map(withMetadataDefaults);
}

export function loadBookmarks(storage: StorageLike): LoadedBookmarks {
  const current = readItem(storage, CURRENT_BOOKMARKS_KEY);
  if (current !== null) {
    return { bookmarks: parseBookmarkEnvelope(current), source: "current" };
  }

  const version2 = readItem(storage, VERSION_2_BOOKMARKS_KEY);
  if (version2 !== null) {
    const bookmarks = parseVersion2Envelope(version2);
    migrateBookmarks(storage, bookmarks);
    return { bookmarks, source: "version2" };
  }

  const legacy = readItem(storage, LEGACY_BOOKMARKS_KEY);
  if (legacy === null) {
    return { bookmarks: [], source: "empty" };
  }

  const bookmarks = parseLegacyBookmarks(legacy);
  migrateBookmarks(storage, bookmarks);

  return { bookmarks, source: "legacy" };
}

function migrateBookmarks(storage: StorageLike, bookmarks: Bookmark[]): void {
  try {
    storage.setItem(CURRENT_BOOKMARKS_KEY, serializeBookmarks(bookmarks));
  } catch (cause) {
    throw new BookmarkStorageError(
      "Existing bookmarks were read but could not be migrated to current storage.",
      "migration",
      { cause },
    );
  }
}

export function saveBookmarks(
  storage: StorageLike,
  bookmarks: readonly Bookmark[],
): void {
  try {
    storage.setItem(CURRENT_BOOKMARKS_KEY, serializeBookmarks(bookmarks));
  } catch (cause) {
    throw new BookmarkStorageError(
      "Bookmarks could not be saved. Check your browser storage settings.",
      "write",
      { cause },
    );
  }
}

function readItem(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch (cause) {
    throw new BookmarkStorageError(
      "Bookmarks could not be read. Check your browser storage settings.",
      "read",
      { cause },
    );
  }
}

function parseJson(serialized: string, message: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch (cause) {
    throw new BookmarkStorageError(message, "invalid", { cause });
  }
}

function invalidStorage(message: string): BookmarkStorageError {
  return new BookmarkStorageError(message, "invalid");
}
