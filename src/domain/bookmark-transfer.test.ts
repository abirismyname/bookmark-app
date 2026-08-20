import { describe, expect, it } from "vitest";
import type { Bookmark } from "./bookmark";
import {
  BOOKMARK_TRANSFER_SCHEMA,
  BOOKMARK_TRANSFER_VERSION,
  BookmarkImportError,
  MAX_BOOKMARK_COLLECTION,
  MAX_IMPORT_BYTES,
  assertImportFile,
  bookmarkExportFileName,
  buildTransferDocument,
  byteLength,
  decodeBookmarkImport,
  formatByteSize,
  isSafeId,
  isValidSlug,
  isValidTimestamp,
  serializeBookmarkExport,
} from "./bookmark-transfer";

const exportedAt = new Date("2025-03-04T05:06:07.000Z");

const bookmarks: Bookmark[] = [
  {
    id: "9f1c7c8e-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
    url: "https://example.com/docs",
    slug: "abc234",
    createdAt: "2025-01-01T00:00:00.000Z",
    title: "Example docs",
    tags: ["reference", "work"],
    notes: "Useful documentation",
  },
  {
    id: "second-id",
    url: "http://example.org/",
    slug: "keep42",
    createdAt: "2024-05-06T07:08:09.000Z",
    title: "example.org",
    tags: [],
    notes: "",
  },
];

function interchange(entries: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: BOOKMARK_TRANSFER_SCHEMA,
    version: BOOKMARK_TRANSFER_VERSION,
    exportedAt: exportedAt.toISOString(),
    bookmarks: entries,
    ...overrides,
  });
}

function fullEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...bookmarks[0], ...overrides };
}

function coreEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "original-id",
    url: "https://example.com/original?kept=yes",
    slug: "keep42",
    createdAt: "2024-05-06T07:08:09.000Z",
    ...overrides,
  };
}

describe("bookmark export", () => {
  it("builds an explicit interchange document with injected timestamp", () => {
    expect(buildTransferDocument(bookmarks, exportedAt)).toEqual({
      schema: BOOKMARK_TRANSFER_SCHEMA,
      version: BOOKMARK_TRANSFER_VERSION,
      exportedAt: "2025-03-04T05:06:07.000Z",
      bookmarks,
    });
  });

  it("serializes deterministically with stable key order, indentation, and newline", () => {
    const serialized = serializeBookmarkExport(bookmarks, exportedAt);

    expect(serialized).toBe(serializeBookmarkExport(bookmarks, exportedAt));
    expect(serialized.endsWith("}\n")).toBe(true);
    expect(serialized.split("\n")[1]).toBe(
      `  "schema": "${BOOKMARK_TRANSFER_SCHEMA}",`,
    );
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "schema",
      "version",
      "exportedAt",
      "bookmarks",
    ]);
    expect(Object.keys(JSON.parse(serialized).bookmarks[0])).toEqual([
      "id",
      "url",
      "slug",
      "createdAt",
      "title",
      "tags",
      "notes",
    ]);
  });

  it("preserves collection order rather than sorting", () => {
    const reversed = [...bookmarks].reverse();

    expect(
      JSON.parse(serializeBookmarkExport(reversed, exportedAt)).bookmarks.map(
        (bookmark: Bookmark) => bookmark.id,
      ),
    ).toEqual(["second-id", "9f1c7c8e-0a1b-4c2d-8e3f-4a5b6c7d8e9f"]);
  });

  it("does not share tag arrays with the source collection", () => {
    const document = buildTransferDocument(bookmarks, exportedAt);
    document.bookmarks[0]?.tags.push("mutated");

    expect(bookmarks[0]?.tags).toEqual(["reference", "work"]);
  });

  it("names the export file by export date", () => {
    expect(bookmarkExportFileName(exportedAt)).toBe(
      "shortlist-bookmarks-2025-03-04.json",
    );
  });

  it("round-trips every field through decode without change", () => {
    const decoded = decodeBookmarkImport(serializeBookmarkExport(bookmarks, exportedAt));

    expect(decoded.format).toBe("interchange");
    expect(decoded.bookmarks).toEqual(bookmarks);
    expect(decoded.repairs).toEqual({
      ids: 0,
      slugs: 0,
      timestamps: 0,
      urls: 0,
      tags: 0,
    });
  });

  it("round-trips an empty collection", () => {
    expect(
      decodeBookmarkImport(serializeBookmarkExport([], exportedAt)).bookmarks,
    ).toEqual([]);
  });
});

