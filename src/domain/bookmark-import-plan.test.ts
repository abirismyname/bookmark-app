import { describe, expect, it } from "vitest";
import type { Bookmark } from "./bookmark";
import {
  describeImportAdjustments,
  planBookmarkImport,
  summarizeImportPlan,
  type ImportPlanDependencies,
} from "./bookmark-import-plan";
import { BookmarkImportError, MAX_BOOKMARK_COLLECTION } from "./bookmark-transfer";

const saved: Bookmark[] = [
  {
    id: "saved-1",
    url: "https://example.com/docs",
    slug: "abc234",
    createdAt: "2025-01-01T00:00:00.000Z",
    title: "Saved docs",
    tags: ["reference"],
    notes: "Original note",
  },
  {
    id: "saved-2",
    url: "https://example.org/guide",
    slug: "keep42",
    createdAt: "2025-01-02T00:00:00.000Z",
    title: "Saved guide",
    tags: [],
    notes: "",
  },
];

function candidate(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: "incoming-1",
    url: "https://example.net/new",
    slug: "npq567",
    createdAt: "2025-02-01T00:00:00.000Z",
    title: "Incoming",
    tags: ["inbox"],
    notes: "Incoming note",
    ...overrides,
  };
}

function deterministic(): ImportPlanDependencies {
  let ids = 0;
  let slugs = 0;

  return {
    createId: () => `gen-id-${++ids}`,
    createSlug: () => `gen${String(++slugs).padStart(3, "0")}`,
    now: () => new Date("2025-06-01T12:00:00.000Z"),
  };
}

