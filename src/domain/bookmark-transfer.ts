import {
  MAX_NOTES_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  SLUG_CHARACTERS,
  SLUG_LENGTH,
  normalizeTags,
  normalizeUrl,
  withMetadataDefaults,
  type Bookmark,
} from "./bookmark";

/** Stable identifier for the portable Shortlist interchange format. */
export const BOOKMARK_TRANSFER_SCHEMA = "https://shortlist.local/schemas/bookmarks";
/** Interchange revision. Bump only for breaking interchange changes. */
export const BOOKMARK_TRANSFER_VERSION = 1;
/** Largest import payload accepted, in bytes (1 MiB). */
export const MAX_IMPORT_BYTES = 1_048_576;
/** Largest bookmark collection accepted by an import or produced by a plan. */
export const MAX_BOOKMARK_COLLECTION = 5_000;
/** Largest accepted bookmark identifier length. */
export const MAX_ID_LENGTH = 128;

export interface BookmarkTransferDocument {
  schema: typeof BOOKMARK_TRANSFER_SCHEMA;
  version: typeof BOOKMARK_TRANSFER_VERSION;
  exportedAt: string;
  bookmarks: Bookmark[];
}

export type BookmarkImportFormat =
  | "interchange"
  | "storage-v3"
  | "storage-v2"
  | "storage-v1";

export type BookmarkImportErrorCode =
  | "file"
  | "size"
  | "syntax"
  | "schema"
  | "bookmark"
  | "limit";

export class BookmarkImportError extends Error {
  constructor(
    message: string,
    readonly code: BookmarkImportErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BookmarkImportError";
  }
}

/** Counts of values a migration canonicalized while reading an import. */
export interface ImportRepairSummary {
  ids: number;
  slugs: number;
  timestamps: number;
  urls: number;
  tags: number;
}

export interface DecodedBookmarkImport {
  format: BookmarkImportFormat;
  /**
   * Candidate bookmarks in file order. `id`, `slug`, and `createdAt` are empty
   * strings when the source value was missing or unusable; `planBookmarkImport`
   * assigns deterministic replacements alongside collision handling.
   */
  bookmarks: Bookmark[];
  repairs: ImportRepairSummary;
}

export interface ImportFileLike {
  name: string;
  type: string;
  size: number;
}

const CORE_BOOKMARK_KEYS = ["id", "url", "slug", "createdAt"] as const;
const FULL_BOOKMARK_KEYS = [
  ...CORE_BOOKMARK_KEYS,
  "title",
  "tags",
  "notes",
] as const;
const INTERCHANGE_KEYS = ["schema", "version", "exportedAt", "bookmarks"] as const;
const STORAGE_ENVELOPE_KEYS = ["version", "bookmarks"] as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function buildTransferDocument(
  bookmarks: readonly Bookmark[],
  exportedAt: Date = new Date(),
): BookmarkTransferDocument {
  return {
    schema: BOOKMARK_TRANSFER_SCHEMA,
    version: BOOKMARK_TRANSFER_VERSION,
    exportedAt: exportedAt.toISOString(),
    bookmarks: bookmarks.map(toTransferBookmark),
  };
}

/**
 * Renders a deterministic export: collection order, canonical key order, two
 * space indentation, and a trailing newline.
 */
export function serializeBookmarkExport(
  bookmarks: readonly Bookmark[],
  exportedAt: Date = new Date(),
): string {
  return `${JSON.stringify(buildTransferDocument(bookmarks, exportedAt), null, 2)}\n`;
}

