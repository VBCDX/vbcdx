// Install coverage, fifth batch: behaviour tests for uncovered ranges (see each test's comment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers/temp-dir.js";
import { validateSources } from "../src/sources/config.js";

test("a schema_version below the supported one is refused with no upgrade hint", () => {
  // src/sources/config.js:66 — the false arm of the "upgrade vbcdx" suffix.
  const base = tempDir("vbcdx-cov-config-");
  const cases = [
    [undefined, "sources file"],
    ["vbcdx.sources.json", "vbcdx.sources.json"],
    ["custom sources", "custom sources"],
  ];
  for (const [label, prefix] of cases) {
    assert.throws(
      () => validateSources({ schema_version: 0, sources: {} }, base, label),
      { message: `${prefix}: schema_version must be 1.` },
    );
  }
  // A version that is not a number takes the same arm.
  assert.throws(
    () => validateSources({ schema_version: "1", sources: {} }, base),
    { message: "sources file: schema_version must be 1." },
  );
});
