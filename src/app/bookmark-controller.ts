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
  BookmarkImportError,
  assertImportFile,
  bookmarkExportFileName,
  decodeBookmarkImport,
  formatByteSize,
  serializeBookmarkExport,
} from "../domain/bookmark-transfer";
import {
  describeImportAdjustments,
  planBookmarkImport,
  summarizeImportPlan,
  type BookmarkImportPlan,
  type ImportDuplicateStrategy,
} from "../domain/bookmark-import-plan";
import {
  BookmarkStorageError,
  clearBookmarks,
  describeRawPayload,
  loadBookmarks,
  readRawBookmarkPayloads,
  saveBookmarks,
  type RawBookmarkPayload,
  type StorageLike,
} from "../storage/bookmark-storage";

interface TransferElements {
  exportButton: HTMLButtonElement;
  importFile: HTMLInputElement;
  importStrategy: HTMLSelectElement;
  importPreview: HTMLElement;
  importSummary: HTMLElement;
  importDetails: HTMLUListElement;
  confirmImport: HTMLButtonElement;
  cancelImport: HTMLButtonElement;
  transferMessage: HTMLElement;
  recoveryPanel: HTMLElement;
  recoveryDetails: HTMLElement;
  downloadRaw: HTMLButtonElement;
  downloadAllRaw: HTMLButtonElement;
  resetStorage: HTMLButtonElement;
  resetConfirm: HTMLElement;
  confirmReset: HTMLButtonElement;
  cancelReset: HTMLButtonElement;
}

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
  transfer: TransferElements;
}

/** Grace period before an object URL is released, so the download can start. */
const DOWNLOAD_RELEASE_DELAY_MS = 60_000;

interface PendingImport {
  fileName: string;
  candidates: Bookmark[];
  plan: BookmarkImportPlan;
  replacesUnreadable: boolean;
  preserveExistingMetadata: boolean;
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
  let pendingImport: PendingImport | null = null;
  let rawPayload: RawBookmarkPayload | null = null;
  let rawPayloads: RawBookmarkPayload[] = [];
  let importRequest = 0;

