import { describe, expect, it } from "vitest";
import type { Bookmark } from "../domain/bookmark";
import {
  BookmarkStorageError,
  CURRENT_BOOKMARKS_KEY,
  CURRENT_STORAGE_VERSION,
  LEGACY_BOOKMARKS_KEY,
  loadBookmarks,
  parseBookmarkEnvelope,
  parseLegacyBookmarks,
  saveBookmarks,
  serializeBookmarks,
  type StorageLike,
} from "./bookmark-storage";

const legacyBookmarks: Bookmark[] = [
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
    expect(JSON.parse(serializeBookmarks(legacyBookmarks))).toEqual({
      version: CURRENT_STORAGE_VERSION,
      bookmarks: legacyBookmarks,
    });
  });

  it("parses a valid current envelope without changing values", () => {
    expect(parseBookmarkEnvelope(serializeBookmarks(legacyBookmarks))).toEqual(
      legacyBookmarks,
    );
  });

  it.each([
    "not json",
    "[]",
    '{"version":1,"bookmarks":[]}',
    '{"version":2}',
    '{"version":2,"bookmarks":[{"id":"x"}]}',
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
    const current = [{ ...legacyBookmarks[0]!, id: "current-id" }];
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

  it("migrates every valid v1 record verbatim and leaves the legacy key intact", () => {
    const storage = new MemoryStorage();
    const serializedLegacy = JSON.stringify(legacyBookmarks);
    storage.values.set(LEGACY_BOOKMARKS_KEY, serializedLegacy);

    expect(loadBookmarks(storage)).toEqual({
      bookmarks: legacyBookmarks,
      source: "legacy",
    });
    expect(parseBookmarkEnvelope(storage.values.get(CURRENT_BOOKMARKS_KEY)!)).toEqual(
      legacyBookmarks,
    );
    expect(storage.values.get(LEGACY_BOOKMARKS_KEY)).toBe(serializedLegacy);
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
    saveBookmarks(storage, legacyBookmarks);

    expect(parseBookmarkEnvelope(storage.values.get(CURRENT_BOOKMARKS_KEY)!)).toEqual(
      legacyBookmarks,
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

    expectStorageError(() => saveBookmarks(storage, legacyBookmarks), "write");
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
