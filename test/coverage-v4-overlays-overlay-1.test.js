// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import {
  validateOverlayDeclaration,
  readOverlay,
  OVERLAY_DECLARATION_FILE,
  OVERLAY_SCHEMA_PATH,
} from "../src/overlays/overlay.js";
import "./helpers/fixture-pack.js";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";

const SCHEMA = JSON.parse(readFileSync(OVERLAY_SCHEMA_PATH, "utf8"));
const P = SCHEMA.properties;
const ROLE = [...FIXTURE_IDS][0];

describe("src/overlays/overlay.js coverage, part 1", () => {
  test("a declaration that is not an object gets one exact error", () => {
    // src/overlays/overlay.js 48
    const expected = {
      ok: false,
      errors: [`${OVERLAY_DECLARATION_FILE} must be a JSON object.`],
    };
    for (const value of [null, [], "overlay", 7, true]) {
      assert.deepEqual(validateOverlayDeclaration(value), expected);
    }
  });

  test("description rejects non-strings, multi-line text and oversized text", () => {
    // src/overlays/overlay.js 57
    const msg = "description must be one non-empty line of printable text.";
    for (const value of [42, null, true, ["line"]]) {
      const res = validateOverlayDeclaration({ description: value });
      assert.equal(res.ok, false);
      assert.ok(res.errors.includes(msg));
    }
    const multiLine = validateOverlayDeclaration({ description: "two\nlines" });
    assert.equal(multiLine.ok, false);
    assert.ok(multiLine.errors.includes(msg));
    const oversized = validateOverlayDeclaration({
      description: "a".repeat(P.description.maxLength + 1),
    });
    assert.equal(oversized.ok, false);
    assert.ok(oversized.errors.includes(msg));
  });

  test("vars rejects a value that is not an object", () => {
    // src/overlays/overlay.js 67
    for (const value of [[], "k", 3, null]) {
      const res = validateOverlayDeclaration({ vars: value });
      assert.equal(res.ok, false);
      assert.ok(res.errors.includes("vars must be an object."));
    }
  });

  test("vars rejects more entries than the schema allows", () => {
    // src/overlays/overlay.js 69
    const max = P.vars.maxProperties;
    const vars = {};
    for (let i = 0; i <= max; i += 1) vars[`v${i}`] = "x";
    assert.equal(Object.keys(vars).length, max + 1);
    const res = validateOverlayDeclaration({ vars });
    assert.equal(res.ok, false);
    assert.ok(res.errors.includes(`vars has more than ${max} values.`));
  });

  test("rename rejects more entries than the schema allows", () => {
    // src/overlays/overlay.js 82
    const max = P.rename.maxProperties;
    const rename = {};
    for (let i = 0; i <= max; i += 1) rename[`Bad Key ${i}`] = `Bad Value ${i}`;
    assert.equal(Object.keys(rename).length, max + 1);
    const res = validateOverlayDeclaration({ rename });
    assert.equal(res.ok, false);
    assert.ok(res.errors.includes(`rename has more than ${max} roles.`));
  });

  test("rename rejects a key that is not a role id", () => {
    // src/overlays/overlay.js 85
    const badKey = "Not A Role";
    const res = validateOverlayDeclaration({ rename: { [badKey]: ROLE } });
    assert.equal(res.ok, false);
    assert.ok(res.errors.includes(`rename: ${JSON.stringify(badKey)} is not a role id.`));
    const longKey = "a".repeat(65);
    const longRes = validateOverlayDeclaration({ rename: { [longKey]: ROLE } });
    assert.equal(longRes.ok, false);
    assert.ok(longRes.errors.includes(`rename: ${JSON.stringify(longKey)} is not a role id.`));
  });

  test("readOverlay reports an overlay text file that cannot be read", () => {
    // src/overlays/overlay.js 102-103: a role file that is a dangling link (its target is gone)
    const dir = tempDir("vbcdx-cov-overlay-");
    writeFileSync(join(dir, OVERLAY_DECLARATION_FILE), JSON.stringify({ schema_version: 1, name: "example-overlay", version: "1.0.0", packs: ["example-agents"] }));
    mkdirSync(join(dir, "roles"));
    symlinkSync(join(dir, "gone.md"), join(dir, "roles", `${ROLE}.md`));
    assert.throws(() => readOverlay(dir), (e) => {
      assert.equal(e.message, `Overlay example-overlay: roles/${ROLE}.md cannot be read.`);
      return true;
    });
  });
});
