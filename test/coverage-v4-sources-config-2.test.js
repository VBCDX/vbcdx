// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { SOURCES_SCHEMA_VERSION, validateSources, loadSources } from "../src/sources/config.js";

const docWith = (sources) => ({ schema_version: SOURCES_SCHEMA_VERSION, sources });

function errorFrom(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("src/sources/config.js coverage, part 2", () => {
  // src/sources/config.js 91
  test("a git origin whose value is not a string is rejected with the exact message", () => {
    const base = tempDir("vbcdx-cov-config-");
    const expected = 'sources file: source "bad-git": git must be a URL.';
    for (const value of [42, null, true, undefined, ["x"], {}]) {
      const err = errorFrom(() =>
        validateSources(docWith({ "bad-git": { git: value, ref: "main" } }), base),
      );
      assert.ok(err instanceof Error, `expected a thrown Error for ${String(value)}`);
      assert.equal(err.message, expected);
    }
  });

  // src/sources/config.js 91
  test("the label argument becomes the prefix of the git error", () => {
    const base = tempDir("vbcdx-cov-config-");
    const err = errorFrom(() =>
      validateSources(docWith({ "bad-git": { git: 5, ref: "main" } }), base, "custom sources"),
    );
    assert.ok(err instanceof Error, "expected a thrown Error");
    assert.equal(err.message, 'custom sources: source "bad-git": git must be a URL.');
  });

  // src/sources/config.js 96
  test("a string git URL is accepted and returned as a git origin", () => {
    const base = tempDir("vbcdx-cov-config-");
    const url = "https://example.invalid/acme/plugin.git";
    const out = validateSources(docWith({ "ok-git": { git: url, ref: "main" } }), base);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "ok-git");
    assert.equal(out[0].origin, "git");
    assert.equal(out[0].git, url);
    assert.equal(out[0].ref, "main");
  });

  // src/sources/config.js 115
  test("a missing sources file reports the fs code", () => {
    const dir = tempDir("vbcdx-cov-config-");
    const missing = join(dir, "absent.json");
    const err = errorFrom(() => loadSources(missing));
    assert.ok(err instanceof Error, "expected a thrown Error");
    assert.equal(err.message, `Cannot read the sources file ${missing} (ENOENT).`);
  });

  // src/sources/config.js 115
  test("a directory given as the sources file reports EISDIR", () => {
    const dir = tempDir("vbcdx-cov-config-");
    const asFile = join(dir, "as-file");
    mkdirSync(asFile, { recursive: true });
    const err = errorFrom(() => loadSources(asFile));
    assert.ok(err instanceof Error, "expected a thrown Error");
    assert.equal(err.message, `Cannot read the sources file ${asFile} (EISDIR).`);
  });
});
