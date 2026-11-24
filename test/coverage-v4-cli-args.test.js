// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseInitArgs } from "../src/cli/args.js";
import "./helpers/fixture-pack.js";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";
import { tempDir } from "./helpers/temp-dir.js";

describe("src/cli/args.js coverage, part 1", () => {
  const STORE_MSG = "--store goes with --lock and must be an absolute path.";
  const LOCK_MSG = "--lock must be an absolute path.";

  const abs = (name) => join(tempDir("vbcdx-cov-args-"), name);
  const base = (extra) => ["--harness=claude", `--env=${abs("env.json")}`, ...extra];

  function throwsMessage(fn, message) {
    assert.throws(fn, (err) => {
      assert.ok(err instanceof Error, "expected an Error instance");
      assert.equal(err.message, message);
      return true;
    });
  }

  test("refuses --store without --lock, whether the store path is absolute or relative", () => {
    // src/cli/args.js 86
    throwsMessage(() => parseInitArgs(base([`--store=${abs("store.json")}`])), STORE_MSG);
    throwsMessage(() => parseInitArgs(base(["--store=rel/store.json"])), STORE_MSG);
  });

  test("refuses a relative --store even when --lock is absolute", () => {
    // src/cli/args.js 86
    const lock = abs("lock.json");
    throwsMessage(
      () => parseInitArgs(base([`--lock=${lock}`, "--store=rel/store.json"])),
      STORE_MSG,
    );
  });

  test("accepts --lock and --store together when both are absolute", () => {
    // src/cli/args.js 84-86
    const lock = abs("lock.json");
    const store = abs("store.json");
    const opts = parseInitArgs(base([`--lock=${lock}`, `--store=${store}`]));
    assert.equal(opts.lock, lock);
    assert.equal(opts.store, store);
  });

  test("--lock and --store both default to null", () => {
    // src/cli/args.js 84-86
    const opts = parseInitArgs(base([]));
    assert.equal(opts.lock, null);
    assert.equal(opts.store, null);
  });

  test("a relative --lock is refused before --store is considered", () => {
    // src/cli/args.js 85-86
    throwsMessage(
      () => parseInitArgs(base(["--lock=rel/lock.json", "--store=rel/store.json"])),
      LOCK_MSG,
    );
  });

  test("no reachable --agents value produces the 'selected no agents' branch", () => {
    // src/cli/args.js 28
    const id = FIXTURE_IDS[0];
    const rejected = [" ", ",", ",,", `${id},`, `,${id}`];
    for (const raw of rejected) {
      assert.throws(
        () => parseInitArgs(base([`--agents=${raw}`])),
        (err) => {
          assert.ok(err instanceof Error, "expected an Error instance");
          assert.match(
            err.message,
            /--agents (contains an empty item|has an unknown agent ID)/,
          );
          assert.doesNotMatch(err.message, /selected no agents/);
          return true;
        },
      );
    }
  });

  test("a single fixture role id yields a non-empty explicit selection", () => {
    // src/cli/args.js 16-30
    const id = FIXTURE_IDS[0];
    const opts = parseInitArgs(base([`--agents=${id}`]));
    assert.deepEqual(opts.agents, [id]);
    assert.equal(opts.agentsExplicit, true);
    const dup = parseInitArgs(base([`--agents=${id},${id}`]));
    assert.deepEqual(dup.agents, [id]);
  });
});
