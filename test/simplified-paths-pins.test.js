// Pins for the behaviour that stays when an unreachable branch is removed: each test holds the
// invariant the removal relies on, so a later change that breaks it fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../src/errors.js";
import { parseVbcdxArgs } from "../src/install/args.js";
import { renderClaude } from "../src/renderers/claude.js";
import { renderOpencode } from "../src/renderers/opencode.js";
import { renderCodex } from "../src/renderers/codex.js";
import { renderHermes } from "../src/renderers/hermes.js";
import { boundToolsNote, HERMES_TOOLSET_OVERLAPS, HERMES_OVERLAP_LEGACY_DENY } from "../src/renderers/native.js";
import { readConfig } from "../src/install/config-entry.js";
import { stringifyPy } from "../src/fs/pyyaml.js";
import { getRole } from "../src/roles/index.js";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";
import { tempDir } from "./helpers/temp-dir.js";

const isErr = (code, re) => (e) => e.code === code && re.test(e.message);

// args.js: fetch and sources refuse a positional argument through the general check, before their own option rules
test("parseVbcdxArgs: fetch and sources refuse a positional argument (exit 2)", () => {
  for (const command of ["fetch", "sources"]) {
    assert.throws(() => parseVbcdxArgs([command, "extra"]), isErr(EXIT.CONFIG, new RegExp(`^${command} takes no positional arguments\\.$`)), command);
    assert.throws(() => parseVbcdxArgs([command, "extra", "--force"]), isErr(EXIT.CONFIG, new RegExp(`^${command} takes no positional arguments\\.$`)), `${command} --force`);
  }
});

// renderers/claude.js + opencode.js: the rendered body ends in exactly one newline because boundToolsNote is "" or ends in one
test("boundToolsNote: empty for no bindings, otherwise ends in a newline", () => {
  assert.equal(boundToolsNote([]), "");
  const note = boundToolsNote([{ server: "files", tools: ["read", "write"] }, { server: "notes", tools: ["list"] }]);
  assert.ok(note.endsWith("\n") && !note.endsWith("\n\n"), JSON.stringify(note));
});

test("renderClaude and renderOpencode: every role's file ends in exactly one newline", () => {
  assert.ok(FIXTURE_IDS.length > 0);
  for (const [name, render] of [["claude", renderClaude], ["opencode", renderOpencode]]) {
    for (const id of FIXTURE_IDS) {
      const { content } = render(getRole(id));
      assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"), `${name} ${id}`);
    }
  }
});

// codex.js: smol-toml's stringify always ends a document with a newline, so a guard that
// adds one cannot run. hermes.js: soul is prompt.trimEnd() + "\n" + a note that is "" or
// ends in a newline, so the same guard cannot run there either.
test("renderCodex and renderHermes: every role's definition ends in exactly one newline", () => {
  assert.ok(FIXTURE_IDS.length > 0);
  for (const id of FIXTURE_IDS) {
    const codex = renderCodex(getRole(id)).content;
    assert.ok(codex.endsWith("\n") && !codex.endsWith("\n\n"), `codex ${id}`);
    const soul = renderHermes(getRole(id)).files.find((f) => f.name === "SOUL.md").content;
    assert.ok(soul.endsWith("\n") && !soul.endsWith("\n\n"), `hermes ${id}`);
  }
});

// native.js: the overlap maps are empty at v0.21.5, which is what makes the removed skip
// unreachable. If one is filled, the skip has to come back with it.
test("HERMES_TOOLSET_OVERLAPS and HERMES_OVERLAP_LEGACY_DENY stay empty", () => {
  assert.deepEqual(Object.keys(HERMES_TOOLSET_OVERLAPS), [], "restore the overlap skip in hermesDisabledToolsets");
  assert.deepEqual(Object.keys(HERMES_OVERLAP_LEGACY_DENY), [], "restore the overlap skip in hermesDisabledToolsets");
});

// config-entry.js: every failure in the read and parse try blocks carries an errno or a
// parser message, so the fallback text arms cannot run.
test("readConfig: read and parse failures carry the errno or the parser's message", () => {
  const dir = tempDir("vbcdx-readconfig-");
  assert.deepEqual(readConfig(dir, "json"), { exists: true, text: null, doc: null, why: "cannot be read (EISDIR)" });
  const bad = { json: "{ not json", yaml: "a: [1, 2", toml: "a = " };
  for (const [format, text] of Object.entries(bad)) {
    const p = join(dir, `bad.${format}`);
    writeFileSync(p, text);
    const got = readConfig(p, format);
    assert.equal(got.exists, true, format);
    assert.equal(got.doc, null, format);
    assert.ok(got.why.startsWith(`cannot be read as ${format}: `), `${format}: ${got.why}`);
    assert.ok(got.why.length > `cannot be read as ${format}: `.length, `${format}: ${got.why}`);
    assert.ok(!got.why.includes("Error: "), `${format}: class name leaked: ${got.why}`);
  }
  // The toml prefix is smol-toml's fixed text, so that row is exact.
  assert.match(readConfig(join(dir, "bad.toml"), "toml").why, /^cannot be read as toml: Invalid TOML document: /);
});

// pyyaml.js: pyPrintable admits every code point above U+FFFF, so the escaped-string
// writer needs at most four hex digits and an astral character is written raw.
test("stringifyPy: a character above U+FFFF is written raw, not escaped", () => {
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(stringifyPy([emoji]), `- ${emoji}\n`);
});