describe("import file guards", () => {
  it("accepts a plausible JSON file", () => {
    expect(() =>
      assertImportFile({ name: "backup.JSON", type: "application/json", size: 40 }),
    ).not.toThrow();
  });

  it("accepts a JSON file with no reported media type", () => {
    expect(() =>
      assertImportFile({ name: "backup.json", type: "", size: 40 }),
    ).not.toThrow();
  });

  it.each([
    ["shortlist.txt", "text/plain", 40],
    ["shortlist.json.exe", "application/octet-stream", 40],
    ["shortlist.json", "image/png", 40],
  ])("rejects %s", (name, type, size) => {
    expect(() => assertImportFile({ name, type, size })).toThrow(BookmarkImportError);
  });

  it("rejects an empty file", () => {
    expect(() =>
      assertImportFile({ name: "a.json", type: "application/json", size: 0 }),
    ).toThrow(/empty/i);
  });

  it("rejects a file above the documented byte limit", () => {
    expect(() =>
      assertImportFile({
        name: "a.json",
        type: "application/json",
        size: MAX_IMPORT_BYTES + 1,
      }),
    ).toThrow(/1.00 MiB or less/);
  });

  it("measures UTF-8 bytes rather than characters", () => {
    expect(byteLength("é")).toBe(2);
    expect(formatByteSize(MAX_IMPORT_BYTES)).toBe("1.00 MiB");
    expect(formatByteSize(2048)).toBe("2.0 KiB");
    expect(formatByteSize(12)).toBe("12 bytes");
  });

  it("rejects oversized text even when the reported file size lied", () => {
    expect(() => decodeBookmarkImport("x".repeat(MAX_IMPORT_BYTES + 1))).toThrow(
      /Choose a file of/,
    );
  });
});

describe("import envelope validation", () => {
  it("reports JSON syntax problems", () => {
    const error = catchImportError(() => decodeBookmarkImport("{ nope"));

    expect(error.code).toBe("syntax");
    expect(error.message).toMatch(/not valid JSON/);
  });

  it.each([
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"hello"'],
    ["an unknown envelope", '{"version":9,"bookmarks":[]}'],
    ["an envelope without a version", '{"bookmarks":[]}'],
  ])("rejects %s", (_label, serialized) => {
    expect(catchImportError(() => decodeBookmarkImport(serialized)).code).toBe(
      "schema",
    );
  });

  it("rejects an unknown interchange schema", () => {
    expect(() =>
      decodeBookmarkImport(
        interchange([], { schema: "https://evil.example/schemas/bookmarks" }),
      ),
    ).toThrow(/unknown schema/);
  });

  it("rejects an unsupported interchange version", () => {
    expect(() => decodeBookmarkImport(interchange([], { version: 2 }))).toThrow(
      /export version 1/,
    );
  });

  it("rejects extra top-level properties", () => {
    expect(() =>
      decodeBookmarkImport(interchange([], { exec: "rm -rf /" })),
    ).toThrow(/unsupported property “exec”/);
  });

  it("rejects a missing top-level property", () => {
    expect(() =>
      decodeBookmarkImport(
        JSON.stringify({
          schema: BOOKMARK_TRANSFER_SCHEMA,
          version: BOOKMARK_TRANSFER_VERSION,
          bookmarks: [],
        }),
      ),
    ).toThrow(/missing the “exportedAt” property/);
  });

  it.each(["not-a-date", "2025-03-04", 17])(
    "rejects an invalid exportedAt: %s",
    (value) => {
      expect(() =>
        decodeBookmarkImport(interchange([], { exportedAt: value })),
      ).toThrow(/exportedAt/);
    },
  );

  it("rejects a non-array bookmarks value", () => {
    expect(() =>
      decodeBookmarkImport(interchange([], { bookmarks: { length: 1 } })),
    ).toThrow(/no “bookmarks” list/);
  });

  it("rejects extra properties on a storage envelope", () => {
    expect(() =>
      decodeBookmarkImport('{"version":3,"bookmarks":[],"extra":1}'),
    ).toThrow(/unsupported property “extra”/);
  });

  it("rejects a collection above the documented maximum", () => {
    const entries = Array.from({ length: MAX_BOOKMARK_COLLECTION + 1 }, (_, index) =>
      coreEntry({ url: `https://example.com/${index}` }),
    );
    const error = catchImportError(() => decodeBookmarkImport(JSON.stringify(entries)));

    expect(error.code).toBe("limit");
    expect(error.message).toMatch(/up to 5000/);
  });
});

