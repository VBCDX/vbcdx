// Further installer coverage for src/service/index.js: the doctor report, the refused link step of a
// dry run (a KEK gone from an instance that has run) and a plan report with no carried settings.
// Every failure is produced at a real boundary: report objects a caller can pass, a signed release
// tree in a temp dir, and state files in a temp root. Nothing patches module internals.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { humanPlan, humanReport, runService } from "../src/service/index.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem } from "../src/service/system.js";
import { EXIT } from "../src/errors.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(21);
const STATE = "/var/lib/vbcdx-keyhole/default";
const CA = "-----BEGIN CERTIFICATE-----\nMIIBcontrolca\n-----END CERTIFICATE-----\n";
const CERT = "-----BEGIN CERTIFICATE-----\nMIIBleaf\n-----END CERTIFICATE-----\n";

// @vbcdx/keyhole as its release job packs it (one platform is enough here).
function release(version = "0.1.0") {
  const root = tempDir("vbcdx-index-plan-rel-");
  const rel = "@vbcdx/keyhole-linux-x64-gnu/bin/keyhole";
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  const body = Buffer.from(`\x7fELF keyhole ${version}\n`);
  writeFileSync(join(root, rel), body, { mode: 0o755 });
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/keyhole", version, files: { [rel]: sha(body) } }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release @vbcdx/keyhole ${version}`));
  return root;
}

// A host under a temp root, and the deps planInstall and runService take from it.
function host() {
  const root = tempDir("vbcdx-index-plan-host-");
  const sys = fakeSystem(root, { uid: 0 });
  return { root, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu",
    host: { uid: 0, home: "/root", runtimeDir: null } } };
}

function pemFile(text, name) {
  const dir = tempDir("vbcdx-index-plan-pem-");
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

// The control-plane flags keyhole-server needs; --control-ca is read when the plan is built.
const CONTROL_PLANE = () => ["--link-listen", "127.0.0.1:8444", "--control-url", "https://127.0.0.1:8443",
  "--control-ca", pemFile(CA, "control-ca.pem")];

describe("src/service/index.js coverage, doctor and plan", () => {
  // src/service/index.js 336-337: the doctor body names the instance, its version and whether it
  // found problems, one row per check, and the hint only when there is one.
  test("doctor report: a failing check prints FAIL and the hint; a passing one prints ok and no hint", () => {
    const failed = humanReport("doctor", {
      service: "sidecar",
      instance: "default",
      version: "1.0.0",
      ok: false,
      checks: [
        { ok: true, check: "unit", detail: "loaded" },
        { ok: false, check: "socket", detail: "missing" },
      ],
      hint: "run install again",
    });
    assert.deepEqual(failed.split("\n"), [
      "doctor sidecar (default, 1.0.0): problems found",
      "  ok   unit: loaded",
      "  FAIL socket: missing",
      "  run install again",
    ]);
    const passed = humanReport("doctor", {
      service: "sidecar",
      instance: "default",
      version: "1.0.0",
      ok: true,
      checks: [{ ok: true, check: "unit", detail: "loaded" }],
    });
    assert.deepEqual(passed.split("\n"), [
      "doctor sidecar (default, 1.0.0): ok",
      "  ok   unit: loaded",
    ]);
  });

  // src/service/index.js 348-353: a keyhole-server instance that has run (its link key is there) and
  // has lost its KEK is refused before anything is written; the dry run still reports which
  // certificate it was given or that the installed one is there, and the plan says it would refuse.
  test("dry run: a missing KEK is refused, and the certificate it was given or already has is reported", () => {
    const h = host();
    const rel = release();
    const state = join(h.root, STATE);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "link.key"), "KEY", { mode: 0o600 });
    writeFileSync(join(state, "link.crt"), CERT, { mode: 0o600 });
    const dry = (extra = []) => runService(parseServiceArgs(["install", "service", "keyhole-server", "--from", rel,
      ...CONTROL_PLANE(), "--dry-run", ...extra]), h.deps);

    // The certificate is already installed: no --service-cert, and the refusal still reports it.
    const installed = dry();
    assert.equal(installed.code, EXIT.CONFLICT);
    assert.equal(installed.report.link_steps.cert, "installed");
    assert.equal(installed.report.link_steps.starts, false);
    assert.deepEqual(installed.report.link_steps.make, []);
    assert.match(installed.report.link_steps.refused,
      /^\/var\/lib\/vbcdx-keyhole\/default\/kek is missing, but this instance has already run \(\/var\/lib\/vbcdx-keyhole\/default\/link\.key exists\): /);
    const installedText = humanReport("plan", installed.report);
    assert.match(installedText,
      /^ {2}CONFLICT \/var\/lib\/vbcdx-keyhole\/default\/kek is missing, but this instance has already run .*Install would refuse \(exit 5\)\.$/m);
    assert.match(installedText, /no link certificate yet \(vbcdx-control services add keyhole .*then rerun with --service-cert\)/);

    // Given with --service-cert: reported as given, and the plan names the file and who checks it.
    const given = dry(["--service-cert", pemFile(CERT, "keyhole.crt")]);
    assert.equal(given.code, EXIT.CONFLICT);
    assert.equal(given.report.link_steps.cert, "given");
    assert.equal(given.report.link_steps.starts, false);
    assert.match(humanReport("plan", given.report),
      /link certificate \/var\/lib\/vbcdx-keyhole\/default\/link\.crt \(--service-cert\), checked as vbcdx-keyhole$/m);
  });

  // src/service/index.js 391: a plan report with no carried settings (nothing installed to carry
  // from) still prints its rows and says there is nothing to change.
  test("plan report with no carried settings prints the changed rows and no keep lines", () => {
    const out = humanPlan({
      service: "sidecar",
      instance: "default",
      version: "1.2.3",
      platform: "linux-x64-gnu",
      scope: "system",
      signature: { keyId: "5F2A9C14D7B3E608", trustedComment: "vbcdx-release @vbcdx/sidecar 1.2.3" },
      dirs: [],
      binaries: [],
      symlink: { path: "/usr/local/lib/vbcdx/sidecar/current", target: "1.2.3" },
      files: [{ path: "/etc/vbcdx/default/sidecar.toml", mode: "0640", owner: "root", group: "vbcdx" }],
      unit: null,
      start: false,
      run: "vbcdx-sidecar serve --instance default",
      changes: { dirs: [], binaries: [], symlink: false, files: [] },
      record: "/root/.vbcdx/manifests/installation.json",
    });
    assert.deepEqual(out.split("\n"), [
      "Planned reinstall service sidecar 1.2.3 (linux-x64-gnu, system) as instance default",
      '  signature: key 5F2A9C14D7B3E608, "vbcdx-release @vbcdx/sidecar 1.2.3"',
      "  no file changes",
      "  no unit (--service none); run it with: vbcdx-sidecar serve --instance default",
      "  record /root/.vbcdx/manifests/installation.json",
    ]);
    assert.ok(!out.includes("(from the installed"), out);
  });
});
