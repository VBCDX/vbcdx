// The refusal and classification branches of one owned entry in a harness configuration
// file: the canonical digest form, the JSON, YAML and TOML format helpers, the reader and
// the two read-only planners. Each case passes real text, a real file or a real directory
// and asserts the outcome, so a change that stops refusing (or starts writing) is caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import {
  canonical, entryDigest, FORMATS, readConfig, planEntryWrite, planEntryRemove,
} from "../src/install/config-entry.js";

const dir = () => tempDir("vbcdx-cov-config-entry-");
const write = (path, text) => writeFileSync(path, text);

test("canonical tags a bigint, so its digest can never equal a number's", () => {
  // src/install/config-entry.js:28
  assert.equal(canonical(5n), "#int:5");
});

test("canonical tags a Date with its ISO form", () => {
  // src/install/config-entry.js:29
  assert.equal(canonical(new Date("2020-01-02T03:04:05.000Z")), "#date:2020-01-02T03:04:05.000Z");
});

test("canonical reads undefined as null, the value JSON keeps in its place", () => {
  // src/install/config-entry.js:34
  assert.equal(canonical(undefined), "null");
});

test("json: a blank document is an empty mapping", () => {
  // src/install/config-entry.js:73
  assert.deepEqual(FORMATS.json.parse(" \n"), {});
  assert.deepEqual(FORMATS.json.parse(""), {});
});

test("json: a document that is not an object is refused, and readConfig says why", () => {
  // src/install/config-entry.js:74
  assert.throws(() => FORMATS.json.parse("[1]"), { message: "is not a JSON object" });
  const file = join(dir(), "config.json");
  write(file, "[1]\n");
  assert.deepEqual(readConfig(file, "json"), {
    exists: true, text: "[1]\n", doc: null, why: "cannot be read as json: is not a JSON object",
  });
});

test("json: set refuses to walk through a value that is not an object", () => {
  // src/install/config-entry.js:82
  assert.throws(() => FORMATS.json.set('{"a": 1}', ["a", "b"], 2), { message: "a is not an object" });
});

test("yaml: an empty document is an empty mapping", () => {
  // src/install/config-entry.js:96
  assert.deepEqual(FORMATS.yaml.parse(""), {});
  assert.deepEqual(FORMATS.yaml.parse("~\n"), {});
});

test("yaml: a sequence is refused as a configuration document", () => {
  // src/install/config-entry.js:97
  assert.throws(() => FORMATS.yaml.parse("- 1\n"), { message: "is not a YAML mapping" });
});

test("yaml: editing beside a merge key is refused", () => {
  // src/install/config-entry.js:104
  const text = "base: &b {x: 1}\nd:\n  <<: *b\n";
  assert.throws(() => FORMATS.yaml.set(text, ["d", "y"], 1), { message: "contains a << merge key" });
});

test("yaml: a root sequence is refused before a key is set on it", () => {
  // src/install/config-entry.js:106
  assert.throws(() => FORMATS.yaml.set("- 1\n", ["a"], 1), { message: "is not a YAML mapping" });
});

test("yaml: set refuses to walk through a value that is not a mapping", () => {
  // src/install/config-entry.js:118
  assert.throws(() => FORMATS.yaml.set("a: 1\n", ["a", "b"], 2), { message: "a is not a mapping" });
});

test("yaml: remove leaves the text as it was when the path walks into a scalar", () => {
  // src/install/config-entry.js:129
  assert.equal(FORMATS.yaml.remove("a: 1\n", ["a", "b"]), "a: 1\n");
});

test("toml: a key that is not bare is quoted in the entry's table header", () => {
  // src/install/config-entry.js:147
  const text = FORMATS.toml.set(null, ["a b"], { c: 1 });
  assert.match(text, /^\["a b"\]\n/);
  assert.match(text, /^c = 1$/m);
  assert.equal(FORMATS.toml.parse(text)["a b"].c, 1);
});

