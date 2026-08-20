import { describe, expect, it } from "vitest";
import {
  SLUG_CHARACTERS,
  createBookmark,
  createUniqueSlug,
  isBookmark,
  normalizeUrl,
  type Bookmark,
} from "./bookmark";

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
  const bookmark: Bookmark = {
    id: "bookmark-1",
    url: "https://example.com",
    slug: "abc234",
    createdAt: "2025-01-01T00:00:00.000Z",
  };

  it("accepts the complete bookmark shape", () => {
    expect(isBookmark(bookmark)).toBe(true);
  });

  it.each([
    null,
    {},
    { ...bookmark, id: 1 },
    { ...bookmark, url: "ftp://example.com" },
    { ...bookmark, slug: null },
    { ...bookmark, createdAt: undefined },
  ])("rejects invalid values", (value) => {
    expect(isBookmark(value)).toBe(false);
  });

  it("retains compatibility with v1 string fields", () => {
    expect(isBookmark({ ...bookmark, id: "", slug: "", createdAt: "" })).toBe(true);
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
