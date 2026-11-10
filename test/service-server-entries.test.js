// The Dispatch and Keyhole servers' releases: `dispatch-server` and
// `keyhole-server` are verified exactly as the sidecar is, under their own package names, and
// both install (root only) in this version. Plain `dispatch` and `keyhole` are not services:
// the sidecar carries their calls, so installing either is a usage error naming the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { SERVICES, verifyRelease } from "../src/service/artifact.js";
import { PROFILES } from "../src/service/plan.js";
import { parseServiceArgs } from "../src/service/args.js";
import { EXIT } from "../src/errors.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(9);
const PLATFORMS = ["linux-x64-gnu", "linux-x64-musl", "linux-arm64-gnu", "linux-arm64-musl"];

// A signed release in the layout dispatch's and keyhole's release jobs publish:
// <pkg>-<platform>/bin/<binary> for every platform, one checksums.json.
function release(pkg, binary, { version = "0.1.0-dev.1", platforms = PLATFORMS } = {}) {
  const root = tempDir("vbcdx-srv-");
  const files = {};
  for (const p of platforms) {
    const rel = `${pkg}-${p}/bin/${binary}`;
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    const body = Buffer.from(`\x7fELF fake ${binary} ${p} ${version}\n`);
    writeFileSync(join(root, rel), body, { mode: 0o755 });
    files[rel] = sha(body);
  }
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: pkg, version, files }, null, 2));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release ${pkg} ${version}`));
  return root;
}

const SERVERS = [
  ["dispatch-server", "@vbcdx/dispatch", "dispatch"],
  ["keyhole-server", "@vbcdx/keyhole", "keyhole"],
];

test("the server entries name their own package, binary and daemon", () => {
  assert.deepEqual(SERVICES["dispatch-server"], { package: "@vbcdx/dispatch", binaries: ["dispatch"], daemon: "dispatch" });
  assert.deepEqual(SERVICES["keyhole-server"], { package: "@vbcdx/keyhole", binaries: ["keyhole"], daemon: "keyhole" });
  // Plain dispatch and keyhole have no release of their own.
  assert.equal(SERVICES.dispatch, undefined);
  assert.equal(SERVICES.keyhole, undefined);
});

for (const [service, pkg, binary] of SERVERS) {
  test(`${service}: verifyRelease accepts its signed release on every platform`, () => {
    const root = release(pkg, binary);
    for (const platformId of PLATFORMS) {
      const r = verifyRelease({ root, service, platformId, version: "0.1.0-dev.1", trustedKeys: [KEY.pub] });
      assert.equal(r.package, pkg);
      assert.equal(r.signature.trustedComment, `vbcdx-release ${pkg} 0.1.0-dev.1`);
      assert.deepEqual(r.binaries.map((b) => b.name), [binary]);
    }
  });

  test(`${service}: verifyRelease refuses another package's release and a missing platform`, () => {
    const sidecar = release("@vbcdx/sidecar", binary);
    assert.throws(() => verifyRelease({ root: sidecar, service, platformId: "linux-x64-gnu", trustedKeys: [KEY.pub] }),
      (e) => e.code === EXIT.CONFLICT && /not @vbcdx\/(dispatch|keyhole)/.test(e.message));
    // The other server's signed release is refused too: no substitution between the two.
    const [, otherPkg, otherBin] = SERVERS.find(([s]) => s !== service);
    assert.throws(() => verifyRelease({ root: release(otherPkg, otherBin), service, platformId: "linux-x64-gnu", trustedKeys: [KEY.pub] }),
      (e) => e.code === EXIT.CONFLICT && e.message.includes(`not ${pkg}`));
    const x64only = release(pkg, binary, { platforms: ["linux-x64-gnu"] });
    assert.throws(() => verifyRelease({ root: x64only, service, platformId: "linux-arm64-musl", trustedKeys: [KEY.pub] }),
      (e) => e.code === EXIT.CONFLICT);
  });

}

// Both servers install now (dispatch-server: service-dispatch-server.test.js; keyhole-server:
// service-keyhole-server.test.js). The not-installable refusal stays for any service verified
// without a profile; today there is none.
test("every verified service has an install profile", () => {
  for (const service of Object.keys(SERVICES)) assert.ok(PROFILES[service], service);
});

test("`install|remove|doctor|service dispatch|keyhole` is a usage error naming the server", () => {
  for (const name of ["dispatch", "keyhole"]) {
    for (const [argv, what] of [
      [["install", "service", name], "install service"],
      [["install", "service", name, "--instance", "a", "--dry-run"], "install service"],
      [["remove", "service", name], "remove service"],
      [["doctor", "--service", name], "doctor --service"],
      [["service", name, "status"], "service"],
    ]) {
      assert.throws(() => parseServiceArgs(argv), (e) => e.code === EXIT.CONFIG
        && e.message === `${name} is not a service of its own: the sidecar carries its calls with no module. `
          + `The server is ${name}-server (vbcdx ${what} ${name}-server).`, argv.join(" "));
    }
    // The config area stays: its commands run in the installed sidecar's vbcdx-svc.
    const c = parseServiceArgs(["config", "service", name, "messages", "list"]);
    assert.deepEqual([c.command, c.service, c.passthrough], ["config", name, [name, "messages", "list"]]);
  }
});

// The not-installable guards (args, planInstall, layout, buildPlan, validateRecord), on a service
// that is verified but has no install profile. No real one is left, so a test-only load hook
// (test/helpers/unprofiled-register.mjs) adds "bogus-server" to SERVICES in a child process.
test("a verified service with no install profile is refused by every guard, before anything runs", () => {
  const r = spawnSync(process.execPath, ["--import", "./test/helpers/unprofiled-register.mjs", "test/helpers/unprofiled-guards.mjs"],
    { cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.setup, { inServices: true, inProfiles: false }, "the hook added an unprofiled service");
  const refused = (k, code, re) => {
    assert.ok(out[k], k);
    assert.equal(out[k].code, code, `${k}: ${JSON.stringify(out[k])}`);
    assert.match(out[k].message, re, k);
  };
  const NOT = /^bogus-server can't be installed, removed or managed by this version of the installer yet; nothing was fetched or written\.$/;
  for (const k of Object.keys(out).filter((x) => x.startsWith("args: "))) refused(k, EXIT.CONFLICT, NOT);
  assert.equal(Object.keys(out).filter((x) => x.startsWith("args: ")).length, 7);
  refused("planInstall", EXIT.CONFLICT, NOT);
  assert.equal(out.planInstallCalls, 0, "nothing was run: no npm install of the release");
  for (const scope of ["system", "user"]) {
    refused(`layout ${scope}`, EXIT.CONFLICT, NOT);
    refused(`validateRecord ${scope}`, EXIT.FILESYSTEM, /has an unexpected service; refusing to act on it/);
  }
  for (const uid of [0, 1000]) refused(`buildPlan uid ${uid}`, EXIT.CONFLICT, NOT);
});
