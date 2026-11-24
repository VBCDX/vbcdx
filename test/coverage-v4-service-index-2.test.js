// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import "./helpers/fixture-pack.js";
import { humanReport } from "../src/service/index.js";

describe("src/service/index.js coverage, part 2", () => {
  // src/service/index.js 313:37-313:122
  test("install report names an old modules.toml that it removed", () => {
    const out = humanReport("install", {
      changed: true,
      service: "sidecar",
      version: "1.2.3",
      instance: "default",
      scope: "system",
      unit: "/etc/systemd/system/vbcdx-sidecar.service",
      started: true,
      listen: "/run/vbcdx/sidecar.sock",
      legacy_removed: "/etc/vbcdx/modules.toml",
    });
    assert.deepEqual(out.split("\n"), [
      "Installed service sidecar 1.2.3 as instance default (system)",
      "  unit /etc/systemd/system/vbcdx-sidecar.service (started)",
      "  listen /run/vbcdx/sidecar.sock",
      "  removed /etc/vbcdx/modules.toml (an old modules.toml; the sidecar has no modules)",
    ]);
  });

  // src/service/index.js 314:30-315:96
  test("install report keeps an old modules.toml it could not remove and gives the reason", () => {
    const out = humanReport("install", {
      changed: true,
      service: "sidecar",
      version: "1.2.3",
      instance: "default",
      scope: "system",
      unit: null,
      listen: "/run/vbcdx/sidecar.sock",
      legacy_not_removed: { path: "/etc/vbcdx/modules.toml", reason: "permission denied" },
    });
    assert.deepEqual(out.split("\n"), [
      "Installed service sidecar 1.2.3 as instance default (system)",
      "  no unit (--service none)",
      "  listen /run/vbcdx/sidecar.sock",
      "  could not remove /etc/vbcdx/modules.toml (permission denied): an old modules.toml the sidecar ignores; it stays recorded, so the next upgrade or remove takes it out",
    ]);
  });

  // src/service/index.js 317:34-317:72
  test("install report says which version an upgrade came from, winning over a downgrade field", () => {
    const out = humanReport("install", {
      changed: true,
      service: "sidecar",
      version: "1.2.3",
      instance: "default",
      scope: "system",
      unit: null,
      listen: "/run/vbcdx/sidecar.sock",
      upgraded_from: "1.0.0",
      downgraded_from: "2.0.0",
    });
    assert.equal(
      out.split("\n")[0],
      "Installed service sidecar 1.2.3 as instance default (system), upgraded from 1.0.0",
    );
    assert.ok(!out.includes("downgraded"));
  });

  // src/service/index.js 317:93-317:155
  test("install report says a downgrade came from which version and that it was allowed", () => {
    const out = humanReport("install", {
      changed: true,
      service: "sidecar",
      version: "1.0.0",
      instance: "default",
      scope: "system",
      unit: null,
      listen: "/run/vbcdx/sidecar.sock",
      downgraded_from: "2.0.0",
    });
    assert.equal(
      out.split("\n")[0],
      "Installed service sidecar 1.0.0 as instance default (system), downgraded from 2.0.0 (--allow-downgrade)",
    );
  });

  // src/service/index.js 319:90-319:120
  test("install report shows the unit and its state, or says there is no unit", () => {
    const base = {
      changed: true,
      service: "sidecar",
      version: "1.2.3",
      instance: "default",
      scope: "system",
      listen: "/run/vbcdx/sidecar.sock",
    };
    const none = humanReport("install", { ...base, unit: null, started: false });
    assert.equal(none.split("\n")[1], "  no unit (--service none)");
    const enabled = humanReport("install", {
      ...base,
      unit: "/etc/systemd/system/vbcdx-sidecar.service",
      started: false,
    });
    assert.equal(
      enabled.split("\n")[1],
      "  unit /etc/systemd/system/vbcdx-sidecar.service (enabled, not started)",
    );
  });

  // src/service/index.js 320:46-320:102
  test("install report names the control-plane enrolment only when there is one", () => {
    const base = {
      changed: true,
      service: "sidecar",
      version: "1.2.3",
      instance: "default",
      scope: "system",
      unit: null,
      listen: "/run/vbcdx/sidecar.sock",
    };
    const enrolled = humanReport("install", { ...base, enrolled: "tenant-a" });
    assert.ok(enrolled.split("\n").includes("  enrolled with the control plane as tenant-a"));
    const not = humanReport("install", base);
    assert.ok(!not.includes("enrolled"));
  });

  test("install report orders kept, replaced, legacy and next lines after the install facts", () => {
    const out = humanReport("install", {
      changed: true,
      service: "sidecar",
      version: "1.2.3",
      instance: "default",
      scope: "system",
      unit: "/etc/systemd/system/vbcdx-sidecar.service",
      started: true,
      listen: "/run/vbcdx/sidecar.sock",
      enrolled: "tenant-a",
      kept: ["/etc/vbcdx/config.toml"],
      replaced: [{ path: "/etc/vbcdx/agent.toml", saved_as: "/etc/vbcdx/agent.toml.bak-1" }],
      legacy_removed: "/etc/vbcdx/modules.toml",
      link: { next: "fetch the link certificate from the control plane" },
    });
    assert.deepEqual(out.split("\n"), [
      "Installed service sidecar 1.2.3 as instance default (system)",
      "  unit /etc/systemd/system/vbcdx-sidecar.service (started)",
      "  listen /run/vbcdx/sidecar.sock",
      "  enrolled with the control plane as tenant-a",
      "  kept /etc/vbcdx/config.toml (edited since install; left as it is)",
      "  replaced /etc/vbcdx/agent.toml (edited since install; your copy is /etc/vbcdx/agent.toml.bak-1)",
      "  removed /etc/vbcdx/modules.toml (an old modules.toml; the sidecar has no modules)",
      "  next: fetch the link certificate from the control plane",
    ]);
  });

  test("unchanged install report lists kept files and the next step but no legacy removal", () => {
    const out = humanReport("install", {
      changed: false,
      service: "sidecar",
      version: "1.2.3",
      instance: "default",
      kept: ["/etc/vbcdx/config.toml"],
      legacy_removed: "/etc/vbcdx/modules.toml",
      legacy_not_removed: { path: "/etc/vbcdx/other.toml", reason: "permission denied" },
      link: { next: "fetch the link certificate from the control plane" },
    });
    assert.deepEqual(out.split("\n"), [
      "install service sidecar 1.2.3 (default): already in place, nothing changed",
      "  kept /etc/vbcdx/config.toml (edited since install; left as it is)",
      "  next: fetch the link certificate from the control plane",
    ]);
  });

  // src/service/index.js 324:29-324:79
  test("remove report lists each kept file (edited since install) after the actions", () => {
    const out = humanReport("remove", {
      dryRun: false,
      actions: ["stopped vbcdx-sidecar.service", "removed /usr/local/bin/vbcdx-sidecar"],
      kept: ["/etc/vbcdx/config.toml", "/etc/vbcdx/agent.toml"],
      state_kept: null,
    });
    assert.deepEqual(out.split("\n"), [
      "Applied remove:",
      "  stopped vbcdx-sidecar.service",
      "  removed /usr/local/bin/vbcdx-sidecar",
      "  kept (edited since install): /etc/vbcdx/config.toml",
      "  kept (edited since install): /etc/vbcdx/agent.toml",
    ]);
    assert.equal(
      humanReport("remove", { dryRun: true, actions: [], kept: ["/etc/vbcdx/config.toml"], state_kept: null }),
      "Planned remove:\n  kept (edited since install): /etc/vbcdx/config.toml",
    );
    assert.equal(
      humanReport("remove", { dryRun: false, actions: ["stopped vbcdx-sidecar.service"], kept: [], state_kept: null }),
      "Applied remove:\n  stopped vbcdx-sidecar.service",
    );
  });

  // src/service/index.js 331:24-334:4
  test("list report says so when nothing is installed", () => {
    assert.equal(humanReport("list", { services: [] }), "no services installed");
  });

  // src/service/index.js 331:24-334:4
  test("list report prints one row per service with two spaces between fields", () => {
    const out = humanReport("list", {
      services: [
        { service: "sidecar", instance: "default", version: "1.2.3", scope: "system", state: "active", listen: "/run/vbcdx/sidecar.sock" },
        { service: "control", instance: "cp", version: "0.9.0", scope: "user", state: "inactive", listen: "/run/vbcdx/control.sock" },
      ],
    });
    assert.deepEqual(out.split("\n"), [
      "sidecar  default  1.2.3  system  active  /run/vbcdx/sidecar.sock",
      "control  cp  0.9.0  user  inactive  /run/vbcdx/control.sock",
    ]);
  });

  test("warnings are prefixed and come before the report body", () => {
    const out = humanReport("list", { services: [], warnings: ["record for instance cp is unreadable"] });
    assert.equal(out, "warning: record for instance cp is unreadable\nno services installed");
  });
});
