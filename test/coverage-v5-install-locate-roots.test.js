// Install coverage, fifth batch: the search roots src/install/locate.js builds, the `~`
// expansion when there is no home, and a nearer package shadowing the same name further out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import { findPackagesWith, locatePackageDir } from "../src/install/locate.js";

// A package directory holding the files locate.js checks for.
function packageAt(dir, name, marker) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  if (marker) writeFileSync(join(dir, marker), "");
  return dir;
}

test("a package beside this package's own install is found through the store root", () => {
  // src/install/locate.js:44 — the own root, for a cwd whose walk never reaches it.
  const root = tempDir("vbcdx-locate-own-");
  const store = join(root, "store");
  const pack = packageAt(join(store, "node_modules", "@example", "locate-own-pack"), "@example/locate-own-pack");
  mkdirSync(join(store, "node_modules", "@vbcdx", "vbcdx"), { recursive: true });
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  const found = locatePackageDir("@example/locate-own-pack", {
    cwd: elsewhere,
    home: undefined,
    packageRoot: join(store, "node_modules", "@vbcdx", "vbcdx"),
    npmGlobalRoot: () => null,
    what: "agent pack",
  });
  assert.equal(found, realpathSync(pack));
});

test("a ~ path resolves against an empty home, and a missing one names the spec unchanged", () => {
  // src/install/locate.js:68 — the false arm of `home || ""`.
  const root = tempDir("vbcdx-locate-home-");
  const pack = packageAt(join(root, "pack"), "@example/locate-home-pack");
  assert.equal(locatePackageDir("~pack", { cwd: root, home: undefined }), realpathSync(pack));
  assert.throws(
    () => locatePackageDir("~/absent", { cwd: root, home: undefined }),
    { name: "InstallerError", code: 2, message: "No package directory at ~/absent." },
  );
});

test("a nearer package of the same name shadows the copy in the store", () => {
  // src/install/locate.js:119 — the found.has(name) arm.
  const root = tempDir("vbcdx-locate-shadow-");
  const nearer = packageAt(join(root, "a", "node_modules", "@example", "locate-shadow-pack"), "@example/locate-shadow-pack", "vbcdx-pack.json");
  const farther = packageAt(join(root, "b", "node_modules", "@example", "locate-shadow-pack"), "@example/locate-shadow-pack", "vbcdx-pack.json");
  const found = findPackagesWith("vbcdx-pack.json", {
    cwd: join(root, "a"),
    packageRoot: join(root, "b", "node_modules", "@vbcdx", "vbcdx"),
    npmGlobalRoot: () => null,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "@example/locate-shadow-pack");
  assert.equal(found[0].dir, realpathSync(nearer));
  assert.notEqual(found[0].dir, realpathSync(farther));
});