test("toml: a value with no table of its own is refused", () => {
  // src/install/config-entry.js:168
  assert.throws(() => FORMATS.toml.set(null, ["a"], 1), {
    message: "rendered TOML has no table header for the entry",
  });
});

test("toml: remove leaves a file with no block for the path unchanged", () => {
  // src/install/config-entry.js:190
  assert.equal(FORMATS.toml.remove("a = 1\n", ["b"]), "a = 1\n");
});

test("readConfig: a missing file is an install target with an empty document", () => {
  // src/install/config-entry.js:208
  assert.deepEqual(readConfig(join(dir(), "absent.json"), "json"), { exists: false, text: null, doc: {} });
});

test("readConfig: a path that cannot be read reports the code and no document", () => {
  // src/install/config-entry.js:209
  assert.deepEqual(readConfig(dir(), "json"), {
    exists: true, text: null, doc: null, why: "cannot be read (EISDIR)",
  });
});

test("planEntryWrite: a missing file the manifest records is a repair that creates it", () => {
  // src/install/config-entry.js:245
  const file = join(dir(), "absent.json");
  const plan = planEntryWrite({ absPath: file, format: "json", path: ["a"], value: 1, recorded: { digest: "x" } });
  assert.equal(plan.cls, "repair");
  assert.equal(plan.createsFile, true);
  assert.equal(plan.content, FORMATS.json.set(null, ["a"], 1));
  // Classification is read-only: the missing file is still missing.
  assert.equal(existsSync(file), false);
});

test("planEntryWrite: an absent entry in an existing file that is recorded is a repair", () => {
  // src/install/config-entry.js:257
  const file = join(dir(), "config.json");
  write(file, '{"b": 2}\n');
  const plan = planEntryWrite({ absPath: file, format: "json", path: ["a"], value: 1, recorded: { digest: "x" } });
  assert.equal(plan.cls, "repair");
  assert.equal(plan.createsFile, false);
  assert.deepEqual(JSON.parse(plan.content), { b: 2, a: 1 });
});

test("planEntryWrite: an entry whose recorded digest is what is on disk is an update", () => {
  // src/install/config-entry.js:260
  const file = join(dir(), "config.json");
  write(file, '{"a": 1}\n');
  const plan = planEntryWrite({ absPath: file, format: "json", path: ["a"], value: 2, recorded: { digest: entryDigest(1) } });
  assert.equal(plan.cls, "update");
  assert.deepEqual(JSON.parse(plan.content), { a: 2 });
});

test("planEntryRemove: a missing file is absent, with nothing to write", () => {
  // src/install/config-entry.js:275
  const plan = planEntryRemove({ absPath: join(dir(), "absent.json"), format: "json", path: ["a"], recorded: { digest: "x" } });
  assert.deepEqual(plan, { cls: "absent", content: null });
});

test("planEntryRemove: a file that cannot be read as its format is a conflict, left untouched", () => {
  // src/install/config-entry.js:276
  const file = join(dir(), "broken.json");
  write(file, '{ "a": ');
  const plan = planEntryRemove({ absPath: file, format: "json", path: ["a"], recorded: { digest: "x" } });
  assert.equal(plan.cls, "conflict");
  assert.equal(plan.content, null);
  assert.match(plan.note, /^cannot be read as json: .+; left untouched$/);
  assert.equal(readFileSync(file, "utf8"), '{ "a": ');
});

test("planEntryRemove: an entry that removal cannot take out is a conflict, left untouched", () => {
  // src/install/config-entry.js:283
  const text = 'mcp_servers.example.command = "x"\n';
  const file = join(dir(), "config.toml");
  write(file, text);
  const plan = planEntryRemove({
    absPath: file, format: "toml", path: ["mcp_servers", "example"],
    recorded: { digest: entryDigest({ command: "x" }), created_file: false },
  });
  assert.equal(plan.cls, "conflict");
  assert.equal(plan.content, null);
  assert.equal(plan.note, "cannot be edited in place (the entry is still present after removal); left untouched");
  assert.equal(readFileSync(file, "utf8"), text);
});
