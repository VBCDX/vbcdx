// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { checkGitUrl, validateSources } from "../src/sources/config.js";

function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
  return undefined;
}

function expectMessage(fn, message) {
  const err = thrownBy(fn);
  assert.equal(err.message, message);
  return err;
}

describe("src/sources/config.js coverage, part 1", () => {
  // src/sources/config.js 46-48
  test("checkGitUrl rejects a value that is not an absolute URL", () => {
    const label = "dev-agents";
    for (const url of ["", "repo.git", "relative/dir/plugin.git", "://missing-scheme"]) {
      expectMessage(() => checkGitUrl(url, label), `${label}: git must be an absolute https:// or file:// URL.`);
    }
  });

  // src/sources/config.js 61
  test("validateSources rejects a document that is not a JSON object", () => {
    const base = tempDir("vbcdx-cov-config-");
    for (const doc of [null, undefined, [], "{\"schema_version\":1}", 0, true]) {
      expectMessage(() => validateSources(doc, base), "sources file is not a JSON object.");
    }
    expectMessage(() => validateSources(null, base, "vbcdx.sources.json"), "vbcdx.sources.json is not a JSON object.");
  });

  // src/sources/config.js 63
  test("validateSources names the unknown top-level field", () => {
    const base = tempDir("vbcdx-cov-config-");
    expectMessage(
      () => validateSources({ schema_version: 1, sources: {}, extra: true }, base),
      "sources file: unknown field \"extra\".",
    );
    expectMessage(
      () => validateSources({ schema_version: 1, sources: {}, git: {} }, base, "vbcdx.sources.json"),
      "vbcdx.sources.json: unknown field \"git\".",
    );
  });

  // src/sources/config.js 66
  test("validateSources demands schema_version 1 with no upgrade hint for a missing, old or non-numeric version", () => {
    const base = tempDir("vbcdx-cov-config-");
    for (const doc of [{ sources: {} }, { schema_version: 0, sources: {} }, { schema_version: "1", sources: {} }, { schema_version: null, sources: {} }]) {
      expectMessage(() => validateSources(doc, base), "sources file: schema_version must be 1.");
    }
  });

  // src/sources/config.js 66
  test("validateSources suggests an upgrade for a newer numeric schema_version", () => {
    const base = tempDir("vbcdx-cov-config-");
    expectMessage(
      () => validateSources({ schema_version: 2, sources: {} }, base),
      "sources file: schema_version must be 1; upgrade vbcdx to read it.",
    );
  });

  // src/sources/config.js 68
  test("validateSources requires sources to be an object", () => {
    const base = tempDir("vbcdx-cov-config-");
    for (const doc of [
      { schema_version: 1 },
      { schema_version: 1, sources: [] },
      { schema_version: 1, sources: "dev-agents" },
      { schema_version: 1, sources: null },
      { schema_version: 1, sources: 0 },
    ]) {
      expectMessage(() => validateSources(doc, base), "sources file: sources must be an object.");
    }
  });

  // src/sources/config.js 73
  test("validateSources requires each source entry to be an object, named in the message", () => {
    const base = tempDir("vbcdx-cov-config-");
    for (const value of [null, undefined, "shorthand", 1, [], true]) {
      expectMessage(
        () => validateSources({ schema_version: 1, sources: { local: value } }, base),
        "sources file: source \"local\" must be an object.",
      );
    }
  });

  // src/sources/config.js 80
  test("validateSources rejects a dir source whose dir is not a non-empty path", () => {
    const base = tempDir("vbcdx-cov-config-");
    for (const dir of ["", undefined, null, 42, [], {}, true]) {
      expectMessage(
        () => validateSources({ schema_version: 1, sources: { local: { dir } } }, base),
        "sources file: source \"local\": dir must be a path.",
      );
    }
  });
});