describe("planBookmarkImport", () => {
  it("appends new bookmarks after the existing collection in file order", () => {
    const plan = planBookmarkImport(
      saved,
      [candidate(), candidate({ id: "incoming-2", url: "https://example.net/other", slug: "rst678" })],
      "skip",
      deterministic(),
    );

    expect(plan.bookmarks.map(({ id }) => id)).toEqual([
      "saved-1",
      "saved-2",
      "incoming-1",
      "incoming-2",
    ]);
    expect(plan).toMatchObject({ added: 2, replaced: 0, skipped: 0, candidates: 2 });
  });

  it("never mutates the existing collection or the candidates", () => {
    const existingSnapshot = structuredClone(saved);
    const candidates = [candidate({ url: "https://example.com/docs" })];
    const candidateSnapshot = structuredClone(candidates);

    const plan = planBookmarkImport(saved, candidates, "replace", deterministic());
    plan.bookmarks[0]!.title = "changed";
    plan.bookmarks[0]!.tags.push("changed");

    expect(saved).toEqual(existingSnapshot);
    expect(candidates).toEqual(candidateSnapshot);
  });

  it("skips duplicates by normalized URL", () => {
    const plan = planBookmarkImport(
      saved,
      [candidate({ url: "https://example.com/docs", title: "Replacement" })],
      "skip",
      deterministic(),
    );

    expect(plan).toMatchObject({ added: 0, skipped: 1, replaced: 0, duplicateUrls: 1 });
    expect(plan.bookmarks).toEqual(saved);
  });

  it("replaces duplicates in place while retaining the saved id and short link", () => {
    const plan = planBookmarkImport(
      saved,
      [
        candidate({
          id: "incoming-1",
          url: "https://example.com/docs",
          slug: "npq567",
          title: "Replacement",
          tags: ["fresh"],
          notes: "Fresh note",
          createdAt: "2025-02-02T00:00:00.000Z",
        }),
      ],
      "replace",
      deterministic(),
    );

    expect(plan).toMatchObject({ added: 0, replaced: 1, skipped: 0, duplicateUrls: 1 });
    expect(plan.bookmarks).toHaveLength(2);
    expect(plan.bookmarks[0]).toEqual({
      id: "saved-1",
      url: "https://example.com/docs",
      slug: "abc234",
      createdAt: "2025-02-02T00:00:00.000Z",
      title: "Replacement",
      tags: ["fresh"],
      notes: "Fresh note",
    });
    expect(plan.bookmarks[1]).toEqual(saved[1]);
  });

  it("keeps curated metadata when a legacy backup replaces a duplicate", () => {
    const plan = planBookmarkImport(
      saved,
      [
        candidate({
          url: "https://example.com/docs",
          title: "example.com",
          tags: [],
          notes: "",
          createdAt: "2025-02-02T00:00:00.000Z",
        }),
      ],
      "replace",
      deterministic(),
      { preserveExistingMetadataOnReplace: true },
    );

    expect(plan.bookmarks[0]).toEqual({
      ...saved[0],
      createdAt: "2025-02-02T00:00:00.000Z",
    });
    expect(plan.preservedMetadata).toBe(1);
    expect(describeImportAdjustments(plan)).toContain(
      "1 came from a legacy backup, so saved titles, tags, and notes will be kept.",
    );
  });

  it("keeps the saved timestamp when a replacement has none", () => {
    const plan = planBookmarkImport(
      saved,
      [candidate({ url: "https://example.com/docs", createdAt: "" })],
      "replace",
      deterministic(),
    );

    expect(plan.bookmarks[0]?.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(plan.repairedIdentities).toBe(0);
  });

  it("repairs a replacement target that carries a legacy empty identity", () => {
    const legacy: Bookmark[] = [{ ...saved[0]!, id: "", slug: "", createdAt: "" }];
    const plan = planBookmarkImport(
      legacy,
      [candidate({ url: "https://example.com/docs", createdAt: "" })],
      "replace",
      deterministic(),
    );

    expect(plan.bookmarks[0]).toMatchObject({
      id: "gen-id-1",
      slug: "gen001",
      createdAt: "2025-06-01T12:00:00.000Z",
    });
    expect(plan.repairedIdentities).toBe(1);
  });

  it("deduplicates repeated URLs inside a single file", () => {
    const plan = planBookmarkImport(
      [],
      [
        candidate({ id: "a", slug: "npq567", title: "First" }),
        candidate({ id: "b", slug: "rst678", title: "Second" }),
      ],
      "skip",
      deterministic(),
    );

    expect(plan.bookmarks).toHaveLength(1);
    expect(plan.bookmarks[0]?.title).toBe("First");
    expect(plan).toMatchObject({ added: 1, skipped: 1, duplicateUrls: 1 });
  });

  it("replaces a within-file duplicate when replacing", () => {
    const plan = planBookmarkImport(
      [],
      [
        candidate({ id: "a", slug: "npq567", title: "First" }),
        candidate({ id: "b", slug: "rst678", title: "Second" }),
      ],
      "replace",
      deterministic(),
    );

    expect(plan.bookmarks).toHaveLength(1);
    expect(plan.bookmarks[0]).toMatchObject({ id: "a", slug: "npq567", title: "Second" });
  });

  it("regenerates an id that collides with an unrelated saved bookmark", () => {
    const plan = planBookmarkImport(
      saved,
      [candidate({ id: "saved-1" })],
      "skip",
      deterministic(),
    );

    expect(plan.idConflicts).toBe(1);
    expect(plan.repairedIdentities).toBe(0);
    expect(plan.bookmarks[2]).toMatchObject({
      id: "gen-id-1",
      slug: "npq567",
      url: "https://example.net/new",
    });
    expect(plan.bookmarks[0]).toEqual(saved[0]);
  });

  it("regenerates a short link that collides with an unrelated saved bookmark", () => {
    const plan = planBookmarkImport(
      saved,
      [candidate({ slug: "abc234" })],
      "skip",
      deterministic(),
    );

    expect(plan.slugConflicts).toBe(1);
    expect(plan.bookmarks[2]).toMatchObject({ id: "incoming-1", slug: "gen001" });
    expect(plan.bookmarks[0]?.slug).toBe("abc234");
  });

  it("resolves collisions between two incoming bookmarks", () => {
    const plan = planBookmarkImport(
      [],
      [
        candidate({ id: "dup", slug: "abc234", url: "https://example.net/1" }),
        candidate({ id: "dup", slug: "abc234", url: "https://example.net/2" }),
      ],
      "skip",
      deterministic(),
    );

    expect(plan.bookmarks.map(({ id }) => id)).toEqual(["dup", "gen-id-1"]);
    expect(plan.bookmarks.map(({ slug }) => slug)).toEqual(["abc234", "gen001"]);
    expect(plan).toMatchObject({ idConflicts: 1, slugConflicts: 1, added: 2 });
  });

  it("fills empty identities left by legacy migrations", () => {
    const plan = planBookmarkImport(
      [],
      [candidate({ id: "", slug: "", createdAt: "" })],
      "skip",
      deterministic(),
    );

    expect(plan.bookmarks[0]).toMatchObject({
      id: "gen-id-1",
      slug: "gen001",
      createdAt: "2025-06-01T12:00:00.000Z",
    });
    expect(plan).toMatchObject({
      repairedIdentities: 1,
      idConflicts: 0,
      slugConflicts: 0,
    });
  });

  it("does not treat an existing empty identity as a taken value", () => {
    const legacy: Bookmark[] = [{ ...saved[0]!, id: "", slug: "" }];
    const plan = planBookmarkImport(
      legacy,
      [candidate({ id: "", slug: "" })],
      "skip",
      deterministic(),
    );

    expect(plan.bookmarks[1]).toMatchObject({ id: "gen-id-1", slug: "gen001" });
    expect(plan.bookmarks[0]).toEqual(legacy[0]);
  });

  it("keeps every unrelated record when resolving collisions", () => {
    const plan = planBookmarkImport(
      saved,
      [
        candidate({ id: "saved-2", slug: "keep42", url: "https://example.net/1" }),
        candidate({ id: "fresh", slug: "wxy789", url: "https://example.net/2" }),
      ],
      "skip",
      deterministic(),
    );

    expect(plan.bookmarks).toHaveLength(4);
    expect(plan.bookmarks.slice(0, 2)).toEqual(saved);
    expect(new Set(plan.bookmarks.map(({ id }) => id)).size).toBe(4);
    expect(new Set(plan.bookmarks.map(({ slug }) => slug)).size).toBe(4);
  });

  it("reflects a collection that changed since the plan was last built", () => {
    const candidates = [candidate()];
    const preview = planBookmarkImport(saved, candidates, "skip", deterministic());
    const addedSincePreview: Bookmark = {
      id: "saved-3",
      url: "https://example.dev/added",
      slug: "wxy789",
      createdAt: "2025-01-03T00:00:00.000Z",
      title: "Added while previewing",
      tags: [],
      notes: "",
    };

    const applied = planBookmarkImport(
      [...saved, addedSincePreview],
      candidates,
      "skip",
      deterministic(),
    );

    expect(preview.bookmarks).toHaveLength(3);
    expect(applied.bookmarks).toHaveLength(4);
    expect(applied.bookmarks[2]).toEqual(addedSincePreview);
    expect(applied).toMatchObject({ added: 1, skipped: 0 });
  });

  it("drops a candidate that duplicates a URL added since the plan was built", () => {
    const candidates = [candidate()];
    const applied = planBookmarkImport(
      [...saved, { ...candidate(), id: "saved-3", slug: "wxy789" }],
      candidates,
      "skip",
      deterministic(),
    );

    expect(applied).toMatchObject({ added: 0, skipped: 1, duplicateUrls: 1 });
    expect(applied.bookmarks).toHaveLength(3);
  });

  it("replaces everything when the existing collection is unreadable", () => {
    const plan = planBookmarkImport([], [candidate()], "replace", deterministic());

    expect(plan.bookmarks).toEqual([candidate()]);
  });

  it("rejects a plan above the documented collection maximum", () => {
    const existing = Array.from({ length: MAX_BOOKMARK_COLLECTION }, (_, index) => ({
      ...saved[0]!,
      id: `saved-${index}`,
      slug: `s${String(index).padStart(5, "a")}`,
      url: `https://example.com/${index}`,
    }));

    expect(() =>
      planBookmarkImport(existing, [candidate()], "skip", deterministic()),
    ).toThrow(BookmarkImportError);
  });

  it("fails loudly when an injected id generator cannot produce a unique value", () => {
    expect(() =>
      planBookmarkImport(saved, [candidate({ id: "saved-1" })], "skip", {
        ...deterministic(),
        createId: () => "saved-1",
      }),
    ).toThrow(/unique bookmark ID/);
  });

  it("fails loudly when an injected slug generator cannot produce a unique value", () => {
    expect(() =>
      planBookmarkImport(saved, [candidate({ slug: "abc234" })], "skip", {
        ...deterministic(),
        createSlug: () => "abc234",
      }),
    ).toThrow(/unique short link/);
  });

  it("falls back to built-in generators when none are injected", () => {
    const plan = planBookmarkImport(saved, [candidate({ id: "", slug: "" })], "skip");
    const created = plan.bookmarks[2]!;

    expect(created.id).not.toBe("");
    expect(created.slug).toHaveLength(6);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("import plan summaries", () => {
  it("summarizes a skip plan", () => {
    const plan = planBookmarkImport(
      saved,
      [candidate(), candidate({ url: "https://example.com/docs" })],
      "skip",
      deterministic(),
    );

    expect(summarizeImportPlan(plan)).toBe(
      "2 bookmarks read, 1 to add, 1 duplicate skip, 3 total after import.",
    );
    expect(describeImportAdjustments(plan)).toEqual([
      "1 matched an existing URL and will be skipped.",
    ]);
  });

  it("summarizes a replace plan with every adjustment", () => {
    const plan = planBookmarkImport(
      saved,
      [
        candidate({ url: "https://example.com/docs" }),
        candidate({ id: "saved-2", url: "https://example.net/1" }),
        candidate({ slug: "keep42", url: "https://example.net/2" }),
        candidate({ id: "", slug: "", createdAt: "", url: "https://example.net/3" }),
      ],
      "replace",
      deterministic(),
    );

    expect(summarizeImportPlan(plan)).toBe(
      "4 bookmarks read, 3 to add, 1 to replace, 5 total after import.",
    );
    expect(describeImportAdjustments(plan)).toEqual([
      "1 matched an existing URL and will be replaced in place, keeping the saved short link.",
      "1 reused an existing ID and will get a new one.",
      "1 reused an existing short link and will get a new one.",
      "1 were missing an ID, short link, or date and will be repaired.",
    ]);
  });

  it("reports no adjustments for a clean import", () => {
    expect(
      describeImportAdjustments(
        planBookmarkImport(saved, [candidate()], "skip", deterministic()),
      ),
    ).toEqual([]);
  });
});