describe("schema migrations", () => {
  it("reads the original version 1 bare array", () => {
    const decoded = decodeBookmarkImport(JSON.stringify([coreEntry()]));

    expect(decoded.format).toBe("storage-v1");
    expect(decoded.bookmarks).toEqual([
      {
        id: "original-id",
        url: "https://example.com/original?kept=yes",
        slug: "keep42",
        createdAt: "2024-05-06T07:08:09.000Z",
        title: "example.com",
        tags: [],
        notes: "",
      },
    ]);
  });

  it("repairs the empty identities version 1 storage allowed", () => {
    const decoded = decodeBookmarkImport(
      JSON.stringify([coreEntry({ id: "", slug: "", createdAt: "" })]),
    );

    expect(decoded.bookmarks[0]).toMatchObject({ id: "", slug: "", createdAt: "" });
    expect(decoded.repairs).toMatchObject({ ids: 1, slugs: 1, timestamps: 1 });
  });

  it("clears identities that are present but malformed", () => {
    const decoded = decodeBookmarkImport(
      JSON.stringify([
        coreEntry({
          id: "has spaces and <script>",
          slug: "TOOLONGSLUG",
          createdAt: "yesterday",
        }),
      ]),
    );

    expect(decoded.bookmarks[0]).toMatchObject({ id: "", slug: "", createdAt: "" });
    expect(decoded.repairs).toMatchObject({ ids: 1, slugs: 1, timestamps: 1 });
  });

  it("reads a version 2 envelope of core fields", () => {
    const decoded = decodeBookmarkImport(
      JSON.stringify({ version: 2, bookmarks: [coreEntry()] }),
    );

    expect(decoded.format).toBe("storage-v2");
    expect(decoded.bookmarks[0]).toMatchObject({ title: "example.com", tags: [], notes: "" });
  });

  it("rejects metadata fields inside a core-only envelope", () => {
    expect(() =>
      decodeBookmarkImport(
        JSON.stringify({ version: 2, bookmarks: [coreEntry({ title: "Nope" })] }),
      ),
    ).toThrow(/unsupported property “title”/);
  });

  it("reads a version 3 storage envelope with full fields", () => {
    const decoded = decodeBookmarkImport(
      JSON.stringify({ version: 3, bookmarks: [fullEntry()] }),
    );

    expect(decoded.format).toBe("storage-v3");
    expect(decoded.bookmarks).toEqual([bookmarks[0]]);
  });

  it("repairs legacy identities that reached version 3 through migration", () => {
    const decoded = decodeBookmarkImport(
      JSON.stringify({
        version: 3,
        bookmarks: [fullEntry({ id: "", slug: "", createdAt: "" })],
      }),
    );

    expect(decoded.bookmarks[0]).toMatchObject({
      id: "",
      slug: "",
      createdAt: "",
      title: "Example docs",
    });
  });

  it.each([
    ["id", "not safe!"],
    ["slug", "INVALID"],
    ["createdAt", "2025-02-30T00:00:00.000Z"],
  ])("rejects an invalid current interchange %s", (field, value) => {
    expect(() =>
      decodeBookmarkImport(
        interchange([fullEntry({ [field]: value })]),
      ),
    ).toThrow(new RegExp(`invalid .*${field}`));
  });

  it.each([
    "2025-02-29T00:00:00.000Z",
    "2025-04-31T00:00:00.000Z",
    "2025-01-01T24:00:00.000Z",
    "2025-01-01T00:60:00.000Z",
    "2025-01-01T00:00:60.000Z",
    "2025-01-01T00:00:00+24:00",
  ])("rejects impossible interchange timestamps: %s", (createdAt) => {
    expect(() =>
      decodeBookmarkImport(interchange([fullEntry({ createdAt })])),
    ).toThrow(/invalid “createdAt” timestamp/);
  });

  it("normalizes URLs and counts the repair", () => {
    const decoded = decodeBookmarkImport(
      JSON.stringify([coreEntry({ url: "  https://example.com/a b  " })]),
    );

    expect(decoded.bookmarks[0]?.url).toBe("https://example.com/a%20b");
    expect(decoded.repairs.urls).toBe(1);
  });

  it("normalizes tags and counts the repair", () => {
    const decoded = decodeBookmarkImport(
      interchange([fullEntry({ tags: ["Work", " work ", "reference"] })]),
    );

    expect(decoded.bookmarks[0]?.tags).toEqual(["reference", "work"]);
    expect(decoded.repairs.tags).toBe(1);
  });
});

