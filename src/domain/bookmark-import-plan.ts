import { createUniqueSlug, type Bookmark } from "./bookmark";
import { BookmarkImportError, MAX_BOOKMARK_COLLECTION } from "./bookmark-transfer";

/**
 * How an imported bookmark whose normalized URL already exists is handled.
 * `skip` keeps the saved bookmark untouched; `replace` overwrites its title,
 * tags, notes, and timestamp while retaining the saved `id` and `slug` so
 * existing short links keep working.
 */
export type ImportDuplicateStrategy = "skip" | "replace";

export interface ImportPlanDependencies {
  createId: () => string;
  createSlug: (usedSlugs: ReadonlySet<string>) => string;
  now: () => Date;
}

export interface BookmarkImportPlan {
  strategy: ImportDuplicateStrategy;
  /** Full collection to persist. Never shares objects with the prior state. */
  bookmarks: Bookmark[];
  candidates: number;
  added: number;
  replaced: number;
  skipped: number;
  duplicateUrls: number;
  idConflicts: number;
  slugConflicts: number;
  repairedIdentities: number;
  preservedMetadata: number;
}

export interface BookmarkImportOptions {
  preserveExistingMetadataOnReplace?: boolean;
}

const MAX_GENERATOR_ATTEMPTS = 1_000;

const defaultDependencies: ImportPlanDependencies = {
  createId: () => crypto.randomUUID(),
  createSlug: (usedSlugs) => createUniqueSlug(usedSlugs),
  now: () => new Date(),
};

/**
 * Builds the complete collection an import would persist. Pure: the inputs are
 * never mutated, and identifier generation is injectable so the plan is
 * reproducible in tests.
 */
export function planBookmarkImport(
  existing: readonly Bookmark[],
  candidates: readonly Bookmark[],
  strategy: ImportDuplicateStrategy,
  dependencies: Partial<ImportPlanDependencies> = {},
  options: BookmarkImportOptions = {},
): BookmarkImportPlan {
  const { createId, createSlug, now } = { ...defaultDependencies, ...dependencies };
  const bookmarks = existing.map((bookmark) => ({ ...bookmark, tags: [...bookmark.tags] }));
  const usedIds = new Set(bookmarks.map(({ id }) => id).filter(Boolean));
  const usedSlugs = new Set(bookmarks.map(({ slug }) => slug).filter(Boolean));
  const indexByUrl = new Map<string, number>();
  bookmarks.forEach((bookmark, index) => {
    if (!indexByUrl.has(bookmark.url)) indexByUrl.set(bookmark.url, index);
  });

  const plan: BookmarkImportPlan = {
    strategy,
    bookmarks,
    candidates: candidates.length,
    added: 0,
    replaced: 0,
    skipped: 0,
    duplicateUrls: 0,
    idConflicts: 0,
    slugConflicts: 0,
    repairedIdentities: 0,
    preservedMetadata: 0,
  };

  for (const candidate of candidates) {
    const duplicateIndex = indexByUrl.get(candidate.url);
    if (duplicateIndex !== undefined) {
      plan.duplicateUrls += 1;
      if (strategy === "skip") {
        plan.skipped += 1;
        continue;
      }

      const saved = bookmarks[duplicateIndex] as Bookmark;
      let repaired = false;
      let id = saved.id;
      let slug = saved.slug;
      let createdAt = candidate.createdAt || saved.createdAt;
      if (!id) {
        id = nextId(usedIds, createId);
        repaired = true;
      }
      if (!slug) {
        slug = nextSlug(usedSlugs, createSlug);
        repaired = true;
      }
      if (!createdAt) {
        createdAt = now().toISOString();
        repaired = true;
      }
      usedIds.add(id);
      usedSlugs.add(slug);
      if (repaired) plan.repairedIdentities += 1;

      bookmarks[duplicateIndex] = {
        ...candidate,
        id,
        slug,
        createdAt,
        title: options.preserveExistingMetadataOnReplace
          ? saved.title
          : candidate.title,
        tags: options.preserveExistingMetadataOnReplace
          ? [...saved.tags]
          : [...candidate.tags],
        notes: options.preserveExistingMetadataOnReplace
          ? saved.notes
          : candidate.notes,
      };
      if (options.preserveExistingMetadataOnReplace) {
        plan.preservedMetadata += 1;
      }
      plan.replaced += 1;
      continue;
    }

    let repaired = false;
    let id = candidate.id;
    if (!id) {
      id = nextId(usedIds, createId);
      repaired = true;
    } else if (usedIds.has(id)) {
      id = nextId(usedIds, createId);
      plan.idConflicts += 1;
    }
    usedIds.add(id);

    let slug = candidate.slug;
    if (!slug) {
      slug = nextSlug(usedSlugs, createSlug);
      repaired = true;
    } else if (usedSlugs.has(slug)) {
      slug = nextSlug(usedSlugs, createSlug);
      plan.slugConflicts += 1;
    }
    usedSlugs.add(slug);

    let createdAt = candidate.createdAt;
    if (!createdAt) {
      createdAt = now().toISOString();
      repaired = true;
    }
    if (repaired) plan.repairedIdentities += 1;

    indexByUrl.set(candidate.url, bookmarks.length);
    bookmarks.push({ ...candidate, id, slug, createdAt, tags: [...candidate.tags] });
    plan.added += 1;
  }

  if (bookmarks.length > MAX_BOOKMARK_COLLECTION) {
    throw new BookmarkImportError(
      `This import would store ${bookmarks.length} bookmarks. Shortlist keeps up to ${MAX_BOOKMARK_COLLECTION}.`,
      "limit",
    );
  }

  return plan;
}

