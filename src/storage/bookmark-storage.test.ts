import { describe, expect, it } from "vitest";
import type { Bookmark } from "../domain/bookmark";
import {
  BookmarkStorageError,
  CURRENT_BOOKMARKS_KEY,
  CURRENT_STORAGE_VERSION,
  LEGACY_BOOKMARKS_KEY,
  VERSION_2_BOOKMARKS_KEY,
  loadBookmarks,
  parseBookmarkEnvelope,
  parseLegacyBookmarks,
  parseVersion2Envelope,
  saveBookmarks,
  serializeBookmarks,
  type StorageLike,
} from "./bookmark-storage";

const legacyBookmarks = [
  {
    id: "original-id",
    url: "https://example.com/original?kept=yes",
    slug: "keep42",
    createdAt: "2024-05-06T07:08:09.000Z",
  },
  {
    id: "",
    url: "http://example.org",
    slug: "",
    createdAt: "",
  },
];
const migratedBookmarks: Bookmark[] = legacyBookmarks.map((bookmark) => ({
  ...bookmark,
  title: new URL(bookmark.url).hostname,
  tags: [],
  notes: "",
}));

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("bookmark serialization", () => {
  it("serializes bookmarks in an explicit current-version envelope", () => {
    expect(JSON.parse(serializeBookmarks(migratedBookmarks))).toEqual({
      version: CURRENT_STORAGE_VERSION,
      bookmarks: migratedBookmarks,
    });
  });

  it("parses a valid current envelope without changing values", () => {
    expect(parseBookmarkEnvelope(serializeBookmarks(migratedBookmarks))).toEqual(
      migratedBookmarks,
    );
  });

  it.each([
    "not json",
    "[]",
    '{"version":2,"bookmarks":[]}',
    '{"version":3}',
    '{"version":3,"bookmarks":[{"id":"x"}]}',
  ])("rejects invalid current storage: %s", (serialized) => {
    expect(() => parseBookmarkEnvelope(serialized)).toThrow(BookmarkStorageError);
  });

  it.each([
    "not json",
    "{}",
    '[{"id":"x","url":"ftp://example.com","slug":"x","createdAt":"now"}]',
  ])("rejects invalid legacy storage: %s", (serialized) => {
    expect(() => parseLegacyBookmarks(serialized)).toThrow(BookmarkStorageError);
  });

  it("adds metadata defaults when parsing version 2 and legacy data", () => {
    const version2 = JSON.stringify({ version: 2, bookmarks: legacyBookmarks });
    expect(parseVersion2Envelope(version2)).toEqual(migratedBookmarks);
    expect(parseLegacyBookmarks(JSON.stringify(legacyBookmarks))).toEqual(
      migratedBookmarks,
    );
  });
});

