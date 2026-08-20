import {
  collectTags,
  createBookmark,
  normalizeUrl,
  selectBookmarks,
  updateBookmarkMetadata,
  type Bookmark,
  type BookmarkSort,
} from "../domain/bookmark";
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
  emptyStateMessage: HTMLElement;
  template: HTMLTemplateElement;
  submit: HTMLButtonElement;
  search: HTMLInputElement;
  tagFilter: HTMLSelectElement;
  sort: HTMLSelectElement;
  reset: HTMLButtonElement;
  resultsSummary: HTMLElement;
}

interface BookmarkDraft {
  id: string;
  title: string;
  tags: string;
  notes: string;
}

export function initializeBookmarkController(
  documentRoot: Document = document,
  storage?: StorageLike,
): void {
  const elements = getElements(documentRoot);
  let bookmarks: Bookmark[] = [];
  let activeStorage: StorageLike | null = null;
  let storageReady = false;
  let activeQuery = "";
  let activeTag = "";
  let activeSort: BookmarkSort = "newest";
  let activeDraft: BookmarkDraft | null = null;

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
      "button[data-action]",
    );
    const item = button?.closest<HTMLLIElement>("[data-bookmark-id]");
    if (!button || !item) return;

    if (button.dataset.action === "edit") {
      const bookmark = bookmarks.find(({ id }) => id === item.dataset.bookmarkId);
      if (!bookmark) return;
      activeDraft = {
        id: bookmark.id,
        title: bookmark.title,
        tags: bookmark.tags.join(", "),
        notes: bookmark.notes,
      };
      showEditor(item, activeDraft, true);
      return;
    }
    if (button.dataset.action === "cancel") {
      activeDraft = null;
      closeEditor(item);
      return;
    }
    if (button.dataset.action !== "remove") return;

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
    if (activeDraft?.id === item.dataset.bookmarkId) activeDraft = null;
    setMessage(elements, "Bookmark removed.");
    render(elements, bookmarks);
  });

  elements.list.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!storageReady || !activeStorage) return;

    const form = (event.target as HTMLElement).closest<HTMLFormElement>(
      ".bookmark-edit-form",
    );
    const item = form?.closest<HTMLLIElement>("[data-bookmark-id]");
    if (!form || !item) return;

    const bookmark = bookmarks.find(({ id }) => id === item.dataset.bookmarkId);
    const title = form.elements.namedItem("title");
    const tags = form.elements.namedItem("tags");
    const notes = form.elements.namedItem("notes");
    const error = form.querySelector<HTMLElement>(".edit-error");
    if (
      !bookmark ||
      !(title instanceof HTMLInputElement) ||
      !(tags instanceof HTMLInputElement) ||
      !(notes instanceof HTMLTextAreaElement) ||
      !error
    ) {
      throw new Error("Bookmark editor has an invalid structure.");
    }

    let updated: Bookmark;
    try {
      updated = updateBookmarkMetadata(bookmark, {
        title: title.value,
        tags: tags.value,
        notes: notes.value,
      });
    } catch (validationError) {
      error.textContent =
        validationError instanceof Error
          ? validationError.message
          : "Bookmark details are invalid.";
      error.hidden = false;
      title.focus();
      return;
    }

    const nextBookmarks = bookmarks.map((itemBookmark) =>
      itemBookmark.id === bookmark.id ? updated : itemBookmark,
    );
    try {
      saveBookmarks(activeStorage, nextBookmarks);
    } catch (storageError) {
      error.textContent = storageErrorMessage(storageError);
      error.hidden = false;
      return;
    }

    bookmarks = nextBookmarks;
    activeDraft = null;
    setMessage(elements, `Updated “${updated.title}”.`);
    render(elements, bookmarks);
  });

  elements.list.addEventListener("input", (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>(
      ".bookmark-edit-form",
    );
    const item = form?.closest<HTMLLIElement>("[data-bookmark-id]");
    const draft = activeDraft;
    if (!form || !item || !draft || draft.id !== item.dataset.bookmarkId) return;

    const title = form.elements.namedItem("title");
    const tags = form.elements.namedItem("tags");
    const notes = form.elements.namedItem("notes");
    if (
      title instanceof HTMLInputElement &&
      tags instanceof HTMLInputElement &&
      notes instanceof HTMLTextAreaElement
    ) {
      activeDraft = {
        id: draft.id,
        title: title.value,
        tags: tags.value,
        notes: notes.value,
      };
    }
  });

  elements.list.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const form = (event.target as HTMLElement).closest<HTMLFormElement>(
      ".bookmark-edit-form",
    );
    const item = form?.closest<HTMLLIElement>("[data-bookmark-id]");
    if (!item) return;

    event.preventDefault();
    activeDraft = null;
    closeEditor(item);
  });

  elements.search.addEventListener("input", () => {
    activeQuery = elements.search.value;
    render(elements, bookmarks);
  });
  elements.tagFilter.addEventListener("change", () => {
    activeTag = elements.tagFilter.value;
    render(elements, bookmarks);
  });
  elements.sort.addEventListener("change", () => {
    activeSort = isBookmarkSort(elements.sort.value)
      ? elements.sort.value
      : "newest";
    render(elements, bookmarks);
  });
  elements.reset.addEventListener("click", () => {
    activeQuery = "";
    activeTag = "";
    activeSort = "newest";
    elements.search.value = "";
    render(elements, bookmarks);
    elements.search.focus();
  });

  function render(elements: BookmarkElements, allBookmarks: readonly Bookmark[]): void {
    const tags = collectTags(allBookmarks);
    if (activeTag && !tags.includes(activeTag)) activeTag = "";
    renderTagOptions(elements, tags, activeTag);
    elements.sort.value = activeSort;

    const visibleBookmarks = selectBookmarks(allBookmarks, {
      query: activeQuery,
      tag: activeTag,
      sort: activeSort,
    });
    renderBookmarkList(elements, visibleBookmarks);
    if (activeDraft) {
      const draftItem = [...elements.list.children].find(
        (item): item is HTMLLIElement =>
          item instanceof HTMLLIElement &&
          item.dataset.bookmarkId === activeDraft?.id,
      );
      if (draftItem) showEditor(draftItem, activeDraft, false);
    }

    const visible = visibleBookmarks.length;
    const total = allBookmarks.length;
    elements.count.textContent =
      visible === total
        ? `${total} ${total === 1 ? "link" : "links"}`
        : `${visible} of ${total} links`;
    elements.emptyState.hidden = visible > 0;
    elements.emptyStateMessage.textContent =
      total === 0
        ? "Your saved links will appear here."
        : "No bookmarks match this view. Try resetting the controls.";

    const isDefaultView = !activeQuery.trim() && !activeTag && activeSort === "newest";
    elements.reset.disabled = isDefaultView;
    elements.resultsSummary.textContent = selectionSummary(
      visible,
      total,
      activeQuery,
      activeTag,
      activeSort,
    );
  }
}

