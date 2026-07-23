import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ref = String(process.argv[2] || "").trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(ref)) {
  throw new Error("Expected a full 40-character aimesy/themes commit SHA.");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pages = ["index.html"];
const assets = new Set([
  "theme.css",
  "theme-bar.css",
  "bug-report.css",
  "theme.js",
  "bug-report.js",
]);
const pattern = /https:\/\/cdn\.jsdelivr\.net\/gh\/aimesy\/themes@[^/"']+\/src\/(theme\.css|theme-bar\.css|bug-report\.css|theme\.js|bug-report\.js)/g;

for (const page of pages) {
  const filePath = path.join(repoRoot, page);
  const source = readFileSync(filePath, "utf8");
  const counts = new Map();
  const updated = source.replace(pattern, (_, asset) => {
    counts.set(asset, (counts.get(asset) || 0) + 1);
    return `https://cdn.jsdelivr.net/gh/aimesy/themes@${ref}/src/${asset}`;
  });

  if (counts.size !== assets.size || [...assets].some((asset) => counts.get(asset) !== 1)) {
    throw new Error(`${page} must reference each shared theme asset exactly once.`);
  }
  if (/aimesy\/themes(?:\/|@(master|main|latest)\/)/i.test(updated)) {
    throw new Error(`${page} still contains a mutable shared-theme reference.`);
  }
  if (updated !== source) writeFileSync(filePath, updated);
}

console.log(`Pinned shared theme assets to ${ref}.`);
