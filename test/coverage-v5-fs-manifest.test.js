// Coverage for branches of src/fs/manifest.js that the shared writer tests leave unreached:
// a manifest file holding valid JSON of the wrong shape, the classification of an unowned file
// that already holds the desired content, the no-op apply path such a file takes, and the action
// an install reports. Each test names the source line it reaches. Fixtures are plain files in a
// temp dir, as in test/safe-writer.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import { sha256 } from "../src/fs/safe-writer.js";
import { applyGenerated, classifyGenerated, readManifest } from "../src/fs/manifest.js";
import { EXIT } from "../src/errors.js";

const isFilesystemError = (message) => (err) => err.code === EXIT.FILESYSTEM && err.message === message;

// src/fs/manifest.js:43-45
test("readManifest refuses valid JSON that is not a manifest of this schema", () => {
  const d = tempDir("vbcdx-cov-manifest-");
  const shapes = [
    JSON.stringify({ schema_version: "x", files: {} }),
    JSON.stringify({ schema_version: 1, files: null }),
    "null",
  ];
  for (const [i, text] of shapes.entries()) {
    const p = join(d, `shape-${i}.json`);
    writeFileSync(p, text);
    assert.throws(
      () => readManifest(p, "1.0.0"),
      isFilesystemError(`Installation manifest is an unsupported shape: ${p}.`),
      text,
    );
  }
});

// src/fs/manifest.js:75
test("classifyGenerated adopts identical unowned content as a noop", () => {
  const d = tempDir("vbcdx-cov-manifest-");
  const p = join(d, "role.md");
  const content = "name: reader\n";
  writeFileSync(p, content);
  assert.equal(classifyGenerated(p, sha256(Buffer.from(content)), undefined), "noop");
});

// src/fs/manifest.js:86-89
test("applyGenerated reports a noop for identical unowned content and keeps the file", () => {
  const d = tempDir("vbcdx-cov-manifest-");
  const p = join(d, "role.md");
  const content = "name: reader\n";
  writeFileSync(p, content);
  const digest = sha256(Buffer.from(content));
  assert.deepEqual(applyGenerated({ absPath: p, content, digest, recordedEntry: undefined }), { action: "noop", digest });
  assert.equal(readFileSync(p, "utf8"), content);
});

// src/fs/manifest.js:97
test("applyGenerated installs a new unowned file and reports the install action", () => {
  const d = tempDir("vbcdx-cov-manifest-");
  const p = join(d, "role.md");
  const content = "name: writer\n";
  const digest = sha256(Buffer.from(content));
  const res = applyGenerated({ absPath: p, content, digest, recordedEntry: undefined });
  assert.equal(res.action, "install");
  assert.equal(res.digest, digest);
  assert.equal(readFileSync(p, "utf8"), content);
});