export function summarizeImportPlan(plan: BookmarkImportPlan): string {
  const parts = [
    `${plan.candidates} ${plan.candidates === 1 ? "bookmark" : "bookmarks"} read`,
    `${plan.added} to add`,
  ];
  if (plan.strategy === "replace") parts.push(`${plan.replaced} to replace`);
  else parts.push(`${plan.skipped} duplicate ${plan.skipped === 1 ? "skip" : "skips"}`);
  parts.push(`${plan.bookmarks.length} total after import`);

  return `${parts.join(", ")}.`;
}

export function describeImportAdjustments(plan: BookmarkImportPlan): string[] {
  const details: string[] = [];
  if (plan.duplicateUrls > 0) {
    details.push(
      `${plan.duplicateUrls} matched an existing URL and will be ${plan.strategy === "skip" ? "skipped" : "replaced in place, keeping the saved short link"}.`,
    );
  }
  if (plan.idConflicts > 0) {
    details.push(`${plan.idConflicts} reused an existing ID and will get a new one.`);
  }
  if (plan.slugConflicts > 0) {
    details.push(
      `${plan.slugConflicts} reused an existing short link and will get a new one.`,
    );
  }
  if (plan.repairedIdentities > 0) {
    details.push(
      `${plan.repairedIdentities} were missing an ID, short link, or date and will be repaired.`,
    );
  }
  if (plan.preservedMetadata > 0) {
    details.push(
      `${plan.preservedMetadata} came from a legacy backup, so saved titles, tags, and notes will be kept.`,
    );
  }

  return details;
}

function nextId(usedIds: ReadonlySet<string>, createId: () => string): string {
  for (let attempt = 0; attempt < MAX_GENERATOR_ATTEMPTS; attempt += 1) {
    const id = createId();
    if (id && !usedIds.has(id)) return id;
  }

  throw new BookmarkImportError(
    "Could not generate a unique bookmark ID for this import.",
    "limit",
  );
}

function nextSlug(
  usedSlugs: ReadonlySet<string>,
  createSlug: (usedSlugs: ReadonlySet<string>) => string,
): string {
  for (let attempt = 0; attempt < MAX_GENERATOR_ATTEMPTS; attempt += 1) {
    const slug = createSlug(usedSlugs);
    if (slug && !usedSlugs.has(slug)) return slug;
  }

  throw new BookmarkImportError(
    "Could not generate a unique short link for this import.",
    "limit",
  );
}
