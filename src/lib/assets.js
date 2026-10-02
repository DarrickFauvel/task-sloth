// Versioned URLs for the files in public/, so a deploy reaches phones straight away. The service worker
// (public/sw.js) serves styles, scripts and images from its cache, so an unchanged URL would keep showing
// the old file next to the new pages. Each URL carries a hash of the file (/css/app.css?v=1a2b3c4d5e), which
// changes only when the file does.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const VERSIONED = /^\/(css|js|img)\//;

/** Hashes every file under `root`: { "/css/app.css": "1a2b3c4d5e", ... }. */
export function hashAssets(root) {
  const hashes = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = "/" + relative(root, file).split(sep).join("/");
    if (VERSIONED.test(path)) hashes[path] = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10);
  }
  return hashes;
}

/** asset(path) gives the versioned URL; importMap is the JSON for the layout's import map, so a module's own
 * imports (./lib/dates.js) get the same versions. Unknown paths come back as they are. */
export function assetUrls(hashes) {
  const asset = (path) => (hashes[path] ? `${path}?v=${hashes[path]}` : path);
  const imports = Object.fromEntries(Object.keys(hashes).filter((p) => p.endsWith(".js")).map((p) => [p, asset(p)]));
  return { asset, importMap: JSON.stringify({ imports }) };
}
