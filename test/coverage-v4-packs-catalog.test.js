// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { join } from "node:path";
import "./helpers/fixture-pack.js";
import { FIXTURE_PACK_DIR, FIXTURE_IDS } from "./helpers/fixture-pack.js";
import { tempDir } from "./helpers/temp-dir.js";
import { loadCatalog } from "../src/packs/catalog.js";

const emptyLock = () => ({ sources: [] });
const namesAgentPack = (err) => err instanceof Error && /agent pack/.test(err.message);

function roleIds(catalogue) {
  const roles = catalogue?.roles;
  if (roles instanceof Map) return [...roles.keys()];
  if (Array.isArray(roles)) return roles.map((role) => (typeof role === "string" ? role : role && role.id));
  return Object.keys(roles ?? {});
}

function packCount(catalogue) {
  const packs = catalogue?.packs;
  if (packs instanceof Map) return packs.size;
  if (Array.isArray(packs)) return packs.length;
  return Object.keys(packs ?? {}).length;
}

function fixtureIds() {
  return Object.values(FIXTURE_IDS).flat().filter((value) => typeof value === "string");
}

describe("src/packs/catalog.js coverage, part 1", () => {
  // src/packs/catalog.js 75-76: with a lock, a local --pack path is located on disk by
  // locatePackageDir using cwd, and the lock's own sources are not used for it.
  test("a lock plus a relative local path loads only that pack, from cwd", () => {
    const root = tempDir("vbcdx-cov-catalog-");
    const packDir = join(root, "pack");
    cpSync(FIXTURE_PACK_DIR, packDir, { recursive: true });
    const otherDir = join(root, "other-pack");
    cpSync(FIXTURE_PACK_DIR, otherDir, { recursive: true });

    const lock = { sources: [{ spec: "@example/locked-pack", kinds: ["agents"], absDir: otherDir }] };
    const catalogue = loadCatalog(["./pack"], { cwd: root, lock });

    assert.ok(catalogue && typeof catalogue === "object");
    assert.equal(packCount(catalogue), 1);
    const ids = roleIds(catalogue);
    assert.ok(ids.length >= 1);
    for (const id of ids) assert.ok(fixtureIds().includes(id), `unexpected role id ${id}`);
  });

  // src/packs/catalog.js 75-76: the absolute form of a local path takes the same branch.
  test("a lock plus an absolute local path loads that pack", () => {
    const catalogue = loadCatalog([FIXTURE_PACK_DIR], { lock: emptyLock() });

    assert.ok(catalogue && typeof catalogue === "object");
    assert.equal(packCount(catalogue), 1);
    const ids = roleIds(catalogue);
    assert.ok(ids.length >= 1);
    for (const id of ids) assert.ok(fixtureIds().includes(id), `unexpected role id ${id}`);
  });

  // src/packs/catalog.js 75-76: a local path that is not there fails while naming the agent pack.
  test("a lock plus a local path that does not exist reports the missing agent pack", () => {
    const root = tempDir("vbcdx-cov-catalog-");

    const missing = join(root, "absent-pack");
    assert.throws(
      () => loadCatalog([missing], { cwd: root, lock: emptyLock() }),
      (e) => e.message === `No package directory at ${missing}.`,
    );
  });

  // src/packs/catalog.js 75-77: a non-path spec with a lock never touches the filesystem; it is
  // looked up in the lock, and one the lock does not carry fails while naming the agent pack.
  test("a lock plus a package name the lock does not carry reports the missing agent pack", () => {
    assert.throws(
      () => loadCatalog(["@example/absent-pack"], { lock: emptyLock() }),
      namesAgentPack,
    );
  });
});
