import { createBookmark, normalizeUrl, type Bookmark } from "../domain/bookmark";
import {
  BookmarkStorageError,
  loadBookmarks,
  saveBookmarks,
  type StorageLike,
} from "../storage/bookmark-storage";

interface BookmarkElements {
  form: HTMLFormElement;
  input: HTMLInputElement;
  message: HTMLElement;
  list: HTMLUListElement;
  count: HTMLElement;
  emptyState: HTMLElement;
  template: HTMLTemplateElement;
  submit: HTMLButtonElement;
}

export function initializeBookmarkController(
  documentRoot: Document = document,
  storage?: StorageLike,
): void {
  const elements = getElements(documentRoot);
  let bookmarks: Bookmark[] = [];
  let activeStorage: StorageLike | null = null;
  let storageReady = false;

  try {
    activeStorage = storage ?? window.localStorage;
    bookmarks = loadBookmarks(activeStorage).bookmarks;
    storageReady = true;
  } catch (error) {
    storageReady = false;
    setMessage(elements, storageErrorMessage(error), true);
    elements.input.disabled = true;
    elements.submit.disabled = true;
  }

  render(elements, bookmarks);

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!storageReady || !activeStorage) return;

    setMessage(elements, "Enter a complete http or https URL.");
    if (!normalizeUrl(elements.input.value)) {
      setMessage(elements, "Please enter a valid http or https URL.", true);
      elements.input.focus();
      return;
    }

    const bookmark = createBookmark(elements.input.value, bookmarks);
    const nextBookmarks = [bookmark, ...bookmarks];
    try {
      saveBookmarks(activeStorage, nextBookmarks);
    } catch (error) {
      setMessage(elements, storageErrorMessage(error), true);
      return;
    }

    bookmarks = nextBookmarks;
    elements.form.reset();
    setMessage(elements, `Saved as /${bookmark.slug}.`);
    render(elements, bookmarks);
    elements.input.focus();
  });

  elements.list.addEventListener("click", (event) => {
    if (!storageReady || !activeStorage) return;

    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      ".remove-button",
    );
    const item = button?.closest<HTMLLIElement>("[data-bookmark-id]");
    if (!button || !item) return;

    const nextBookmarks = bookmarks.filter(
      (bookmark) => bookmark.id !== item.dataset.bookmarkId,
    );
    try {
      saveBookmarks(activeStorage, nextBookmarks);
    } catch (error) {
      setMessage(elements, storageErrorMessage(error), true);
      return;
    }

    bookmarks = nextBookmarks;
    setMessage(elements, "Bookmark removed.");
    render(elements, bookmarks);
  });
}

function getElements(documentRoot: Document): BookmarkElements {
  const form = documentRoot.querySelector<HTMLFormElement>("#bookmark-form");
  const input = documentRoot.querySelector<HTMLInputElement>("#bookmark-url");
  const message = documentRoot.querySelector<HTMLElement>("#form-message");
  const list = documentRoot.querySelector<HTMLUListElement>("#bookmark-list");
  const count = documentRoot.querySelector<HTMLElement>("#bookmark-count");
  const emptyState = documentRoot.querySelector<HTMLElement>("#empty-state");
  const template =
    documentRoot.querySelector<HTMLTemplateElement>("#bookmark-template");
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');

  if (
    !form ||
    !input ||
    !message ||
    !list ||
    !count ||
    !emptyState ||
    !template ||
    !submit
  ) {
    throw new Error("Bookmark interface failed to initialize.");
  }

  return { form, input, message, list, count, emptyState, template, submit };
}

function storageErrorMessage(error: unknown): string {
  if (error instanceof BookmarkStorageError) {
    return `Could not access saved bookmarks: ${error.message}`;
  }

  return "Could not access saved bookmarks: Unknown storage error.";
}

function setMessage(
  elements: BookmarkElements,
  text: string,
  isError = false,
): void {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
}

function render(elements: BookmarkElements, bookmarks: readonly Bookmark[]): void {
  elements.list.replaceChildren();

  for (const bookmark of bookmarks) {
    const fragment = elements.template.content.cloneNode(true) as DocumentFragment;
    const item = fragment.querySelector<HTMLLIElement>(".bookmark");
    const url = fragment.querySelector<HTMLAnchorElement>(".bookmark-url");
    const slug = fragment.querySelector<HTMLElement>(".bookmark-slug");
    const remove = fragment.querySelector<HTMLButtonElement>(".remove-button");

    if (!item || !url || !slug || !remove) {
      throw new Error("Bookmark template has an invalid structure.");
    }

    item.dataset.bookmarkId = bookmark.id;
    url.href = bookmark.url;
    url.textContent = bookmark.url;
    slug.textContent = bookmark.slug;
    remove.setAttribute("aria-label", `Remove ${bookmark.url}`);
    elements.list.append(fragment);
  }

  const total = bookmarks.length;
  elements.count.textContent = `${total} ${total === 1 ? "link" : "links"}`;
  elements.emptyState.hidden = total > 0;
}
