import { describe, expect, it } from "vitest";
import {
  MAX_NOTES_LENGTH,
  SLUG_CHARACTERS,
  collectTags,
  createBookmark,
  createUniqueSlug,
  defaultBookmarkTitle,
  isBookmark,
  normalizeUrl,
  normalizeTags,
  selectBookmarks,
  sortBookmarks,
  updateBookmarkMetadata,
  withMetadataDefaults,
  type Bookmark,
} from "./bookmark";

const baseBookmark: Bookmark = {
  id: "bookmark-1",
  url: "https://example.com/docs",
  slug: "abc234",
  createdAt: "2025-01-01T00:00:00.000Z",
  title: "Example docs",
  tags: ["reference"],
  notes: "Useful documentation",
};

describe("normalizeUrl", () => {
  it.each([
    [" https://example.com/path ", "https://example.com/path"],
    ["http://example.com", "http://example.com/"],
    ["https://example.com/a b", "https://example.com/a%20b"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it.each(["", "example.com", "ftp://example.com", "javascript:alert(1)", "not a url"])(
    "rejects %s",
    (input) => {
      expect(normalizeUrl(input)).toBeNull();
    },
  );
});

describe("isBookmark", () => {
  it("accepts the complete bookmark shape", () => {
    expect(isBookmark(baseBookmark)).toBe(true);
  });

  it.each([
    null,
    {},
    { ...baseBookmark, id: 1 },
    { ...baseBookmark, url: "ftp://example.com" },
    { ...baseBookmark, slug: null },
    { ...baseBookmark, createdAt: undefined },
    { ...baseBookmark, title: "" },
    { ...baseBookmark, tags: ["Reference"] },
    { ...baseBookmark, notes: null },
  ])("rejects invalid values", (value) => {
    expect(isBookmark(value)).toBe(false);
  });

  it("retains compatibility with v1 string fields", () => {
    expect(
      isBookmark({ ...baseBookmark, id: "", slug: "", createdAt: "" }),
    ).toBe(true);
  });
});

describe("bookmark metadata", () => {
  it("derives a readable title from a normalized URL", () => {
    expect(defaultBookmarkTitle("https://www.Example.com/path")).toBe("example.com");
  });

  it("bounds generated titles so newly saved and migrated data stays valid", () => {
    const longHostname = `${"a".repeat(60)}.${"b".repeat(60)}.example.com`;
    const bookmark = createBookmark(`https://${longHostname}/path`, [], {
      createId: () => "long-host",
      now: () => new Date("2025-01-01T00:00:00.000Z"),
      fillRandomValues: (values) => values.fill(0),
    });

    expect(bookmark.title).toHaveLength(120);
    expect(isBookmark(bookmark)).toBe(true);
  });

  it("adds safe metadata defaults without changing core bookmark fields", () => {
    const core = {
      id: "kept-id",
      url: "https://example.com/path",
      slug: "keep42",
      createdAt: "2024-05-06T07:08:09.000Z",
    };

    expect(withMetadataDefaults(core)).toEqual({
      ...core,
      title: "example.com",
      tags: [],
      notes: "",
    });
  });

  it("normalizes, de-duplicates, and sorts comma-separated tags", () => {
    expect(normalizeTags([" Work, Reference ", "work", "To Read"])).toEqual([
      "reference",
      "to read",
      "work",
    ]);
    expect(collectTags([{ ...baseBookmark, tags: ["work", "reference"] }])).toEqual([
      "reference",
      "work",
    ]);
  });

  it("updates only editable metadata", () => {
    const updated = updateBookmarkMetadata(baseBookmark, {
      title: "  Better title ",
      tags: "Work, reference, work",
      notes: "  Remember this section. ",
    });

    expect(updated).toEqual({
      ...baseBookmark,
      title: "Better title",
      tags: ["reference", "work"],
      notes: "Remember this section.",
    });
    expect(updated.id).toBe(baseBookmark.id);
    expect(updated.url).toBe(baseBookmark.url);
    expect(updated.slug).toBe(baseBookmark.slug);
    expect(updated.createdAt).toBe(baseBookmark.createdAt);
  });

  it("validates required and bounded metadata", () => {
    expect(() =>
      updateBookmarkMetadata(baseBookmark, { title: " ", tags: "", notes: "" }),
    ).toThrow("Title is required.");
    expect(() =>
      updateBookmarkMetadata(baseBookmark, {
        title: "Valid",
        tags: "",
        notes: "x".repeat(MAX_NOTES_LENGTH + 1),
      }),
    ).toThrow("Notes must be");
    expect(() =>
      updateBookmarkMetadata(baseBookmark, {
        title: "Valid",
        tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`),
        notes: "",
      }),
    ).toThrow("Use 8 tags or fewer.");
    expect(() =>
      updateBookmarkMetadata(baseBookmark, {
        title: "Valid",
        tags: "x".repeat(25),
        notes: "",
      }),
    ).toThrow("Each tag must be 24 characters or fewer.");
  });
});

describe("createUniqueSlug", () => {
  it("maps injected random values to the existing slug alphabet", () => {
    const slug = createUniqueSlug([], (values) => {
      values.set([0, 1, 2, 3, 4, 5]);
      return values;
    });

    expect(slug).toBe(SLUG_CHARACTERS.slice(0, 6));
  });

  it("retries until it finds a collision-free slug", () => {
    const first = SLUG_CHARACTERS[0]!.repeat(6);
    let attempts = 0;

    const slug = createUniqueSlug([first], (values) => {
      values.fill(attempts++);
      return values;
    });

    expect(slug).toBe(SLUG_CHARACTERS[1]!.repeat(6));
    expect(attempts).toBe(2);
  });
});

describe("createBookmark", () => {
  it("uses injectable identity, clock, and randomness dependencies", () => {
    const bookmark = createBookmark("https://example.com", [], {
      createId: () => "fixed-id",
      now: () => new Date("2025-02-03T04:05:06.000Z"),
      fillRandomValues: (values) => {
        values.fill(0);
        return values;
      },
    });

    expect(bookmark).toEqual({
      id: "fixed-id",
      url: "https://example.com/",
      slug: SLUG_CHARACTERS[0]!.repeat(6),
      createdAt: "2025-02-03T04:05:06.000Z",
      title: "example.com",
      tags: [],
      notes: "",
    });
  });

  describe("bookmark selection", () => {
    const bookmarks: Bookmark[] = [
      {
        ...baseBookmark,
        id: "new",
        title: "Zebra guide",
        tags: ["work"],
        notes: "Review typography",
        createdAt: "2025-03-01T00:00:00.000Z",
      },
      {
        ...baseBookmark,
        id: "old",
        url: "https://developer.mozilla.org/css",
        slug: "css222",
        title: "CSS reference",
        tags: ["reference", "work"],
        notes: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        ...baseBookmark,
        id: "middle",
        url: "https://news.example.org",
        slug: "news42",
        title: "Morning reading",
        tags: ["personal"],
        notes: "Typography roundup",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    ];

    it.each([
      ["title", "css reference", ["old"]],
      ["URL", "mozilla", ["old"]],
      ["tag", "personal", ["middle"]],
      ["notes", "roundup", ["middle"]],
      ["slug", "news42", ["middle"]],
      ["multi-token AND query", "typography zebra", ["new"]],
    ])("searches %s fields", (_label, query, expected) => {
      expect(selectBookmarks(bookmarks, { query }).map(({ id }) => id)).toEqual(
        expected,
      );
    });

    it("filters tags by normalized exact match and combines with search", () => {
      expect(
        selectBookmarks(bookmarks, { tag: " WORK ", query: "reference" }).map(
          ({ id }) => id,
        ),
      ).toEqual(["old"]);
      expect(selectBookmarks(bookmarks, { tag: "read" })).toEqual([]);
    });

    it("sorts newest, oldest, and title without mutating input", () => {
      expect(sortBookmarks(bookmarks, "newest").map(({ id }) => id)).toEqual([
        "new",
        "middle",
        "old",
      ]);
      expect(sortBookmarks(bookmarks, "oldest").map(({ id }) => id)).toEqual([
        "old",
        "middle",
        "new",
      ]);
      expect(sortBookmarks(bookmarks, "title").map(({ id }) => id)).toEqual([
        "old",
        "middle",
        "new",
      ]);
      expect(bookmarks.map(({ id }) => id)).toEqual(["new", "old", "middle"]);
    });

    it("preserves input order for equal and invalid sort keys", () => {
      const ties = [
        { ...baseBookmark, id: "first", createdAt: "" },
        { ...baseBookmark, id: "second", createdAt: "invalid" },
      ];

      expect(sortBookmarks(ties, "newest").map(({ id }) => id)).toEqual([
        "first",
        "second",
      ]);
      expect(sortBookmarks(ties, "title").map(({ id }) => id)).toEqual([
        "first",
        "second",
      ]);
    });
  });

  it("rejects an invalid URL", () => {
    expect(() =>
      createBookmark("ftp://example.com", [], {
        createId: () => "unused",
        now: () => new Date(0),
        fillRandomValues: (values) => values,
      }),
    ).toThrow(TypeError);
  });
});