function getElements(documentRoot: Document): BookmarkElements {
  const form = documentRoot.querySelector<HTMLFormElement>("#bookmark-form");
  const input = documentRoot.querySelector<HTMLInputElement>("#bookmark-url");
  const message = documentRoot.querySelector<HTMLElement>("#form-message");
  const list = documentRoot.querySelector<HTMLUListElement>("#bookmark-list");
  const count = documentRoot.querySelector<HTMLElement>("#bookmark-count");
  const emptyState = documentRoot.querySelector<HTMLElement>("#empty-state");
  const emptyStateMessage =
    documentRoot.querySelector<HTMLElement>("#empty-state-message");
  const template =
    documentRoot.querySelector<HTMLTemplateElement>("#bookmark-template");
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const search =
    documentRoot.querySelector<HTMLInputElement>("#bookmark-search");
  const tagFilter =
    documentRoot.querySelector<HTMLSelectElement>("#bookmark-tag-filter");
  const sort = documentRoot.querySelector<HTMLSelectElement>("#bookmark-sort");
  const reset =
    documentRoot.querySelector<HTMLButtonElement>("#reset-organization");
  const resultsSummary =
    documentRoot.querySelector<HTMLElement>("#results-summary");

  if (
    !form ||
    !input ||
    !message ||
    !list ||
    !count ||
    !emptyState ||
    !emptyStateMessage ||
    !template ||
    !submit ||
    !search ||
    !tagFilter ||
    !sort ||
    !reset ||
    !resultsSummary
  ) {
    throw new Error("Bookmark interface failed to initialize.");
  }

  return {
    form,
    input,
    message,
    list,
    count,
    emptyState,
    emptyStateMessage,
    template,
    submit,
    search,
    tagFilter,
    sort,
    reset,
    resultsSummary,
  };
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

function renderBookmarkList(
  elements: BookmarkElements,
  bookmarks: readonly Bookmark[],
): void {
  elements.list.replaceChildren();

  for (const bookmark of bookmarks) {
    const fragment = elements.template.content.cloneNode(true) as DocumentFragment;
    const item = fragment.querySelector<HTMLLIElement>(".bookmark");
    const title = fragment.querySelector<HTMLElement>(".bookmark-title");
    const url = fragment.querySelector<HTMLAnchorElement>(".bookmark-url");
    const slug = fragment.querySelector<HTMLElement>(".bookmark-slug");
    const tags = fragment.querySelector<HTMLUListElement>(".bookmark-tags");
    const notes = fragment.querySelector<HTMLElement>(".bookmark-notes");
    const edit = fragment.querySelector<HTMLButtonElement>(".edit-button");
    const remove = fragment.querySelector<HTMLButtonElement>(".remove-button");

    if (!item || !title || !url || !slug || !tags || !notes || !edit || !remove) {
      throw new Error("Bookmark template has an invalid structure.");
    }

    item.dataset.bookmarkId = bookmark.id;
    title.textContent = bookmark.title;
    url.href = bookmark.url;
    url.textContent = bookmark.url;
    slug.textContent = bookmark.slug;
    for (const tag of bookmark.tags) {
      const tagItem = elements.list.ownerDocument.createElement("li");
      tagItem.textContent = tag;
      tags.append(tagItem);
    }
    tags.hidden = bookmark.tags.length === 0;
    notes.textContent = bookmark.notes;
    notes.hidden = !bookmark.notes;
    edit.setAttribute("aria-label", `Edit ${bookmark.title}`);
    remove.setAttribute("aria-label", `Remove ${bookmark.title}`);
    elements.list.append(fragment);
  }
}

function renderTagOptions(
  elements: BookmarkElements,
  tags: readonly string[],
  selectedTag: string,
): void {
  const documentRoot = elements.tagFilter.ownerDocument;
  elements.tagFilter.replaceChildren(createOption(documentRoot, "All tags", ""));
  for (const tag of tags) {
    elements.tagFilter.add(createOption(documentRoot, tag, tag));
  }

  function createOption(
    documentRoot: Document,
    label: string,
    value: string,
  ): HTMLOptionElement {
    const option = documentRoot.createElement("option");
    option.textContent = label;
    option.value = value;
    return option;
  }
  elements.tagFilter.value = selectedTag;
}

function showEditor(
  item: HTMLLIElement,
  draft: BookmarkDraft,
  shouldFocus: boolean,
): void {
  const view = item.querySelector<HTMLElement>(".bookmark-view");
  const form = item.querySelector<HTMLFormElement>(".bookmark-edit-form");
  const title = form?.elements.namedItem("title");
  const tags = form?.elements.namedItem("tags");
  const notes = form?.elements.namedItem("notes");
  const error = form?.querySelector<HTMLElement>(".edit-error");
  if (
    !view ||
    !form ||
    !(title instanceof HTMLInputElement) ||
    !(tags instanceof HTMLInputElement) ||
    !(notes instanceof HTMLTextAreaElement) ||
    !error
  ) {
    throw new Error("Bookmark editor has an invalid structure.");
  }

  title.value = draft.title;
  tags.value = draft.tags;
  notes.value = draft.notes;
  error.hidden = true;
  view.hidden = true;
  form.hidden = false;
  if (shouldFocus) {
    title.focus();
    title.select();
  }
}

function closeEditor(item: HTMLLIElement): void {
  const view = item.querySelector<HTMLElement>(".bookmark-view");
  const form = item.querySelector<HTMLFormElement>(".bookmark-edit-form");
  const edit = item.querySelector<HTMLButtonElement>(".edit-button");
  if (!view || !form || !edit) {
    throw new Error("Bookmark editor has an invalid structure.");
  }

  form.hidden = true;
  view.hidden = false;
  edit.focus();
}

function isBookmarkSort(value: string): value is BookmarkSort {
  return value === "newest" || value === "oldest" || value === "title";
}

function selectionSummary(
  visible: number,
  total: number,
  query: string,
  tag: string,
  sort: BookmarkSort,
): string {
  const details = [];
  if (query.trim()) details.push(`search “${query.trim()}”`);
  if (tag) details.push(`tag “${tag}”`);
  details.push(
    sort === "newest"
      ? "newest first"
      : sort === "oldest"
        ? "oldest first"
        : "title A-Z",
  );

  return `Showing ${visible} of ${total} saved ${total === 1 ? "bookmark" : "bookmarks"}; ${details.join(", ")}.`;
}
