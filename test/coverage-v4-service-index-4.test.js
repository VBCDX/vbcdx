// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { humanPlan } from "../src/service/index.js";

function plan(overrides = {}) {
  return {
    platform: "linux-x64",
    scope: "system",
    instance: "default",
    record: "/var/lib/vbcdx/install.json",
    signature: { keyId: "A1B2C3D4E5F60718", trustedComment: "vbcdx-release @vbcdx/sidecar 1.0.0" },
    user: null,
    dirs: [],
    binaries: [],
    files: [],
    symlink: { path: "/usr/local/bin/vbcdx", target: "/opt/vbcdx/bin/vbcdx" },
    listen: "unix:/run/vbcdx/service.sock",
    ...overrides,
  };
}

describe("src/service/index.js coverage, part 4", () => {
  test("an existing record's file without a diff is reported as new and contributes no diff lines", () => {
    // src/service/index.js 396, 397
    const out = humanPlan(plan({
      service: "sidecar",
      version: "1.0.0",
      changes: {
        dirs: [],
        binaries: [],
        symlink: false,
        files: [
          { path: "/etc/vbcdx/sidecar.toml" },
          { path: "/etc/vbcdx/sidecar.env", diff: ["-MODE=old", "+MODE=new"] },
          { path: "/etc/vbcdx/empty.conf", diff: [] },
        ],
      },
    }));
    const lines = out.split("\n");
    assert.ok(lines.includes("  file /etc/vbcdx/sidecar.toml (new)"));
    assert.ok(!lines.includes("  change /etc/vbcdx/sidecar.toml:"));
    const withDiff = lines.indexOf("  change /etc/vbcdx/sidecar.env:");
    assert.ok(withDiff >= 0);
    assert.deepEqual(lines.slice(withDiff + 1, withDiff + 3), ["      -MODE=old", "      +MODE=new"]);
    const emptyDiff = lines.indexOf("  change /etc/vbcdx/empty.conf:");
    assert.ok(emptyDiff >= 0);
    assert.ok(!lines[emptyDiff + 1].startsWith("      "));
    assert.ok(!out.includes("  no file changes"));
  });

  test("a plan with no unit prints the --service none hint with the plan's own run command", () => {
    // src/service/index.js 415
    const run = "/opt/vbcdx/bin/vbcdx-sidecar --foreground";
    const out = humanPlan(plan({ run }));
    const lines = out.split("\n");
    assert.ok(lines.includes(`  no unit (--service none); run it with: ${run}`));
    assert.ok(!lines.some((l) => l.startsWith("  unit (") || l.startsWith("  restart ")));
  });

  test("files kept because they were edited since install are listed with the reason", () => {
    // src/service/index.js 416
    const out = humanPlan(plan({ kept: ["/etc/vbcdx/sidecar.toml", "/etc/vbcdx/agent.json"] }));
    const lines = out.split("\n");
    const first = lines.indexOf("  keep /etc/vbcdx/sidecar.toml (edited since install; this install would not change it)");
    assert.ok(first >= 0);
    assert.equal(lines[first + 1], "  keep /etc/vbcdx/agent.json (edited since install; this install would not change it)");
    assert.ok(!out.includes("(from the installed"));
  });

  test("a held lock with a pid but no command names the process only", () => {
    // src/service/index.js 428
    const out = humanPlan(plan({ lock: { state: "held", pid: 4242, command: "", ageMs: 5000 } }));
    const expected = "  LOCK /var/lib/vbcdx/install.json.lock is held by process 4242, for 5 s: install would refuse (exit 4) until it finishes";
    assert.ok(out.split("\n").includes(expected), out);
  });

  test("a held lock without a pid says another process and drops the unattributable command", () => {
    // src/service/index.js 428
    const out = humanPlan(plan({ lock: { state: "held", pid: 0, command: "vbcdx-install-concurrent", ageMs: 2500 } }));
    const expected = "  LOCK /var/lib/vbcdx/install.json.lock is held by another process, for 3 s: install would refuse (exit 4) until it finishes";
    assert.ok(out.split("\n").includes(expected), out);
    assert.ok(!out.includes("vbcdx-install-concurrent"));
    assert.ok(!out.includes("process 0"));
  });
});
