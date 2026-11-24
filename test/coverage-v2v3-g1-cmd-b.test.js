// Installer coverage, second batch, group 1: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveContext } from "../src/install/context.js";
import { list, remove } from "../src/install/commands.js";
import { readManifest, writeManifest } from "../src/fs/manifest.js";
import { packageVersion } from "../src/index.js";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
describe("src/install/commands.js coverage, part 2", () => {
  function withHome(fn) {
    const home = tempDir("vbcdx-cov-cmd-b-");
    try {
      return fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  function ctxFor(home, harness = "opencode") {
    return resolveContext({ harness, scope: "user", envPath: null, home, cwd: home, env: {} });
  }

  function seed(ctx, { files = {}, entries = {}, tools = {} } = {}) {
    mkdirSync(dirname(ctx.manifestPath), { recursive: true });
    const base = readManifest(ctx.manifestPath, packageVersion());
    base.files = files;
    base.entries = entries;
    base.tools = tools;
    writeManifest(ctx.manifestPath, base);
  }

  test("list: a record written for another harness is skipped", () => {
    withHome((home) => {
      const ctx = ctxFor(home);
      const mine = join(home, "owned", "mine.md");
      const other = join(home, "owned", "other.md");
      seed(ctx, {
        files: {
          [mine]: { digest: "a".repeat(64), skill: "example-skill", harness: "opencode" },
          [other]: { digest: "b".repeat(64), skill: "example-skill", harness: "claude" },
        },
      });
      // src/install/commands.js 290
      const out = list(ctx);
      assert.deepEqual(out.skills.map((s) => s.file), [mine]);
    });
  });

  test("list: a tool with no recorded config entry reports no file", () => {
    withHome((home) => {
      const ctx = ctxFor(home);
      seed(ctx, {
        tools: {
          "opencode:user:example-tracker": {
            harness: "opencode",
            server_name: "example-tracker",
            version: "1.2.3",
            scope: "user",
            tools: ["example-call"],
            entry: null,
          },
        },
      });
      // src/install/commands.js 295
      const out = list(ctx);
      assert.equal(out.tools.length, 1);
      assert.equal(out.tools[0].file, null);
    });
  });
});
