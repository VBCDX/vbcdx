import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, validateServiceUrl } from "../src/config/config.js";
import { parseStrictJson } from "../src/config/json.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

function cfg(obj) {
  return new Map(Object.entries(obj));
}

test("requires BASE_DIR and CREDENTIALS_DIR", () => {
  assert.throws(() => loadConfig(cfg({}), { harness: "claude", scope: "project" }), /BASE_DIR is required/);
  assert.throws(
    () => loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "/b" }), { harness: "claude", scope: "project" }),
    /CREDENTIALS_DIR is required/,
  );
});

test("rejects unknown VBCDX_AGENTS_ keys to catch typos", () => {
  assert.throws(
    () => loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c", VBCDX_AGENTS_BAES_DIR: "/x" }), { harness: "claude", scope: "project" }),
    /Unsupported configuration key/,
  );
});

test("ignores unrelated non-VBCDX keys", () => {
  const c = loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c", PATH: "/usr/bin" }), { harness: "claude", scope: "project" });
  assert.equal(c.baseDir, "/b");
});

test("requires the harness root for user scope", () => {
  assert.throws(
    () => loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c" }), { harness: "claude", scope: "user" }),
    /CLAUDE_CONFIG_DIR is required/,
  );
  // DSH is gone: its home key is now an unknown (rejected) key like any typo.
  assert.throws(
    () => loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c", VBCDX_AGENTS_DSH_HOME: "/d" }), { harness: "claude", scope: "project" }),
    /Unsupported configuration key VBCDX_AGENTS_DSH_HOME/,
  );
  // Project scope does not require the harness root.
  assert.doesNotThrow(() =>
    loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c" }), { harness: "claude", scope: "project" }),
  );
});

test("rejects a nonblank reserved WORKDIR", () => {
  assert.throws(
    () => loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c", VBCDX_AGENTS_WORKDIR: "/w" }), { harness: "claude", scope: "project" }),
    /WORKDIR is reserved/,
  );
});

test("rejects relative and traversal paths", () => {
  assert.throws(
    () => loadConfig(cfg({ VBCDX_AGENTS_BASE_DIR: "b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c" }), { harness: "claude", scope: "project" }),
    /absolute path/,
  );
});

test("validates the code-host URL and rejects embedded credentials", () => {
  assert.equal(validateServiceUrl("K", "https://git.example.com"), "https://git.example.com");
  assert.throws(() => validateServiceUrl("K", "https://user:pw@git.example.com"), /must not embed credentials/);
  assert.throws(() => validateServiceUrl("K", "ftp://x"), /http or https/);
});

test("user scope records the launch-environment translation", () => {
  const c = loadConfig(
    cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c", VBCDX_AGENTS_CLAUDE_CONFIG_DIR: "/h" }),
    { harness: "claude", scope: "user" },
  );
  assert.deepEqual(c.launchEnv, { CLAUDE_CONFIG_DIR: "/h" });
});

test("strict JSON rejects duplicate keys and trailing data", () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate object key/);
  assert.throws(() => parseStrictJson('{"a":1} junk'), /trailing data/);
  assert.deepEqual(parseStrictJson('{"a":[1,2],"b":"x"}'), { a: [1, 2], b: "x" });
});
