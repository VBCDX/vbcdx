// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { humanPlan, humanReport, readControlCA, runService } from "../src/service/index.js";

describe("src/service/index.js coverage, part 1", () => {
  // src/service/index.js 28:45-28:104
  test("a non-root host with a relative or missing HOME is refused", () => {
    const relative = { uid: 1000, home: "relative/home", runtimeDir: null };
    assert.throws(() => runService({ command: "service" }, { host: relative }),
      /HOME must be set to an absolute path\./);
    const noHome = { uid: 1000, home: undefined, runtimeDir: null };
    assert.throws(() => runService({ command: "service" }, { host: noHome }),
      /HOME must be set to an absolute path\./);
  });

  // src/service/index.js 108:24-108:36
  test("readControlCA is null when no --control-ca was given", () => {
    assert.equal(readControlCA({}), null);
    assert.equal(readControlCA({ controlCa: "" }), null);
  });

  // src/service/index.js 269:5-270:70
  test("an unknown service command is a config error naming the command", () => {
    const host = { uid: 1000, home: tempDir("vbcdx-cov-index-host-"), runtimeDir: null };
    assert.throws(() => runService({ command: "cov-frobnicate" }, { host }),
      /Unknown service command: cov-frobnicate\./);
  });

  // src/service/index.js 306:24-306:44: a plan report is the plan's own rendering (no warnings)
  test("a plan-kind report is rendered through humanPlan", () => {
    const plan = {
      service: "sidecar", version: "0.1.0", platform: "linux-x64", scope: "user", instance: "default",
      signature: { keyId: "k1", trustedComment: "release 0.1.0" },
      dirs: [], binaries: [], symlink: { path: "/opt/vbcdx/current", target: "0.1.0" }, files: [], listen: "127.0.0.1:7000",
    };
    const text = humanReport("plan", plan);
    assert.equal(text, humanPlan(plan));
    assert.match(text, /^Planned install service sidecar 0\.1\.0 \(linux-x64, user\) as instance default\n  signature: key k1, "release 0\.1\.0"/);
  });

  // src/service/index.js 308:37-308:95: an unchanged install lists each kept file under its first line
  test("an unchanged install report lists each kept file with the edited-since-install note", () => {
    assert.equal(
      humanReport("install", { service: "sidecar", version: "0.1.0", instance: "default", changed: false, kept: ["config/sidecar.toml"] }),
      "install service sidecar 0.1.0 (default): already in place, nothing changed\n  kept config/sidecar.toml (edited since install; left as it is)",
    );
  });

  // src/service/index.js 308:26-308:31 (no kept list) + 309:45-309:125: a changed install lists each replaced file
  test("a changed install report lists each replaced file and tolerates a missing kept list", () => {
    assert.equal(
      humanReport("install", {
        service: "sidecar", version: "0.1.0", instance: "default", scope: "user", changed: true, listen: "127.0.0.1:7000",
        replaced: [{ path: "config/sidecar.toml", saved_as: "config/sidecar.toml.bak-20260101" }],
      }),
      "Installed service sidecar 0.1.0 as instance default (user)\n  no unit (--service none)\n  listen 127.0.0.1:7000\n"
        + "  replaced config/sidecar.toml (edited since install; your copy is config/sidecar.toml.bak-20260101)",
    );
  });
});
