// Run under unprofiled-register.mjs: every not-installable guard, given "bogus-server" (in SERVICES,
// not in PROFILES). Prints one JSON object: each guard's outcome {code, message} (or {ok: true}).
import { SERVICES } from "../../src/service/artifact.js";
import { PROFILES, buildPlan, layout } from "../../src/service/plan.js";
import { parseServiceArgs } from "../../src/service/args.js";
import { planInstall } from "../../src/service/index.js";
import { validateRecord } from "../../src/service/apply.js";
import { fakeSystem } from "../../src/service/system.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const service = "bogus-server";
const out = { setup: { inServices: Boolean(SERVICES[service]), inProfiles: Boolean(PROFILES[service]) } };
const outcome = (f) => {
  try {
    f();
    return { ok: true };
  } catch (e) {
    return { code: e.code, message: e.message };
  }
};
for (const argv of [["install", "service", service, "--dry-run"], ["install", "service", service, "--from", "/nonexistent"],
  ["remove", "service", service], ["remove", "service", service, "--wipe"], ["doctor", "--service", service],
  ["service", service, "status"], ["config", "service", service, "status"]]) {
  out[`args: ${argv.join(" ")}`] = outcome(() => parseServiceArgs(argv));
}
const sys = fakeSystem(mkdtempSync(join(tmpdir(), "vbcdx-unprof-")));
out.planInstall = outcome(() => planInstall({ command: "install", service, instance: "default", version: null, from: null,
  serviceManager: "systemd", listen: null, start: true, dryRun: true }, { sys, host: { uid: 0, home: "/root", runtimeDir: null },
  trustedKeys: [], platformId: "linux-x64-gnu" }));
out.planInstallCalls = sys.calls.length;
for (const scope of ["system", "user"]) {
  out[`layout ${scope}`] = outcome(() => layout({ service, instance: "default", version: "0.1.0", scope, home: "/root", runtimeDir: "/run/user/0" }));
  const fields = ["binaries", "config_dir", "dirs", "files", "instance", "listen", "modules", "package", "platform", "previous",
    "scope", "service", "signer", "state_dir", "symlink", "unit", "version"];
  const rec = Object.fromEntries(fields.map((f) => [f, null]));
  Object.assign(rec, { service, scope, instance: "default", package: "@vbcdx/bogus", version: "0.1.0", platform: "linux-x64-gnu",
    signer: "0123456789ABCDEF" });
  out[`validateRecord ${scope}`] = outcome(() => validateRecord(`${service}:default`, rec, { scope, home: scope === "system" ? "/root" : "/home/u" }));
}
const release = { version: "0.1.0", package: "@vbcdx/bogus", platform: "linux-x64-gnu", signature: {}, binaries: [] };
for (const host of [{ uid: 0, home: "/root", runtimeDir: null }, { uid: 1000, home: "/home/u", runtimeDir: "/run/user/1000" }]) {
  out[`buildPlan uid ${host.uid}`] = outcome(() => buildPlan({ service, instance: "default", release, serviceManager: "systemd",
    listen: null, start: true, host }));
}
process.stdout.write(JSON.stringify(out));
