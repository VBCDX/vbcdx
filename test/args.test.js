import { test } from "node:test";
import assert from "node:assert/strict";
import { packSpecs, parseInitArgs } from "../src/cli/args.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

test("requires --harness and --env", () => {
  assert.throws(() => parseInitArgs(["--env=/x"]), /--harness is required/);
  assert.throws(() => parseInitArgs(["--harness=claude"]), /--env is required/);
});

test("--env must be absolute", () => {
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=rel/path"]), /absolute path/);
});

test("defaults: user scope, no explicit selection (the planner selects every loaded role)", () => {
  const o = parseInitArgs(["--harness=claude", "--env=/c"]);
  assert.equal(o.scope, "user");
  assert.equal(o.agents, null);
  assert.equal(o.agentsExplicit, false);
});

test("--agents dedupes, preserves order, rejects a malformed id", () => {
  const o = parseInitArgs(["--harness=claude", "--env=/c", "--agents=pm-agent, code-agent ,pm-agent"]);
  assert.deepEqual(o.agents, ["pm-agent", "code-agent"]);
  assert.equal(o.agentsExplicit, true);
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=/c", "--agents=Bad_Id"]), /unknown agent ID/);
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=/c", "--agents=../x"]), /unknown agent ID/);
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=/c", "--agents=code-agent,"]), /empty item/);
});

test("dsh is not a harness and --profile is not an option", () => {
  assert.throws(() => parseInitArgs(["--harness=dsh", "--env=/c"]), /Unsupported --harness: dsh/);
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=/c", "--profile=web"]), /Unknown or malformed option: --profile=web/);
  assert.throws(() => parseInitArgs(["--env=/c"]), /--harness is required \(claude\|codex\|opencode\|hermes\)/);
});

test("rejects local/global as scopes and unknown options", () => {
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=/c", "--scope=local"]), /Unsupported --scope/);
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=/c", "--frobnicate"]), /Unknown or malformed option/);
});

test("--pack is repeatable and read before the full parse; an empty --pack is refused", () => {
  const argv = ["--harness=claude", "--env=/c", PACK_ARG, "--pack=@example/other"];
  assert.deepEqual(packSpecs(argv), [PACK_ARG.slice("--pack=".length), "@example/other"]);
  assert.deepEqual(parseInitArgs(argv).packs, packSpecs(argv));
  assert.deepEqual(packSpecs(["--harness=claude"]), []);
  assert.throws(() => packSpecs(["--pack="]), /--pack requires a value/);
  assert.throws(() => packSpecs(["--pack"]), /--pack requires a value/);
  assert.throws(() => parseInitArgs(["--harness=claude", "--env=/c", "--pack"]), /--pack requires a value/);
});

test("flags parse", () => {
  const o = parseInitArgs(["--harness=claude", "--env=/c", "--force", "--dry-run", "--quiet"]);
  assert.equal(o.force, true);
  assert.equal(o.dryRun, true);
  assert.equal(o.quiet, true);
});