  try {
    activeStorage = storage ?? window.localStorage;
    bookmarks = loadBookmarks(activeStorage).bookmarks;
    storageReady = true;
  } catch (error) {
    storageReady = false;
    setMessage(elements, storageErrorMessage(error), true);
    elements.input.disabled = true;
    elements.submit.disabled = true;
    rawPayloads = readRawPayloadsSafely(activeStorage);
    rawPayload = rawPayloads[0] ?? null;
    showRecovery(elements, error, rawPayload);
    elements.transfer.downloadAllRaw.hidden = rawPayloads.length < 2;
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
    refreshPendingImport();
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
    refreshPendingImport();
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
    refreshPendingImport();
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

  elements.transfer.exportButton.addEventListener("click", () => {
    if (!storageReady) {
      setTransferMessage(
        elements,
        "Saved bookmarks could not be read, so there is nothing valid to export.",
        true,
      );
      return;
    }

    const exportedAt = new Date();
    downloadFile(
      elements,
      bookmarkExportFileName(exportedAt),
      serializeBookmarkExport(bookmarks, exportedAt),
    );
    setTransferMessage(
      elements,
      `Exported ${bookmarks.length} ${bookmarks.length === 1 ? "bookmark" : "bookmarks"}.`,
    );
  });

  elements.transfer.importFile.addEventListener("change", () => {
    void previewSelectedFile();
  });

  elements.transfer.importStrategy.addEventListener("change", () => {
    refreshPendingImport();
  });

  elements.transfer.cancelImport.addEventListener("click", () => {
    clearPendingImport();
    setTransferMessage(elements, "Import cancelled. Nothing was changed.");
    elements.transfer.importFile.focus();
  });

  elements.transfer.confirmImport.addEventListener("click", () => {
    const pending = pendingImport;
    if (!pending || !activeStorage) return;

    // Re-plan against the collection as it stands right now: the preview may
    // have been built before a bookmark was added, edited, or removed.
    let plan: BookmarkImportPlan;
    try {
      plan = buildPlan(
        pending.candidates,
        pending.replacesUnreadable,
        pending.preserveExistingMetadata,
      );
    } catch (error) {
      clearPendingImport();
      setTransferMessage(elements, transferErrorMessage(error), true);
      return;
    }

    try {
      saveBookmarks(activeStorage, plan.bookmarks);
    } catch (error) {
      setTransferMessage(elements, storageErrorMessage(error), true);
      return;
    }

    bookmarks = plan.bookmarks;
    storageReady = true;
    rawPayload = null;
    rawPayloads = [];
    elements.input.disabled = false;
    elements.submit.disabled = false;
    hideRecovery(elements);
    clearPendingImport();
    setMessage(elements, "Enter a complete http or https URL.");
    setTransferMessage(
      elements,
      `Imported ${plan.added} added, ${plan.replaced} replaced, ${plan.skipped} skipped.`,
    );
    render(elements, bookmarks);
  });

  elements.transfer.downloadRaw.addEventListener("click", () => {
    if (!rawPayload) return;
    downloadFile(
      elements,
      `shortlist-raw-backup-${new Date().toISOString().slice(0, 10)}.json`,
      rawPayload.value,
    );
    setTransferMessage(
      elements,
      `Downloaded the raw contents of ${rawPayload.key}. Nothing was changed.`,
    );
  });

  elements.transfer.downloadAllRaw.addEventListener("click", () => {
    if (rawPayloads.length < 2) return;
    downloadFile(
      elements,
      `shortlist-all-storage-${new Date().toISOString().slice(0, 10)}.json`,
      `${JSON.stringify({ version: 1, payloads: rawPayloads }, null, 2)}\n`,
    );
    setTransferMessage(
      elements,
      `Downloaded all ${rawPayloads.length} stored Shortlist versions. Nothing was changed.`,
    );
  });

  elements.transfer.resetStorage.addEventListener("click", () => {
    elements.transfer.resetConfirm.hidden = false;
    elements.transfer.confirmReset.focus();
  });

  elements.transfer.cancelReset.addEventListener("click", () => {
    elements.transfer.resetConfirm.hidden = true;
    setTransferMessage(elements, "Reset cancelled. Nothing was erased.");
    elements.transfer.resetStorage.focus();
  });

  elements.transfer.confirmReset.addEventListener("click", () => {
    if (!activeStorage) return;
    try {
      clearBookmarks(activeStorage);
    } catch (error) {
      setTransferMessage(elements, storageErrorMessage(error), true);
      return;
    }

    bookmarks = [];
    storageReady = true;
    rawPayload = null;
    rawPayloads = [];
    elements.input.disabled = false;
    elements.submit.disabled = false;
    hideRecovery(elements);
    clearPendingImport();
    setMessage(elements, "Enter a complete http or https URL.");
    setTransferMessage(elements, "Local Shortlist data was erased. Starting fresh.");
    render(elements, bookmarks);
  });

  async function previewSelectedFile(): Promise<void> {
    clearPendingImport(false);
    const request = importRequest;
    const file = elements.transfer.importFile.files?.[0];
    if (!file) return;

    if (!activeStorage) {
      setTransferMessage(
        elements,
        "Browser storage is unavailable, so an import cannot be saved.",
        true,
      );
      resetFileInput();
      return;
    }

    try {
      assertImportFile(file);
      const decoded = decodeBookmarkImport(await file.text());
      // A newer selection took over while this file was being read.
      if (request !== importRequest) return;

      const replacesUnreadable = !storageReady;
      const preserveExistingMetadata =
        decoded.format === "storage-v1" || decoded.format === "storage-v2";
      pendingImport = {
        fileName: file.name,
        candidates: decoded.bookmarks,
        plan: buildPlan(
          decoded.bookmarks,
          replacesUnreadable,
          preserveExistingMetadata,
        ),
        replacesUnreadable,
        preserveExistingMetadata,
      };
      showImportPreview(elements, pendingImport);
      setTransferMessage(
        elements,
        `Read ${file.name} (${formatByteSize(file.size)}). Nothing has changed yet.`,
      );
      elements.transfer.confirmImport.focus();
    } catch (error) {
      if (request !== importRequest) return;
      clearPendingImport();
      setTransferMessage(elements, transferErrorMessage(error), true);
      resetFileInput();
    }
  }

  /** Keeps an open preview honest after the collection changes underneath it. */
  function refreshPendingImport(): void {
    const pending = pendingImport;
    if (!pending) return;

    try {
      pendingImport = {
        ...pending,
        plan: buildPlan(
          pending.candidates,
          pending.replacesUnreadable,
          pending.preserveExistingMetadata,
        ),
      };
      showImportPreview(elements, pendingImport);
    } catch (error) {
      clearPendingImport();
      setTransferMessage(elements, transferErrorMessage(error), true);
    }
  }

  function buildPlan(
    candidates: readonly Bookmark[],
    replacesUnreadable: boolean,
    preserveExistingMetadata: boolean,
  ): BookmarkImportPlan {
    return planBookmarkImport(
      replacesUnreadable ? [] : bookmarks,
      candidates,
      importStrategy(elements),
      {},
      { preserveExistingMetadataOnReplace: preserveExistingMetadata },
    );
  }

  function clearPendingImport(resetInput = true): void {
    // Also abandons any in-flight file read so a late result cannot revive the
    // preview after the import was cancelled or the storage was reset.
    importRequest += 1;
    pendingImport = null;
    elements.transfer.importPreview.hidden = true;
    elements.transfer.importDetails.replaceChildren();
    elements.transfer.importSummary.textContent = "";
    if (resetInput) resetFileInput();
  }

  function resetFileInput(): void {
    elements.transfer.importFile.value = "";
  }

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
    elements.transfer.exportButton.disabled = !storageReady;
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
    transfer: getTransferElements(documentRoot),
  };
}

