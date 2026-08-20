export interface Bookmark {
  id: string;
  url: string;
  slug: string;
  createdAt: string;
  title: string;
  tags: string[];
  notes: string;
}

export type BookmarkSort = "newest" | "oldest" | "title";

export interface BookmarkMetadata {
  title: string;
  tags: string | Iterable<string>;
  notes: string;
}

export interface BookmarkSelection {
  query?: string;
  tag?: string;
  sort?: BookmarkSort;
}

export interface BookmarkCreationDependencies {
  createId: () => string;
  now: () => Date;
  fillRandomValues: (values: Uint32Array) => Uint32Array;
}

export const SLUG_LENGTH = 6;
export const SLUG_CHARACTERS = "abcdefghjkmnpqrstuvwxyz23456789";
export const MAX_TITLE_LENGTH = 120;
export const MAX_NOTES_LENGTH = 2_000;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;

export function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isBookmark(value: unknown): value is Bookmark {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "string" &&
    typeof item.url === "string" &&
    typeof item.slug === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.title === "string" &&
    item.title.trim().length > 0 &&
    item.title.length <= MAX_TITLE_LENGTH &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === "string") &&
    arraysEqual(item.tags, normalizeTags(item.tags)) &&
    typeof item.notes === "string" &&
    item.notes.length <= MAX_NOTES_LENGTH &&
    normalizeUrl(item.url) !== null
  );
}

export function isBookmarkCore(
  value: unknown,
): value is Pick<Bookmark, "id" | "url" | "slug" | "createdAt"> {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "string" &&
    typeof item.url === "string" &&
    typeof item.slug === "string" &&
    typeof item.createdAt === "string" &&
    normalizeUrl(item.url) !== null
  );
}

export function defaultBookmarkTitle(url: string): string {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    throw new TypeError("A valid http or https URL is required.");
  }

  return new URL(normalizedUrl)
    .hostname.replace(/^www\./i, "")
    .slice(0, MAX_TITLE_LENGTH);
}

export function normalizeTags(tags: string | Iterable<string>): string[] {
  const values = typeof tags === "string" ? [tags] : tags;
  const normalized = new Set<string>();

  for (const value of values) {
    for (const tag of value.split(",")) {
      const cleanTag = tag.trim().toLowerCase();
      if (cleanTag) normalized.add(cleanTag);
    }
  }

  return [...normalized].sort(compareText);
}

export function withMetadataDefaults(
  bookmark: Pick<Bookmark, "id" | "url" | "slug" | "createdAt">,
): Bookmark {
  return {
    ...bookmark,
    title: defaultBookmarkTitle(bookmark.url),
    tags: [],
    notes: "",
  };
}

export function updateBookmarkMetadata(
  bookmark: Bookmark,
  metadata: BookmarkMetadata,
): Bookmark {
  const title = metadata.title.trim();
  const notes = metadata.notes.trim();
  const tags = normalizeTags(metadata.tags);

  if (!title) throw new TypeError("Title is required.");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new TypeError(`Title must be ${MAX_TITLE_LENGTH} characters or fewer.`);
  }
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new TypeError(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`);
  }
  if (tags.length > MAX_TAGS) {
    throw new TypeError(`Use ${MAX_TAGS} tags or fewer.`);
  }
  if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new TypeError(`Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`);
  }

  return { ...bookmark, title, tags, notes };
}

export function selectBookmarks(
  bookmarks: readonly Bookmark[],
  selection: BookmarkSelection = {},
): Bookmark[] {
  const queryTokens = (selection.query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const activeTag = normalizeTags(selection.tag ?? "")[0];
  const matches = bookmarks.filter((bookmark) => {
    if (activeTag && !bookmark.tags.includes(activeTag)) return false;
    if (queryTokens.length === 0) return true;

    const searchable = [
      bookmark.title,
      bookmark.url,
      bookmark.tags.join(" "),
      bookmark.notes,
      bookmark.slug,
    ]
      .join("\n")
      .toLowerCase();

    return queryTokens.every((token) => searchable.includes(token));
  });

  return sortBookmarks(matches, selection.sort ?? "newest");
}

export function sortBookmarks(
  bookmarks: readonly Bookmark[],
  sort: BookmarkSort,
): Bookmark[] {
  return bookmarks
    .map((bookmark, index) => ({ bookmark, index }))
    .sort((left, right) => {
      let order = 0;
      if (sort === "title") {
        order = compareText(
          left.bookmark.title.toLowerCase(),
          right.bookmark.title.toLowerCase(),
        );
      } else {
        const direction = sort === "newest" ? -1 : 1;
        order =
          direction *
          (sortableTimestamp(left.bookmark.createdAt) -
            sortableTimestamp(right.bookmark.createdAt));
      }

      return order || left.index - right.index;
    })
    .map(({ bookmark }) => bookmark);
}

export function collectTags(bookmarks: readonly Bookmark[]): string[] {
  return normalizeTags(bookmarks.flatMap((bookmark) => bookmark.tags));
}

export function createUniqueSlug(
  existingSlugs: Iterable<string>,
  fillRandomValues: (values: Uint32Array) => Uint32Array = (values) =>
    crypto.getRandomValues(values),
): string {
  const usedSlugs = new Set(existingSlugs);
  const values = new Uint32Array(SLUG_LENGTH);
  let slug: string;

  do {
    fillRandomValues(values);
    slug = Array.from(
      values,
      (value) => SLUG_CHARACTERS[value % SLUG_CHARACTERS.length],
    ).join("");
  } while (usedSlugs.has(slug));

  return slug;
}

export function createBookmark(
  url: string,
  existingBookmarks: readonly Bookmark[],
  dependencies: BookmarkCreationDependencies = {
    createId: () => crypto.randomUUID(),
    now: () => new Date(),
    fillRandomValues: (values) => crypto.getRandomValues(values),
  },
): Bookmark {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    throw new TypeError("A valid http or https URL is required.");
  }

  return {
    id: dependencies.createId(),
    url: normalizedUrl,
    slug: createUniqueSlug(
      existingBookmarks.map((bookmark) => bookmark.slug),
      dependencies.fillRandomValues,
    ),
    createdAt: dependencies.now().toISOString(),
    title: defaultBookmarkTitle(normalizedUrl),
    tags: [],
    notes: "",
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortableTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function arraysEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