describe("loadBookmarks", () => {
  it("returns an empty store when neither key exists", () => {
    expect(loadBookmarks(new MemoryStorage())).toEqual({
      bookmarks: [],
      source: "empty",
    });
  });

  it("loads the current envelope without consulting or changing legacy data", () => {
    const storage = new MemoryStorage();
    const current = [{ ...migratedBookmarks[0]!, id: "current-id" }];
    storage.values.set(CURRENT_BOOKMARKS_KEY, serializeBookmarks(current));
    storage.values.set(LEGACY_BOOKMARKS_KEY, JSON.stringify(legacyBookmarks));

    expect(loadBookmarks(storage)).toEqual({
      bookmarks: current,
      source: "current",
    });
    expect(storage.values.get(LEGACY_BOOKMARKS_KEY)).toBe(
      JSON.stringify(legacyBookmarks),
    );
  });

  it("migrates every valid v1 core field and leaves the legacy key intact", () => {
    const storage = new MemoryStorage();
    const serializedLegacy = JSON.stringify(legacyBookmarks);
    storage.values.set(LEGACY_BOOKMARKS_KEY, serializedLegacy);

    expect(loadBookmarks(storage)).toEqual({
      bookmarks: migratedBookmarks,
      source: "legacy",
    });
    expect(parseBookmarkEnvelope(storage.values.get(CURRENT_BOOKMARKS_KEY)!)).toEqual(
      migratedBookmarks,
    );
    expect(storage.values.get(LEGACY_BOOKMARKS_KEY)).toBe(serializedLegacy);
  });

  it("migrates version 2 before consulting v1 and leaves both old keys intact", () => {
    const storage = new MemoryStorage();
    const version2 = JSON.stringify({ version: 2, bookmarks: legacyBookmarks });
    storage.values.set(VERSION_2_BOOKMARKS_KEY, version2);
    storage.values.set(LEGACY_BOOKMARKS_KEY, "malformed but unused");

    expect(loadBookmarks(storage)).toEqual({
      bookmarks: migratedBookmarks,
      source: "version2",
    });
    expect(parseBookmarkEnvelope(storage.values.get(CURRENT_BOOKMARKS_KEY)!)).toEqual(
      migratedBookmarks,
    );
    expect(storage.values.get(VERSION_2_BOOKMARKS_KEY)).toBe(version2);
  });

  it("does not overwrite malformed current data with a valid legacy array", () => {
    const storage = new MemoryStorage();
    storage.values.set(CURRENT_BOOKMARKS_KEY, "malformed current data");
    storage.values.set(LEGACY_BOOKMARKS_KEY, JSON.stringify(legacyBookmarks));

    expect(() => loadBookmarks(storage)).toThrowError(
      "Current bookmark storage is not valid JSON.",
    );
    expect(storage.values.get(CURRENT_BOOKMARKS_KEY)).toBe("malformed current data");
  });

  it("does not overwrite malformed legacy data", () => {
    const storage = new MemoryStorage();
    storage.values.set(LEGACY_BOOKMARKS_KEY, "malformed legacy data");

    expect(() => loadBookmarks(storage)).toThrowError(
      "Legacy bookmark storage is not valid JSON.",
    );
    expect(storage.values.has(CURRENT_BOOKMARKS_KEY)).toBe(false);
  });

  it("does not overwrite malformed version 2 data or fall back to v1", () => {
    const storage = new MemoryStorage();
    storage.values.set(VERSION_2_BOOKMARKS_KEY, "malformed version 2 data");
    storage.values.set(LEGACY_BOOKMARKS_KEY, JSON.stringify(legacyBookmarks));

    expect(() => loadBookmarks(storage)).toThrowError(
      "Version 2 bookmark storage is not valid JSON.",
    );
    expect(storage.values.has(CURRENT_BOOKMARKS_KEY)).toBe(false);
  });

  it("reports read failures explicitly", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };

    expectStorageError(() => loadBookmarks(storage), "read");
  });

  it("reports migration write failures explicitly", () => {
    const storage: StorageLike = {
      getItem: (key) =>
        key === LEGACY_BOOKMARKS_KEY ? JSON.stringify(legacyBookmarks) : null,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expectStorageError(() => loadBookmarks(storage), "migration");
  });
});

describe("saveBookmarks", () => {
  it("writes only the current versioned key", () => {
    const storage = new MemoryStorage();
    saveBookmarks(storage, migratedBookmarks);

    expect(parseBookmarkEnvelope(storage.values.get(CURRENT_BOOKMARKS_KEY)!)).toEqual(
      migratedBookmarks,
    );
    expect(storage.values.has(LEGACY_BOOKMARKS_KEY)).toBe(false);
  });

  it("reports write failures explicitly", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expectStorageError(() => saveBookmarks(storage, migratedBookmarks), "write");
  });
});

function expectStorageError(
  operation: () => unknown,
  kind: BookmarkStorageError["kind"],
): void {
  try {
    operation();
    throw new Error("Expected operation to throw.");
  } catch (error) {
    expect(error).toBeInstanceOf(BookmarkStorageError);
    expect((error as BookmarkStorageError).kind).toBe(kind);
  }
}