function getTransferElements(documentRoot: Document): TransferElements {
  const exportButton =
    documentRoot.querySelector<HTMLButtonElement>("#export-bookmarks");
  const importFile = documentRoot.querySelector<HTMLInputElement>("#import-file");
  const importStrategy =
    documentRoot.querySelector<HTMLSelectElement>("#import-strategy");
  const importPreview = documentRoot.querySelector<HTMLElement>("#import-preview");
  const importSummary = documentRoot.querySelector<HTMLElement>("#import-summary");
  const importDetails =
    documentRoot.querySelector<HTMLUListElement>("#import-details");
  const confirmImport =
    documentRoot.querySelector<HTMLButtonElement>("#confirm-import");
  const cancelImport =
    documentRoot.querySelector<HTMLButtonElement>("#cancel-import");
  const transferMessage =
    documentRoot.querySelector<HTMLElement>("#transfer-message");
  const recoveryPanel = documentRoot.querySelector<HTMLElement>("#recovery-panel");
  const recoveryDetails =
    documentRoot.querySelector<HTMLElement>("#recovery-details");
  const downloadRaw = documentRoot.querySelector<HTMLButtonElement>("#download-raw");
  const downloadAllRaw =
    documentRoot.querySelector<HTMLButtonElement>("#download-all-raw");
  const resetStorage =
    documentRoot.querySelector<HTMLButtonElement>("#reset-storage");
  const resetConfirm = documentRoot.querySelector<HTMLElement>("#reset-confirm");
  const confirmReset =
    documentRoot.querySelector<HTMLButtonElement>("#confirm-reset");
  const cancelReset = documentRoot.querySelector<HTMLButtonElement>("#cancel-reset");

  if (
    !exportButton ||
    !importFile ||
    !importStrategy ||
    !importPreview ||
    !importSummary ||
    !importDetails ||
    !confirmImport ||
    !cancelImport ||
    !transferMessage ||
    !recoveryPanel ||
    !recoveryDetails ||
    !downloadRaw ||
    !downloadAllRaw ||
    !resetStorage ||
    !resetConfirm ||
    !confirmReset ||
    !cancelReset
  ) {
    throw new Error("Bookmark transfer interface failed to initialize.");
  }

  return {
    exportButton,
    importFile,
    importStrategy,
    importPreview,
    importSummary,
    importDetails,
    confirmImport,
    cancelImport,
    transferMessage,
    recoveryPanel,
    recoveryDetails,
    downloadRaw,
    downloadAllRaw,
    resetStorage,
    resetConfirm,
    confirmReset,
    cancelReset,
  };
}

