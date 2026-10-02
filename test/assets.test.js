import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetUrls, hashAssets } from "../src/lib/assets.js";

function publicDir(files) {
  const root = mkdtempSync(join(tmpdir(), "assets-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

test("asset URLs carry a hash that changes only when the file does", (t) => {
  const root = publicDir({ "css/app.css": "a {}", "js/lib/dates.js": "export {}", "offline.html": "<p>" });
  t.after(() => rmSync(root, { recursive: true }));
  const before = assetUrls(hashAssets(root)).asset;
  assert.match(before("/css/app.css"), /^\/css\/app\.css\?v=[0-9a-f]{10}$/);
  assert.equal(before("/offline.html"), "/offline.html", "only css, js and img are versioned");
  assert.equal(before("/js/missing.js"), "/js/missing.js");

  writeFileSync(join(root, "css/app.css"), "a { color: red }");
  const after = assetUrls(hashAssets(root)).asset;
  assert.notEqual(after("/css/app.css"), before("/css/app.css"));
  assert.equal(after("/js/lib/dates.js"), before("/js/lib/dates.js"));
});

test("the import map gives nested modules the same versioned URLs", (t) => {
  const root = publicDir({ "js/elapsed-time.js": "import './lib/dates.js'", "js/lib/dates.js": "export {}", "css/app.css": "" });
  t.after(() => rmSync(root, { recursive: true }));
  const { asset, importMap } = assetUrls(hashAssets(root));
  assert.deepEqual(JSON.parse(importMap), {
    imports: { "/js/elapsed-time.js": asset("/js/elapsed-time.js"), "/js/lib/dates.js": asset("/js/lib/dates.js") },
  });
});