export function bookmarkExportFileName(exportedAt: Date = new Date()): string {
  return `shortlist-bookmarks-${exportedAt.toISOString().slice(0, 10)}.json`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(2)} MiB`;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Throws when a chosen file is the wrong type, empty, or too large to read. */
export function assertImportFile(file: ImportFileLike): void {
  const hasJsonName = /\.json$/i.test(file.name.trim());
  const hasJsonType =
    file.type === "" ||
    file.type === "application/json" ||
    file.type === "text/json" ||
    file.type === "text/plain";

  if (!hasJsonName || !hasJsonType) {
    throw new BookmarkImportError(
      "Choose a .json file exported from Shortlist.",
      "file",
    );
  }
  if (file.size <= 0) {
    throw new BookmarkImportError("That file is empty.", "file");
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new BookmarkImportError(
      `That file is ${formatByteSize(file.size)}. Choose a file of ${formatByteSize(MAX_IMPORT_BYTES)} or less.`,
      "size",
    );
  }
}

export function decodeBookmarkImport(text: string): DecodedBookmarkImport {
  const bytes = byteLength(text);
  if (bytes > MAX_IMPORT_BYTES) {
    throw new BookmarkImportError(
      `That file is ${formatByteSize(bytes)}. Choose a file of ${formatByteSize(MAX_IMPORT_BYTES)} or less.`,
      "size",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new BookmarkImportError(
      `That file is not valid JSON. ${cause instanceof Error ? cause.message : "Check the file and try again."}`,
      "syntax",
      { cause },
    );
  }

  const repairs: ImportRepairSummary = {
    ids: 0,
    slugs: 0,
    timestamps: 0,
    urls: 0,
    tags: 0,
  };
  const { format, entries } = readEnvelope(value);
  if (entries.length > MAX_BOOKMARK_COLLECTION) {
    throw new BookmarkImportError(
      `That file holds ${entries.length} bookmarks. Shortlist imports up to ${MAX_BOOKMARK_COLLECTION}.`,
      "limit",
    );
  }

  const bookmarks = entries.map((entry, index) =>
    parseCandidate(entry, index, format, repairs),
  );

  return { format, bookmarks, repairs };
}

function readEnvelope(value: unknown): {
  format: BookmarkImportFormat;
  entries: unknown[];
} {
  if (Array.isArray(value)) {
    return { format: "storage-v1", entries: value };
  }
  if (!value || typeof value !== "object") {
    throw unrecognized();
  }

  const envelope = value as Record<string, unknown>;
  if (Object.hasOwn(envelope, "schema")) {
    assertExactKeys(envelope, INTERCHANGE_KEYS, "This export");
    if (envelope.schema !== BOOKMARK_TRANSFER_SCHEMA) {
      throw new BookmarkImportError(
        `This export declares an unknown schema. Shortlist reads “${BOOKMARK_TRANSFER_SCHEMA}”.`,
        "schema",
      );
    }
    if (envelope.version !== BOOKMARK_TRANSFER_VERSION) {
      throw new BookmarkImportError(
        `This export declares version ${JSON.stringify(envelope.version)}. Shortlist reads export version ${BOOKMARK_TRANSFER_VERSION}.`,
        "schema",
      );
    }
    if (
      typeof envelope.exportedAt !== "string" ||
      !isValidTimestamp(envelope.exportedAt)
    ) {
      throw new BookmarkImportError(
        "This export has an invalid “exportedAt” timestamp. Expected an ISO date such as 2025-01-31T09:00:00.000Z.",
        "schema",
      );
    }
    return { format: "interchange", entries: assertBookmarkArray(envelope.bookmarks) };
  }

  if (envelope.version === 3 || envelope.version === 2) {
    assertExactKeys(envelope, STORAGE_ENVELOPE_KEYS, "This backup");
    return {
      format: envelope.version === 3 ? "storage-v3" : "storage-v2",
      entries: assertBookmarkArray(envelope.bookmarks),
    };
  }

  throw unrecognized();
}

function assertBookmarkArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new BookmarkImportError(
      "This file has no “bookmarks” list.",
      "schema",
    );
  }
  return value;
}

function unrecognized(): BookmarkImportError {
  return new BookmarkImportError(
    "This file is not a recognized Shortlist export. Expected a Shortlist export " +
      `(schema “${BOOKMARK_TRANSFER_SCHEMA}”, version ${BOOKMARK_TRANSFER_VERSION}) ` +
      "or a version 1, 2, or 3 storage backup.",
    "schema",
  );
}

function parseCandidate(
  value: unknown,
  index: number,
  format: BookmarkImportFormat,
  repairs: ImportRepairSummary,
): Bookmark {
  const label = `Bookmark ${index + 1}`;
  const full = format === "interchange" || format === "storage-v3";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BookmarkImportError(`${label} is not an object.`, "bookmark");
  }

  const item = value as Record<string, unknown>;
  assertExactKeys(item, full ? FULL_BOOKMARK_KEYS : CORE_BOOKMARK_KEYS, label);

  const rawUrl = requireString(item.url, `${label} has a non-text “url”.`);
  const url = normalizeUrl(rawUrl);
  if (!url) {
    throw new BookmarkImportError(
      `${label} has an unsupported URL. Only complete http or https URLs can be imported.`,
      "bookmark",
    );
  }
  if (url !== rawUrl) repairs.urls += 1;

  const rawId = requireString(item.id, `${label} has a non-text “id”.`);
  const id = isSafeId(rawId) ? rawId : "";
  if (!id && format === "interchange") {
    throw new BookmarkImportError(
      `${label} has an invalid “id”. Use 1 to ${MAX_ID_LENGTH} letters, numbers, underscores, or hyphens.`,
      "bookmark",
    );
  }
  if (!id) repairs.ids += 1;

  const rawSlug = requireString(item.slug, `${label} has a non-text “slug”.`);
  const slug = isValidSlug(rawSlug) ? rawSlug : "";
  if (!slug && format === "interchange") {
    throw new BookmarkImportError(
      `${label} has an invalid “slug”. Expected ${SLUG_LENGTH} lowercase Shortlist characters.`,
      "bookmark",
    );
  }
  if (!slug) repairs.slugs += 1;

  const rawCreatedAt = requireString(
    item.createdAt,
    `${label} has a non-text “createdAt”.`,
  );
  const createdAt = isValidTimestamp(rawCreatedAt) ? rawCreatedAt : "";
  if (!createdAt && format === "interchange") {
    throw new BookmarkImportError(
      `${label} has an invalid “createdAt” timestamp. Expected an ISO date such as 2025-01-31T09:00:00.000Z.`,
      "bookmark",
    );
  }
  if (!createdAt) repairs.timestamps += 1;

  if (!full) {
    return withMetadataDefaults({ id, url, slug, createdAt });
  }

  const title = requireString(item.title, `${label} has a non-text “title”.`);
  if (title.trim().length === 0) {
    throw new BookmarkImportError(`${label} has an empty title.`, "bookmark");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new BookmarkImportError(
      `${label} has a title longer than ${MAX_TITLE_LENGTH} characters.`,
      "bookmark",
    );
  }

  if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")) {
    throw new BookmarkImportError(
      `${label} has tags that are not a list of text values.`,
      "bookmark",
    );
  }
  const rawTags = item.tags as string[];
  const tags = normalizeTags(rawTags);
  if (tags.length > MAX_TAGS) {
    throw new BookmarkImportError(
      `${label} has ${tags.length} tags. Use ${MAX_TAGS} tags or fewer.`,
      "bookmark",
    );
  }
  if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
    throw new BookmarkImportError(
      `${label} has a tag longer than ${MAX_TAG_LENGTH} characters.`,
      "bookmark",
    );
  }
  if (tags.length !== rawTags.length || tags.some((tag, at) => tag !== rawTags[at])) {
    repairs.tags += 1;
  }

  const notes = requireString(item.notes, `${label} has non-text “notes”.`);
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new BookmarkImportError(
      `${label} has notes longer than ${MAX_NOTES_LENGTH} characters.`,
      "bookmark",
    );
  }

  return { id, url, slug, createdAt, title, tags, notes };
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new BookmarkImportError(
        `${label} has an unsupported property “${key}”. Remove it and try again.`,
        label.startsWith("Bookmark") ? "bookmark" : "schema",
      );
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new BookmarkImportError(
        `${label} is missing the “${key}” property.`,
        label.startsWith("Bookmark") ? "bookmark" : "schema",
      );
    }
  }
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new BookmarkImportError(message, "bookmark");
  }
  return value;
}

export function isSafeId(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_ID_LENGTH && SAFE_ID_PATTERN.test(value)
  );
}

export function isValidSlug(value: string): boolean {
  return (
    value.length === SLUG_LENGTH &&
    [...value].every((character) => SLUG_CHARACTERS.includes(character))
  );
}

export function isValidTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const [year, month, day, hour, minute, second] = value
    .slice(0, 19)
    .split(/[-T:]/u)
    .map(Number);
  if (
    !year ||
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > new Date(Date.UTC(year, month!, 0)).getUTCDate() ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  ) {
    return false;
  }

  const offset = value.match(/([+-])(\d{2}):(\d{2})$/u);
  return !offset || (Number(offset[2]) <= 23 && Number(offset[3]) <= 59);
}

function toTransferBookmark(bookmark: Bookmark): Bookmark {
  return {
    id: bookmark.id,
    url: bookmark.url,
    slug: bookmark.slug,
    createdAt: bookmark.createdAt,
    title: bookmark.title,
    tags: [...bookmark.tags],
    notes: bookmark.notes,
  };
}
