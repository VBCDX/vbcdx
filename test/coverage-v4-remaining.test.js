// Installer coverage, fourth batch: the ranges the drafted cards left, written against the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";
import { OVERLAY_DECLARATION_FILE, readOverlay } from "../src/overlays/overlay.js";
import { humanReport } from "../src/service/index.js";

const ROLE = [...FIXTURE_IDS][0];

function overlayDir() {
  const dir = tempDir("vbcdx-cov-ovl-");
  writeFileSync(join(dir, OVERLAY_DECLARATION_FILE), JSON.stringify({ schema_version: 1, name: "example-overlay", version: "1.0.0", packs: ["example-agents"] }));
  return dir;
}

// overlay.js 107: a role text that is a directory, not a regular file, is refused by name
test("readOverlay: a roles/<id>.md that is a directory is refused as not a regular file", () => {
  const dir = overlayDir();
  mkdirSync(join(dir, "roles", `${ROLE}.md`), { recursive: true });
  assert.throws(() => readOverlay(dir), (e) => e.message === `Overlay example-overlay: roles/${ROLE}.md is not a regular file.`);
});

// overlay.js 155: under slots/, a file that is neither a .md text nor a directory is ignored
test("readOverlay: a stray non-directory entry under slots/ is skipped, the overlay still loads", () => {
  const dir = overlayDir();
  mkdirSync(join(dir, "slots"));
  writeFileSync(join(dir, "slots", "notes.txt"), "not a slot\n");
  const o = readOverlay(dir);
  assert.equal(o.name, "example-overlay");
  assert.deepEqual(o.slots, {});
  assert.deepEqual(o.roleSlots, {});
});

// overlay.js 156: a per-role slots directory must be named like a role id
test("readOverlay: a slots/ directory not named like a role id is refused", () => {
  const dir = overlayDir();
  mkdirSync(join(dir, "slots", "Not_A_Role"), { recursive: true });
  assert.throws(() => readOverlay(dir), (e) => e.message === "Overlay example-overlay: slots/Not_A_Role is not named after a role.");
});

// service/index.js 336-337: a doctor report renders ok/FAIL per check and the hint only when there is one
test("humanReport doctor: an ok report with no hint, and a failing report with its hint", () => {
  const base = { service: "sidecar", instance: "default", version: "0.1.0" };
  assert.equal(
    humanReport("doctor", { ...base, ok: true, checks: [{ check: "unit", ok: true, detail: "active" }] }),
    "doctor sidecar (default, 0.1.0): ok\n  ok   unit: active",
  );
  assert.equal(
    humanReport("doctor", { ...base, ok: false, checks: [{ check: "listen", ok: false, detail: "nothing on 127.0.0.1:7000" }], hint: "run install service again" }),
    "doctor sidecar (default, 0.1.0): problems found\n  FAIL listen: nothing on 127.0.0.1:7000\n  run install service again",
  );
});

// service/index.js 338-339: a report kind it doesn't know renders as nothing (its warnings still print)
test("humanReport: an unknown kind renders no body, only its warnings", () => {
  assert.equal(humanReport("unknown-kind", {}), "");
  assert.equal(humanReport("unknown-kind", { warnings: ["something to know"] }), "warning: something to know");
});