function importStrategy(elements: BookmarkElements): ImportDuplicateStrategy {
  return elements.transfer.importStrategy.value === "replace" ? "replace" : "skip";
}

function setTransferMessage(
  elements: BookmarkElements,
  text: string,
  isError = false,
): void {
  elements.transfer.transferMessage.textContent = text;
  elements.transfer.transferMessage.classList.toggle("error", isError);
}

function showImportPreview(
  elements: BookmarkElements,
  pending: PendingImport,
): void {
  const documentRoot = elements.transfer.importDetails.ownerDocument;
  const details = describeImportAdjustments(pending.plan);
  if (pending.replacesUnreadable) {
    details.unshift(
      "Saved data cannot be read, so applying this import replaces it entirely.",
    );
  }

  elements.transfer.importSummary.textContent = `${pending.fileName}: ${summarizeImportPlan(pending.plan)}`;
  elements.transfer.importDetails.replaceChildren();
  for (const detail of details) {
    const item = documentRoot.createElement("li");
    item.textContent = detail;
    elements.transfer.importDetails.append(item);
  }
  elements.transfer.importDetails.hidden = details.length === 0;
  elements.transfer.importPreview.hidden = false;
}

function showRecovery(
  elements: BookmarkElements,
  error: unknown,
  payload: RawBookmarkPayload | null,
): void {
  const reason =
    error instanceof BookmarkStorageError ? error.message : "Unknown storage error.";
  if (!payload) {
    elements.transfer.recoveryDetails.textContent = `${reason} No stored payload could be read back for inspection.`;
    elements.transfer.downloadRaw.disabled = true;
  } else {
    const diagnostics = describeRawPayload(payload);
    elements.transfer.recoveryDetails.textContent =
      `${reason} Key ${diagnostics.key} holds ${formatByteSize(diagnostics.bytes)} of ` +
      `${diagnostics.parsable ? `JSON (${diagnostics.shape})` : "text that is not valid JSON"}. ` +
      `Starts with: ${diagnostics.preview}`;
    elements.transfer.downloadRaw.disabled = false;
  }

  elements.transfer.resetConfirm.hidden = true;
  elements.transfer.recoveryPanel.hidden = false;
}

function hideRecovery(elements: BookmarkElements): void {
  elements.transfer.recoveryPanel.hidden = true;
  elements.transfer.resetConfirm.hidden = true;
}

function readRawPayloadsSafely(storage: StorageLike | null): RawBookmarkPayload[] {
  if (!storage) return [];
  try {
    return readRawBookmarkPayloads(storage);
  } catch {
    return [];
  }
}

function downloadFile(
  elements: BookmarkElements,
  fileName: string,
  contents: string,
): void {
  const documentRoot = elements.transfer.exportButton.ownerDocument;
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json" }),
  );
  const link = documentRoot.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noreferrer";
  documentRoot.body.append(link);
  link.click();
  link.remove();
  // Revoking in the same task aborts the download in some browsers, which would
  // silently lose a recovery backup the user still needs.
  globalThis.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_RELEASE_DELAY_MS);
}

function transferErrorMessage(error: unknown): string {
  if (error instanceof BookmarkImportError) return error.message;
  if (error instanceof BookmarkStorageError) return storageErrorMessage(error);
  if (error instanceof Error) return `That file could not be read: ${error.message}`;

  return "That file could not be read.";
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