describe("bookmark field validation", () => {
  it.each([
    ["a non-object entry", ["nope"]],
    ["an array entry", [[]]],
    ["a null entry", [null]],
  ])("rejects %s", (_label, entries) => {
    expect(() => decodeBookmarkImport(JSON.stringify(entries))).toThrow(
      /Bookmark 1 is not an object/,
    );
  });

  it("reports the one-based position of the failing bookmark", () => {
    expect(() =>
      decodeBookmarkImport(
        JSON.stringify([
          coreEntry(),
          coreEntry({ url: "javascript:alert(1)" }),
        ]),
      ),
    ).toThrow(/Bookmark 2 has an unsupported URL/);
  });

  it.each(["javascript:alert(1)", "ftp://example.com", "data:text/html,<x>", "nope"])(
    "rejects the unsupported URL %s",
    (url) => {
      expect(() => decodeBookmarkImport(JSON.stringify([coreEntry({ url })]))).toThrow(
        /unsupported URL/,
      );
    },
  );

  it("rejects an unsupported property on a bookmark", () => {
    expect(() =>
      decodeBookmarkImport(interchange([fullEntry({ isAdmin: true })])),
    ).toThrow(/unsupported property “isAdmin”/);
  });

  it("rejects a prototype pollution attempt instead of applying it", () => {
    const polluted = interchange([fullEntry()]).replace(
      '"id":',
      '"__proto__":{"isAdmin":true},"id":',
    );

    expect(() => decodeBookmarkImport(polluted)).toThrow(
      /unsupported property “__proto__”/,
    );
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("rejects a missing bookmark property", () => {
    const { notes: _notes, ...withoutNotes } = fullEntry();

    expect(() => decodeBookmarkImport(interchange([withoutNotes]))).toThrow(
      /missing the “notes” property/,
    );
  });

  it.each([
    ["id", 7],
    ["slug", null],
    ["createdAt", { toString: 1 }],
    ["url", 42],
    ["title", 5],
    ["notes", ["a"]],
  ])("rejects an ill-typed %s", (field, value) => {
    expect(() => decodeBookmarkImport(interchange([fullEntry({ [field]: value })]))).toThrow(
      BookmarkImportError,
    );
  });

  it("rejects an empty title", () => {
    expect(() => decodeBookmarkImport(interchange([fullEntry({ title: "   " })]))).toThrow(
      /empty title/,
    );
  });

  it("rejects an oversized title", () => {
    expect(() =>
      decodeBookmarkImport(interchange([fullEntry({ title: "t".repeat(121) })])),
    ).toThrow(/longer than 120 characters/);
  });

  it("rejects oversized notes", () => {
    expect(() =>
      decodeBookmarkImport(interchange([fullEntry({ notes: "n".repeat(2001) })])),
    ).toThrow(/longer than 2000 characters/);
  });

  it("rejects tags that are not a list of text", () => {
    expect(() =>
      decodeBookmarkImport(interchange([fullEntry({ tags: [1, 2] })])),
    ).toThrow(/not a list of text/);
  });

  it("rejects too many tags", () => {
    expect(() =>
      decodeBookmarkImport(
        interchange([
          fullEntry({ tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
        ]),
      ),
    ).toThrow(/8 tags or fewer/);
  });

  it("rejects an oversized tag", () => {
    expect(() =>
      decodeBookmarkImport(interchange([fullEntry({ tags: ["x".repeat(25)] })])),
    ).toThrow(/longer than 24 characters/);
  });

  it("rejects an oversized identifier without silently truncating", () => {
    expect(() =>
      decodeBookmarkImport(interchange([fullEntry({ id: "a".repeat(129) })])),
    ).toThrow(/invalid “id”/);
  });
});

describe("identity predicates", () => {
  it.each(["9f1c7c8e-0a1b-4c2d-8e3f-4a5b6c7d8e9f", "original-id", "a_b-1"])(
    "accepts the safe id %s",
    (value) => {
      expect(isSafeId(value)).toBe(true);
    },
  );

  it.each(["", "-leading", "has space", "a".repeat(129), "<script>"])(
    "rejects the unsafe id %s",
    (value) => {
      expect(isSafeId(value)).toBe(false);
    },
  );

  it.each(["abc234", "keep42"])("accepts the slug %s", (value) => {
    expect(isValidSlug(value)).toBe(true);
  });

  it.each(["", "abc23", "abc2345", "ABC234", "abcio1"])(
    "rejects the slug %s",
    (value) => {
      expect(isValidSlug(value)).toBe(false);
    },
  );

  it.each(["2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00+02:00"])(
    "accepts the timestamp %s",
    (value) => {
      expect(isValidTimestamp(value)).toBe(true);
    },
  );

  it.each(["", "2025-01-01", "now", "2025-13-01T00:00:00.000Z"])(
    "rejects the timestamp %s",
    (value) => {
      expect(isValidTimestamp(value)).toBe(false);
    },
  );
});

function catchImportError(run: () => unknown): BookmarkImportError {
  try {
    run();
  } catch (error) {
    if (error instanceof BookmarkImportError) return error;
    throw error;
  }

  throw new Error("Expected a BookmarkImportError.");
}
