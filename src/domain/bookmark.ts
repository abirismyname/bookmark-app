export interface Bookmark {
  id: string;
  url: string;
  slug: string;
  createdAt: string;
}

export interface BookmarkCreationDependencies {
  createId: () => string;
  now: () => Date;
  fillRandomValues: (values: Uint32Array) => Uint32Array;
}

export const SLUG_LENGTH = 6;
export const SLUG_CHARACTERS = "abcdefghjkmnpqrstuvwxyz23456789";

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
    normalizeUrl(item.url) !== null
  );
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
  };
}
