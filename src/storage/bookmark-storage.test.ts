import { describe, expect, it } from "vitest";
import type { Bookmark } from "../domain/bookmark";
import {
  BOOKMARK_STORAGE_KEYS,
  BookmarkStorageError,
  CURRENT_BOOKMARKS_KEY,
  CURRENT_STORAGE_VERSION,
  LEGACY_BOOKMARKS_KEY,
  VERSION_2_BOOKMARKS_KEY,
  clearBookmarks,
  describeRawPayload,
  loadBookmarks,
  parseBookmarkEnvelope,
  parseLegacyBookmarks,
  parseVersion2Envelope,
  readRawBookmarkPayloads,
  readRawBookmarks,
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

  removeItem(key: string): void {
    this.values.delete(key);
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

describe("raw payload recovery", () => {
  it("lists every storage key newest first", () => {
    expect([...BOOKMARK_STORAGE_KEYS]).toEqual([
      CURRENT_BOOKMARKS_KEY,
      VERSION_2_BOOKMARKS_KEY,
      LEGACY_BOOKMARKS_KEY,
    ]);
  });

  it("returns null when nothing is stored", () => {
    expect(readRawBookmarks(new MemoryStorage())).toBeNull();
  });

  it("returns the newest malformed payload verbatim without parsing it", () => {
    const storage = new MemoryStorage();
    storage.setItem(CURRENT_BOOKMARKS_KEY, "{ broken");
    storage.setItem(LEGACY_BOOKMARKS_KEY, "[]");

    expect(readRawBookmarks(storage)).toEqual({
      key: CURRENT_BOOKMARKS_KEY,
      value: "{ broken",
    });
  });

  it("returns every stored version verbatim for a complete recovery backup", () => {
    const storage = new MemoryStorage();
    storage.setItem(CURRENT_BOOKMARKS_KEY, "{ broken");
    storage.setItem(VERSION_2_BOOKMARKS_KEY, '{"version":2,"bookmarks":[]}');
    storage.setItem(LEGACY_BOOKMARKS_KEY, "[]");

    expect(readRawBookmarkPayloads(storage)).toEqual([
      { key: CURRENT_BOOKMARKS_KEY, value: "{ broken" },
      {
        key: VERSION_2_BOOKMARKS_KEY,
        value: '{"version":2,"bookmarks":[]}',
      },
      { key: LEGACY_BOOKMARKS_KEY, value: "[]" },
    ]);
  });

  it("falls back to older keys when the newest is absent", () => {
    const storage = new MemoryStorage();
    storage.setItem(VERSION_2_BOOKMARKS_KEY, "{ also broken");

    expect(readRawBookmarks(storage)?.key).toBe(VERSION_2_BOOKMARKS_KEY);
  });

  it("reports read failures explicitly", () => {
    expectStorageError(
      () =>
        readRawBookmarks({
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {},
        }),
      "read",
    );
  });

  it("describes unparsable data without throwing", () => {
    const diagnostics = describeRawPayload({
      key: CURRENT_BOOKMARKS_KEY,
      value: "{ broken\n\tdata",
    });

    expect(diagnostics).toMatchObject({
      key: CURRENT_BOOKMARKS_KEY,
      bytes: 14,
      parsable: false,
      preview: "{ broken data",
    });
  });

  it("describes parsable but invalid data", () => {
    expect(
      describeRawPayload({
        key: CURRENT_BOOKMARKS_KEY,
        value: '{"version":3,"bookmarks":"nope"}',
      }),
    ).toMatchObject({
      parsable: true,
      shape: 'object with keys \u201cversion\u201d, \u201cbookmarks\u201d',
    });
  });

  it("truncates a long preview", () => {
    expect(
      describeRawPayload({ key: CURRENT_BOOKMARKS_KEY, value: "x".repeat(500) }).preview,
    ).toHaveLength(180);
  });
});

describe("explicit reset", () => {
  it("removes every Shortlist key", () => {
    const storage = new MemoryStorage();
    storage.setItem(CURRENT_BOOKMARKS_KEY, "{ broken");
    storage.setItem(VERSION_2_BOOKMARKS_KEY, "{}");
    storage.setItem(LEGACY_BOOKMARKS_KEY, "[]");
    storage.setItem("unrelated.key", "kept");

    clearBookmarks(storage);

    expect(readRawBookmarks(storage)).toBeNull();
    expect(storage.getItem("unrelated.key")).toBe("kept");
  });

  it("refuses to reset storage that cannot remove items", () => {
    expectStorageError(
      () => clearBookmarks({ getItem: () => null, setItem: () => {} }),
      "remove",
    );
  });

  it("preserves the newest raw payload when removal fails part way through", () => {
    const storage = new MemoryStorage();
    storage.setItem(CURRENT_BOOKMARKS_KEY, "{ broken");
    storage.setItem(LEGACY_BOOKMARKS_KEY, "[]");
    const guarded: StorageLike = {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => {
        if (key === LEGACY_BOOKMARKS_KEY) throw new Error("blocked");
        storage.removeItem(key);
      },
    };

    expectStorageError(() => clearBookmarks(guarded), "remove");
    expect(readRawBookmarks(storage)).toEqual({
      key: CURRENT_BOOKMARKS_KEY,
      value: "{ broken",
    });
  });

  it("reports partial deletion accurately while preserving newer payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem(CURRENT_BOOKMARKS_KEY, "{ broken");
    storage.setItem(VERSION_2_BOOKMARKS_KEY, "{}");
    storage.setItem(LEGACY_BOOKMARKS_KEY, "[]");
    const guarded: StorageLike = {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => {
        if (key === VERSION_2_BOOKMARKS_KEY) throw new Error("blocked");
        storage.removeItem(key);
      },
    };

    expect(() => clearBookmarks(guarded)).toThrow(
      /Reset stopped after removing shortlist\.bookmarks\.v1/,
    );
    expect(storage.getItem(LEGACY_BOOKMARKS_KEY)).toBeNull();
    expect(storage.getItem(VERSION_2_BOOKMARKS_KEY)).toBe("{}");
    expect(storage.getItem(CURRENT_BOOKMARKS_KEY)).toBe("{ broken");
  });

  it("keeps malformed data readable for recovery instead of erasing it", () => {
    const storage = new MemoryStorage();
    storage.setItem(CURRENT_BOOKMARKS_KEY, "{ broken");

    expect(() => loadBookmarks(storage)).toThrow(BookmarkStorageError);
    expect(storage.getItem(CURRENT_BOOKMARKS_KEY)).toBe("{ broken");
    expect(readRawBookmarks(storage)?.value).toBe("{ broken");
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
