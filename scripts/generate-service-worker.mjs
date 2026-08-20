import { generateSW } from "workbox-build";

const result = await generateSW({
  globDirectory: "dist",
  globPatterns: ["**/*.{html,css,js,svg,png,ico,webmanifest}"],
  swDest: "dist/sw.js",
  navigateFallback: "/index.html",
  navigateFallbackDenylist: [/^\/icons\//, /^\/manifest\.webmanifest$/],
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: true,
  sourcemap: false,
});

if (result.warnings.length > 0) {
  throw new Error(`Service worker generation warnings:\n${result.warnings.join("\n")}`);
}

console.log(
  `Generated offline service worker with ${result.count} precached files (${result.size} bytes).`,
);
