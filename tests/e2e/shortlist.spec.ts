import { expect, test, type Page } from "@playwright/test";

const currentKey = "shortlist.bookmarks.v3";
const legacyKey = "shortlist.bookmarks.v1";

async function openCleanApp(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

async function saveBookmark(page: Page, url: string): Promise<void> {
  await page.getByLabel("Original URL").fill(url);
  await page.getByRole("button", { name: "Save link" }).click();
}

test("saves, edits, organizes, persists, and removes bookmarks", async ({ page }) => {
  await openCleanApp(page);
  await saveBookmark(page, "https://example.com/reference");

  await page.getByRole("button", { name: "Edit example.com" }).click();
  await page.getByLabel("Title").fill("Alpha reference");
  await page.getByRole("textbox", { name: "Tags" }).fill("work, reference");
  await page.getByLabel("Notes").fill("A long-lived project reference");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Edit Alpha reference" })).toBeFocused();

  await saveBookmark(page, "https://github.com/features");
  await page.reload();
  await expect(page.getByText("Alpha reference")).toBeVisible();
  await expect(page.getByText("github.com", { exact: true })).toBeVisible();

  await page.getByLabel("Sort by").selectOption("title");
  await expect(page.locator(".bookmark-title").first()).toHaveText("Alpha reference");
  await page.getByLabel("Search bookmarks").fill("long-lived");
  await expect(page.getByText("Alpha reference")).toBeVisible();
  await expect(page.getByText("github.com", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Reset view" }).click();
  await page.getByLabel("Filter by tag").selectOption("work");
  await expect(page.getByText("Alpha reference")).toBeVisible();
  await expect(page.getByText("github.com", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Remove Alpha reference" }).click();
  await expect(page.getByText("Removed “Alpha reference”")).toBeVisible();
});

test("preserves and upgrades version 1 storage", async ({ page }) => {
  await page.addInitScript(
    ({ key, legacy }) => {
      localStorage.clear();
      localStorage.setItem(key, JSON.stringify(legacy));
    },
    {
      key: legacyKey,
      legacy: [
        {
          id: "legacy-id",
          url: "https://example.org/legacy",
          slug: "old123",
          createdAt: "2024-01-02T03:04:05.000Z",
        },
      ],
    },
  );
  await page.goto("/");

  await expect(page.getByText("example.org", { exact: true })).toBeVisible();
  const storage = await page.evaluate(
    ({ current, legacy }) => ({
      current: localStorage.getItem(current),
      legacy: localStorage.getItem(legacy),
    }),
    { current: currentKey, legacy: legacyKey },
  );
  expect(storage.legacy).not.toBeNull();
  expect(JSON.parse(storage.current ?? "{}")).toMatchObject({
    version: 3,
    bookmarks: [{ id: "legacy-id", slug: "old123", title: "example.org" }],
  });
});

test("previews imports and applies the selected duplicate strategy", async ({ page }) => {
  await openCleanApp(page);
  await saveBookmark(page, "https://example.com/docs");

  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), currentKey);
  const existing = stored.bookmarks[0];
  const imported = {
    schema: "https://shortlist.local/schemas/bookmarks",
    version: 1,
    exportedAt: "2026-08-20T12:00:00.000Z",
    bookmarks: [
      { ...existing, title: "Updated docs", tags: ["imported"], notes: "Replaced" },
      {
        id: "imported-id",
        url: "https://developer.mozilla.org/en-US/",
        slug: "mdn234",
        createdAt: "2026-08-19T12:00:00.000Z",
        title: "MDN",
        tags: ["reference"],
        notes: "Web platform docs",
      },
    ],
  };

  await page.getByLabel("Duplicate URLs").selectOption("replace");
  await page.getByLabel("Import a Shortlist JSON file").setInputFiles({
    name: "shortlist.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.getByRole("region", { name: "Review this import" })).toContainText(
    "1 to add",
  );
  await expect(page.getByRole("region", { name: "Review this import" })).toContainText(
    "1 to replace",
  );
  await page.getByRole("button", { name: "Apply import" }).click();
  await expect(page.getByText("Updated docs")).toBeVisible();
  await expect(page.getByText("MDN", { exact: true })).toBeVisible();
});

test("supports keyboard editing and safe malformed-storage recovery", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.clear();
    localStorage.setItem(key, "{not-json");
  }, currentKey);
  await page.goto("/");

  const recovery = page.getByRole("region", { name: "Saved data could not be read" });
  await expect(recovery).toBeFocused();
  await page.getByRole("button", { name: "Reset local data" }).click();
  await expect(page.getByRole("button", { name: "Yes, erase local data" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Reset local data" })).toBeFocused();
  await page.getByRole("button", { name: "Reset local data" }).click();
  await page.getByRole("button", { name: "Yes, erase local data" }).click();
  await expect(page.getByLabel("Original URL")).toBeFocused();

  await saveBookmark(page, "https://example.net/");
  await page.getByRole("button", { name: "Edit example.net" }).click();
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Edit example.net" })).toBeFocused();
});

test("serves the app shell offline after a successful load", async ({ page, context }) => {
  await openCleanApp(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        });
      });
    }
  });
  await saveBookmark(page, "https://example.com/offline");

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Make the web easy to return to." })).toBeVisible();
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();
  await context.setOffline(false);
});

test("keeps long content and critical controls usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(
    ({ key, bookmark }) => {
      localStorage.clear();
      localStorage.setItem(key, JSON.stringify({ version: 3, bookmarks: [bookmark] }));
    },
    {
      key: currentKey,
      bookmark: {
        id: "responsive-id",
        url: `https://example.com/${"long-path-".repeat(30)}`,
        slug: "phone1",
        createdAt: "2026-08-20T12:00:00.000Z",
        title: "A very long bookmark title that remains readable without escaping its card",
        tags: ["extremely-long-tag-value"],
        notes: "unbroken-note-content-".repeat(40),
      },
    },
  );
  await page.goto("/");

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  for (const control of [
    page.getByRole("button", { name: /Edit A very long/ }),
    page.getByRole("button", { name: /Remove A very long/ }),
    page.getByRole("button", { name: "Export JSON" }),
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
});
