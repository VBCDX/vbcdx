// Applying a service plan, and the commands that read what was applied: remove, list,
// doctor, service <action> and config (exec of vbcdx-svc).
//
// The plan (plan.js) is the whole contract: apply writes exactly what --dry-run printed.
// Every install is recorded in the installation manifest under `services`, with each
// file's SHA-256, so a re-run is a no-op (changed:false) and remove takes out exactly what
// was written, keeping (and naming) anything edited since. All host access goes through
// `sys` (system.js).

import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync,
  rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { packageVersion } from "../index.js";
import { acquireLocks, assertNoSymlinkComponents, atomicWrite, sha256 } from "../fs/safe-writer.js";
import { readManifest, writeManifest } from "../fs/manifest.js";
import { EXIT, InstallerError, conflictError, configError, filesystemError, subprocessError } from "../errors.js";
import { SEMVER, SERVICES } from "./artifact.js";
import { SECRET_PREFIXES } from "./scan.js";
import { CONTROL_CA, INSTANCE_RE, PROFILES, layout, parseListen, recordFile } from "./plan.js";
import { compareVersions } from "./areas.js";

const key = (service, instance) => `${service}:${instance}`;
const mode = (m) => parseInt(m, 8);
const HEX64 = /^[0-9a-f]{64}$/;
const hashOf = (p) => {
  try {
    return sha256(readFileSync(p));
  } catch {
    return null;
  }
};
const linkOf = (p) => {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
};

function must(sys, cmd, args, what) {
  const r = sys.run(cmd, args);
  if (r.status !== 0) throw subprocessError(`${what} failed (${cmd} exited ${r.status}).`, { lines: [`${what} failed (${cmd} exited ${r.status}).`, ...(r.stderr ? [r.stderr.trim().split("\n").pop()] : [])] });
  return r;
}
// The installed daemon's own parser on the config install just wrote (`vbcdx-sidecar check` or
// `vbcdx-control check` resolves it exactly as the daemon would, binding nothing), as the user
// the unit runs as: a config the daemon would refuse never reaches a unit. Its message is the daemon's.
// Returns the daemon's summary (its JSON stdout), or null when it printed none.
function checkConfig(sys, plan) {
  const [bin, ...args] = plan.check;
  const [cmd, argv] = plan.scope === "system" ? ["runuser", ["-u", plan.user.name, "--", sys.path(bin), ...args]] : [sys.path(bin), args];
  const r = sys.run(cmd, argv);
  if (r.status === 0) {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  }
  const said = r.stderr ? r.stderr.trim().split("\n").pop() : "";
  const line = `The ${plan.service} refuses the config install wrote (${SERVICES[plan.service].daemon} check exited ${r.status}); nothing was started.`;
  throw subprocessError(line, { lines: [line, ...(said ? [said] : [])] });
}
// A shell step run as the service user, with paths as arguments (never in the script). The state
// directory is the service user's, so anything in it may be a link that user planted: root never
// writes, reads, chowns or restores a file there. The user does, with only the user's own rights.
function asServiceUser(sys, plan, script, args, what, input) {
  const r = sys.run("runuser", ["-u", plan.user.name, "--", "/bin/sh", "-c", script, "sh", ...args], input === undefined ? {} : { input });
  if (r.status !== 0) {
    const line = `${what} failed (as ${plan.user.name}, exit ${r.status}).`;
    throw subprocessError(line, { lines: [line, ...(r.stderr ? [safeLine(r.stderr.trim().split("\n").pop())] : [])] });
  }
}
// The previous certificate is kept as <cert>.vbcdx-prev until the install is through, then dropped;
// an undo puts it back (or removes the new one when there was none).
const CERT_SAVE = 'rm -f -- "$1.vbcdx-prev" && { [ ! -e "$1" ] || cp -- "$1" "$1.vbcdx-prev"; }';
const CERT_WRITE = 'umask 077 && rm -f -- "$1.vbcdx-new" && cat > "$1.vbcdx-new" && mv -f -- "$1.vbcdx-new" "$1"';
const CERT_UNDO = 'if [ -e "$1.vbcdx-prev" ]; then mv -f -- "$1.vbcdx-prev" "$1"; else rm -f -- "$1"; fi';
const CERT_DONE = 'rm -f -- "$1.vbcdx-prev"';

// dispatch-server's and keyhole-server's link credential. On the first install the key and CSR are
// made by the installed `dispatch link csr` / `keyhole service csr`, run as the service user, so the
// key is born in the state directory and never leaves it. keyhole-server's KEK is made the same way,
// once (`keyhole kek generate`): an existing one is never replaced, since it seals every stored value. A certificate given with --service-cert (vbcdx-control services add dispatch --cert-out)
// is written beside it as the service user (0600, see asServiceUser); `dispatch check` then decides
// whether it fits. Undo steps go on `undo`; `done` gets the step that drops the saved previous
// certificate once the install is through. Returns whether a certificate is now in place.
/**
 * Why a keyhole-server install would refuse to make its KEK, or null. Only a fresh state gets a
 * KEK. On an instance that has run (its database or its link key exists), a missing KEK means every
 * stored value is sealed under a key that is gone: a new one would let Keyhole start with values it
 * can never open, so the install stops instead. Install (serverLink) and the dry run (index.js
 * linkSteps) both ask this, so the plan never promises a KEK install would refuse to make.
 */
export function kekRefusal(sys, plan) {
  if (!plan.kek || existsSync(sys.path(plan.kek.path))) return null;
  const ran = [plan.kek.db, plan.link.key].find((p) => existsSync(sys.path(p)));
  if (!ran) return null;
  return `${plan.kek.path} is missing, but this instance has already run (${ran} exists): Keyhole's stored values are `
    + "sealed under the KEK that was there, and a new one can't open them. Nothing was changed. Restore the KEK from a backup, "
    + `or start this instance over with vbcdx remove service ${plan.service} --wipe, then install.`;
}

function serverLink(sys, plan, cert, undo, done = []) {
  const L = plan.link;
  const daemon = SERVICES[plan.service].daemon;
  const refusal = kekRefusal(sys, plan);
  if (refusal) throw conflictError(refusal);
  if (plan.kek && !existsSync(sys.path(plan.kek.path))) {
    const [bin, ...args] = plan.kek.argv;
    undo.push(() => rmSync(sys.path(plan.kek.path), { force: true }));
    must(sys, "runuser", ["-u", plan.user.name, "--", sys.path(bin), ...args], "making the key-encryption key (keyhole kek generate)");
  }
  if (!existsSync(sys.path(L.key))) {
    const [bin, ...args] = plan.csr;
    undo.push(() => {
      rmSync(sys.path(L.key), { force: true });
      rmSync(sys.path(L.csr), { force: true });
    });
    // The CSR's old copy (from a key since removed by hand) would make link csr refuse.
    rmSync(sys.path(L.csr), { force: true });
    must(sys, "runuser", ["-u", plan.user.name, "--", sys.path(bin), ...args],
      `making the link key and CSR (${daemon} ${plan.service === "keyhole-server" ? "service" : "link"} csr)`);
  }
  if (cert) {
    const at = sys.path(L.cert);
    asServiceUser(sys, plan, CERT_SAVE, [at], "keeping the previous link certificate");
    undo.push(() => asServiceUser(sys, plan, CERT_UNDO, [at], "putting the previous link certificate back"));
    asServiceUser(sys, plan, CERT_WRITE, [at], "writing the link certificate", cert.toString("latin1"));
    done.push(() => asServiceUser(sys, plan, CERT_DONE, [at], "dropping the previous link certificate"));
  }
  return existsSync(sys.path(L.cert));
}

// What install reports about the link: the files, and the next step while the certificate is missing.
function linkReport(plan, hasCert) {
  const L = plan.link;
  return { key: L.key, csr: L.csr, cert: hasCert ? L.cert : null, link_listen: L.listen, control_url: L.control_url,
    ...(L.control_ca ? { control_ca: L.control_ca } : {}),
    next: hasCert ? null : `On the control host: ${L.services_add}; then rerun this install with --service-cert ${SERVICES[plan.service].daemon}.crt.` };
}

// Redeem a one-time enrollment token for the tunnel credentials (`vbcdx-sidecar enroll
// --token-stdin`), as the unit's user, after check and before the unit starts. The token goes on
// the daemon's stdin only: never argv, the plan, the record or a message.
function enrollSidecar(sys, plan, token) {
  if (!plan.enroll) throw conflictError("An enrollment token was given but this install has no control plane to enroll with.");
  const [bin, ...args] = plan.enroll.argv;
  const [cmd, argv] = plan.scope === "system" ? ["runuser", ["-u", plan.user.name, "--", sys.path(bin), ...args]] : [sys.path(bin), args];
  const r = sys.run(cmd, argv, { input: Buffer.concat([token, Buffer.from("\n")]) });
  if (r.status !== 0) {
    const said = r.stderr ? r.stderr.trim().split("\n").pop() : "";
    const line = `vbcdx-sidecar enroll exited ${r.status}; nothing was started.${r.status === 5
      ? " An enrolled sidecar is refused: re-enroll it by hand with vbcdx-sidecar enroll --force." : ""}`;
    throw subprocessError(line, { lines: [line, ...(said ? [said] : [])] });
  }
  // `vbcdx-sidecar enroll` prints {"changed": true, "data": {"sidecar_id", "replaced", "state"}}
  // (vbcdx-core crates/vbcdx-sidecar/src/main.rs, Cmd::Enroll; daemon.rs `enroll`).
  try {
    return JSON.parse(r.stdout).data.sidecar_id || "(no id reported)";
  } catch {
    return "(no id reported)";
  }
}

// `run` refuses to start a sidecar whose control_plane is set but which is not enrolled
// (daemon.rs not_enrolled), so its unit would only crash-loop. The daemon's own check reports
// it (`control_plane.enrolled` in its summary): without a token, a unit that would start is
// refused here, before it is written.
function requireEnrolled(plan, checked, token) {
  if (!plan.control_plane || token || !plan.start) return;
  if (checked && checked.control_plane && checked.control_plane.enrolled === true) return;
  throw configError("This sidecar is not enrolled with its control plane, so its unit would not start; nothing was started. "
    + "Pass --enroll-token-file or --enroll-token-stdin (a one-time token from vbcdx-control sidecars enroll-token), "
    + "or --no-start to enroll it by hand later.");
}

// A step after a successful enroll failed: the new tunnel credentials go (a retry would
// otherwise stop on "already enrolled"), and the error says the token is spent and which id to
// revoke on the control host.
// A failure to remove them never replaces the error that stopped the install: the message says
// so instead, and names the directory to remove by hand. `removed`: the caller's own attempt
// (true/false), or undefined to try here. `userKept`: the user this run created was kept
// because the credentials stayed (see applyInstall), so both are named for the by-hand cleanup.
function removeTunnel(sys, plan) {
  try {
    rmSync(sys.path(join(plan.state_dir, "tunnel")), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
function afterEnrollFailure(sys, plan, id, e, { removed = removeTunnel(sys, plan), userKept = false } = {}) {
  const tunnel = join(plan.state_dir, "tunnel");
  const extra = `The sidecar had enrolled as ${id} with a token that is now spent; `
    + (removed ? "its tunnel credentials were removed. " : `removing its tunnel credentials failed: remove ${tunnel} by hand. `)
    + (userKept ? `The ${plan.user.name} user this install created was kept, so they stay owned by it: after removing them, run userdel ${plan.user.name}. ` : "")
    + `Revoke it on the control host (vbcdx-control sidecars revoke ${id} --yes) and use a new token.`;
  const lines = (e.details && e.details.lines) || [e.message];
  return new InstallerError(e.code === undefined ? EXIT.SUBPROCESS : e.code, `${e.message} ${extra}`, { ...(e.details || {}), lines: [...lines, extra] });
}
const systemctl = (scope) => (scope === "user" ? ["systemctl", ["--user"]] : ["systemctl", []]);
function ctl(sys, scope, args, what) {
  const [cmd, pre] = systemctl(scope);
  return must(sys, cmd, [...pre, ...args], what);
}

// After install starts (or restarts) a unit, it waits until the daemon stays up: `active` with
// no automatic restart for SETTLE_MS. That stands in for "the daemon has bound its listener": the
// daemon exits when it can't bind, so a daemon still running after SETTLE_MS has bound; no
// socket or port is probed. A daemon that can't start (its listen address in use, say)
// exits, and Restart=on-failure holds the unit in `activating` for RestartSec=2s before the next
// try, which the 500 ms poll always sees, so a restart loop never passes as started. Past
// START_DEADLINE_MS, or once the unit is failed or inactive, install fails (exit 6) with the
// daemon's own last line, and the caller's undo runs.
export const START_DEADLINE_MS = 15_000;
export const SETTLE_MS = 3_000;
const POLL_MS = 500;

function unitState(sys, scope, name) {
  const [cmd, pre] = systemctl(scope);
  const state = (sys.run(cmd, [...pre, "is-active", name]).stdout || "").trim() || "unknown";
  const restarts = (sys.run(cmd, [...pre, "show", name, "-p", "NRestarts", "--value"]).stdout || "").trim();
  return { state, restarts };
}

/**
 * The daemon's last line in the unit's journal since `sinceMs` (its own message, e.g.
 * "vbcdx-sidecar: tcp 127.0.0.1:7777: address in use", rather than systemd's lines about it), or null.
 */
export function lastDaemonLine(sys, scope, unit, daemon, sinceMs = null) {
  const args = [...(scope === "user" ? ["--user"] : []), "-u", unit, "-o", "cat", "--no-pager", "-n", "50",
    ...(sinceMs === null ? [] : ["--since", `@${Math.floor(sinceMs / 1000)}`])];
  const r = sys.run("journalctl", args);
  if (r.status !== 0) return null;
  const lines = (r.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => l.startsWith(`${daemon}:`));
  return line ? safeLine(line) : null;
}

export const LINE_MAX = 300;
// A daemon's line goes into an error and doctor's output, so it is made safe where it is read:
// terminal escape sequences, C0/C1 controls and bidi overrides out; anything shaped like a
// secret redacted (a key=value secret, a Bearer token, a postgres:// password, a token with a
// known prefix, a long base64/hex run); then capped at LINE_MAX characters.
// Terminal escape sequences (CSI, OSC), C0/C1 controls and bidi overrides out.
export function stripControls(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function safeLine(text) {
  let t = stripControls(text);
  // The whole name, prefix included: `_` is a word character, so a \b before the keyword would
  // miss api_key=, access_token=, DB_PASSWORD= and the like.
  t = t.replace(/(?<![A-Za-z0-9])([A-Za-z0-9_-]*(?:token|key|secret|password|passwd|pw|auth|credential)s?)=\S+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^\s/@:]*:)[^\s/@]*@/gi, "$1[redacted]@")
    .replace(/\S+/g, (w) => (SECRET_PREFIXES.some((p) => w.includes(p)) ? "[redacted]" : w))
    // No "/" in the run: a long path (/var/lib/vbcdx/…) is not a secret.
    .replace(/[A-Za-z0-9+_=-]{32,}/g, "[redacted]");
  return t.length > LINE_MAX ? `${t.slice(0, LINE_MAX - 1)}…` : t;
}

/**
 * A TCP --listen that something already listens on, as "<addr> (in use)", or null. Checked before
 * anything is written, when the unit would be started: `ss` lists the host's TCP listeners. The
 * instance's own recorded listen is its own daemon's, so a reinstall with the same one is never
 * refused. Without `ss` (or when it fails) this says nothing; the post-start wait still catches it.
 */
export function listenInUse(sys, plan, rec) {
  if (!plan.start || !plan.unit) return null;
  // dispatch-server binds two TCP addresses: the web --listen and the link listener. A reinstall
  // with the same settings file has the same link listener, held by its own daemon: not checked.
  const want = [];
  if (typeof plan.listen === "string" && !(rec && rec.listen === plan.listen)) want.push(["--listen", plan.listen]);
  if (plan.link && !(rec && rec.files[0] && rec.files[0].sha256 === plan.files[0].sha256)) want.push(["--link-listen", plan.link.listen]);
  // A unix listen ("unix:/…") never matches host:port below, so it is never checked.
  const wanted = want.map(([flag, v]) => [flag, v, /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d+)$/.exec(v)]).filter(([, , m]) => m);
  if (!wanted.length) return null;
  const r = sys.run("ss", ["-H", "-l", "-t", "-n"]);
  if (r.status !== 0) return null;
  const wildcard = new Set(["0.0.0.0", "[::]", "*"]);
  for (const [flag, value, [, host, port]] of wanted) {
    // A wildcard bind clashes with a listener on any address of that port.
    const same = (a) => a === host || wildcard.has(a) || wildcard.has(host) || (host === "localhost" && (a === "127.0.0.1" || a === "[::1]"));
    for (const line of (r.stdout || "").split("\n")) {
      const local = line.trim().split(/\s+/)[3];
      if (!local) continue;
      const i = local.lastIndexOf(":");
      const addr = local.slice(0, i).replace(/%[^\]]*$/, "");
      if (local.slice(i + 1) === port && same(addr)) return `${flag} ${value} (in use: something already listens on ${local})`;
    }
  }
  return null;
}

/**
 * After a failed upgrade or reinstall, start the instance's previous version again. reset-failed
 * first: a unit the failed start pushed over its start limit refuses a plain restart. Returns a
 * line saying what didn't work, or null; the install's own error stays the one reported.
 */
function restorePrevious(sys, plan, rec) {
  const [cmd, pre] = systemctl(plan.scope);
  const name = plan.unit.name;
  const reset = sys.run(cmd, [...pre, "reset-failed", name]);
  const r = sys.run(cmd, [...pre, "restart", name]);
  if (r.status === 0) return null;
  return `Starting ${rec.version} again failed too (systemctl restart exited ${r.status}`
    + `${reset.status === 0 ? "" : `; reset-failed exited ${reset.status}`}): check systemctl ${plan.scope === "user" ? "--user " : ""}status ${name}.`;
}

/**
 * A version older than the one this instance runs: {from, to}, else null. SemVer precedence
 * (compareVersions), per instance: another instance's version doesn't count.
 */
export function downgradeOf(plan, rec) {
  return rec && compareVersions(plan.version, rec.version) < 0 ? { from: rec.version, to: plan.version } : null;
}

// Refused unless asked for: an older daemon may not read the state a newer one wrote, and an
// older signed release may carry a flaw a later one fixed. Exit 5, before anything is written.
export function refuseDowngrade(plan, down) {
  return conflictError(`Downgrade refused: ${plan.service} instance "${plan.instance}" runs ${down.from}, and ${down.to} is older. `
    + "Nothing was changed. An older release may not read the state a newer one wrote, so install it only when its "
    + "release notes say it can: rerun with --allow-downgrade.", { refused: "downgrade", installed: down.from, requested: down.to });
}

// Add a line to an installer error (message and its line layout) without replacing it.
function withNote(e, note) {
  if (!note || !(e instanceof InstallerError)) return;
  e.message = `${e.message} ${note}`;
  if (e.details && Array.isArray(e.details.lines)) e.details.lines.push(note);
}

/** Wait until the unit's daemon stays up; throw exit 6, naming what the daemon said, if it doesn't. */
export function waitStarted(sys, plan) {
  const name = plan.unit.name;
  const daemon = SERVICES[plan.service].daemon;
  const t0 = sys.now();
  const first = unitState(sys, plan.scope, name);
  let upSince = first.state === "active" ? t0 : null;
  let last = first;
  for (;;) {
    if (["failed", "inactive"].includes(last.state) || last.restarts !== first.restarts) break;
    if (upSince !== null && sys.now() - upSince >= SETTLE_MS) return;
    if (sys.now() - t0 >= START_DEADLINE_MS) break;
    sys.sleep(POLL_MS);
    last = unitState(sys, plan.scope, name);
    if (last.state !== "active") upSince = null;
    else if (upSince === null) upSince = sys.now();
  }
  const said = lastDaemonLine(sys, plan.scope, name, daemon, t0);
  const journal = `journalctl ${plan.scope === "user" ? "--user " : ""}-u ${name}`;
  const why = last.restarts !== first.restarts ? "it exited and systemd is restarting it"
    : last.state === "active" ? `it did not stay up for ${SETTLE_MS / 1000} s` : `it is ${last.state}`;
  const head = `${name} did not start (${why}); the install was undone.`;
  throw subprocessError(`${head} ${said ? `Its last line: ${said}` : `See ${journal}.`}`, { lines: [head, said || `See ${journal}.`] });
}

const RECORD_FIELDS = ["binaries", "config_dir", "dirs", "files", "instance", "listen", "modules", "package", "platform", "previous",
  "scope", "service", "signer", "state_dir", "symlink", "unit", "version"];
const fieldsAre = (o, fields) => Boolean(o) && typeof o === "object" && !Array.isArray(o)
  && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...fields].sort());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Check one record against what install derives for its service, instance, version and scope.
 * remove deletes, and service/config run, only what a record names, so a record that names
 * anything else (an edited or planted entry) is refused before any of them acts.
 */
export function validateRecord(k, rec, { scope, home }) {
  const bad = (field) => filesystemError(`The install record ${k} has an unexpected ${field}; refusing to act on it. Fix or delete that entry by hand.`);
  if (!fieldsAre(rec, RECORD_FIELDS)) throw bad("set of fields");
  const svc = SERVICES[rec.service];
  // A verify-only service (no install profile) is never installed, so no record can name it.
  if (!svc || !PROFILES[rec.service]) throw bad("service");
  if (scope === "user" && !PROFILES[rec.service].userScope) throw bad("scope");
  if (typeof rec.instance !== "string" || !INSTANCE_RE.test(rec.instance) || k !== key(rec.service, rec.instance)) throw bad("instance");
  if (rec.scope !== scope) throw bad("scope");
  if (rec.package !== svc.package) throw bad("package");
  if (typeof rec.version !== "string" || !SEMVER.test(rec.version)) throw bad("version");
  if (rec.previous !== null && (typeof rec.previous !== "string" || !SEMVER.test(rec.previous))) throw bad("previous");
  if (typeof rec.platform !== "string" || !/^[a-z0-9-]+$/.test(rec.platform)) throw bad("platform");
  if (typeof rec.signer !== "string" || !/^[0-9A-F]{16}$/.test(rec.signer)) throw bad("signer");
  const L = layout({ service: rec.service, instance: rec.instance, version: rec.version, scope, home });
  const binaries = Array.isArray(rec.binaries) && rec.binaries.length === svc.binaries.length
    && rec.binaries.every((b, i) => fieldsAre(b, ["name", "path", "sha256"]) && b.name === svc.binaries[i]
      && b.path === join(L.versionDir, b.name) && HEX64.test(b.sha256));
  if (!binaries) throw bad("binaries");
  if (!same(rec.symlink, { path: L.current, target: rec.version })) throw bad("symlink");
  if (!same(rec.dirs, L.dirs.map((d) => ({ path: d.path, mode: d.mode, owner: d.owner, group: d.group })))) throw bad("dirs");
  // The config, and for a system sidecar its public record after it (a record from installer
  // 0.2.3 or older has the config only).
  // keyhole-server: the config and the control CA, always both.
  const wantPaths = [L.config, ...(rec.service === "sidecar" && scope === "system" ? [L.publicRecord] : []),
    ...(rec.service === "keyhole-server" ? [join(L.confDir, CONTROL_CA)] : [])];
  const files = Array.isArray(rec.files) && rec.files.length >= (rec.service === "keyhole-server" ? 2 : 1) && rec.files.length <= wantPaths.length
    && rec.files.every((f, i) => fieldsAre(f, ["path", "sha256"]) && f.path === wantPaths[i] && HEX64.test(f.sha256));
  if (!files) throw bad("files");
  if (rec.unit !== null && !(fieldsAre(rec.unit, ["name", "path", "sha256"]) && rec.unit.name === L.unitName
    && rec.unit.path === L.unitPath && HEX64.test(rec.unit.sha256))) throw bad("unit");
  // modules.toml, which an earlier release wrote for `install service keyhole|dispatch`;
  // accepted so such a record still loads, and set to null by the next install.
  if (rec.modules !== null && !(fieldsAre(rec.modules, ["path", "sha256"]) && rec.modules.path === join(L.confDir, "modules.toml")
    && HEX64.test(rec.modules.sha256))) throw bad("modules");
  if (rec.state_dir !== L.state) throw bad("state_dir");
  if (rec.config_dir !== L.confDir) throw bad("config_dir");
  let listen = null;
  try {
    listen = typeof rec.listen === "string" ? parseListen(rec.listen, { expose: true, acknowledged: true }) : null;
  } catch { /* refused below */ }
  if (!listen || (listen.kind === "unix" && scope === "system" && dirname(listen.path) !== L.runDir)) throw bad("listen");
  return rec;
}

/**
 * Read the services in the install record, trusting it only when it is a regular file owned
 * by the effective user, writable by no one else, on a path with no symlinked component.
 * Root's record sits in its passwd home (see the system layer), never one $HOME names.
 */
function readServices(sys, where) {
  const path = sys.path(recordFile(where.home));
  assertNoSymlinkComponents(path);
  let st = null;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (st && (!st.isFile() || st.uid !== sys.euid || (st.mode & 0o022) !== 0)) {
    throw filesystemError(`The install record ${path} must be a regular file owned by you and writable by no one else; refusing to trust it.`);
  }
  const manifest = readManifest(path, packageVersion());
  const services = manifest.services || {};
  for (const [k, rec] of Object.entries(services)) validateRecord(k, rec, where);
  return { path, manifest, services };
}

// A stale lock (its holder is dead, e.g. an install killed with SIGKILL) is taken over, and the
// command's report says so in `warnings`, naming the dead PID.
function withRecord(sys, where, fn) {
  const taken = [];
  const release = acquireLocks([sys.path(recordFile(where.home))], { onStale: (s) => taken.push(s) });
  try {
    const { path, manifest, services } = readServices(sys, where);
    manifest.services = services;
    const out = fn(services);
    if (out && out.write !== false) writeManifest(path, manifest);
    if (out && taken.length) out.warnings = [...(out.warnings || []), ...taken.map((t) => `took over the lock for ${t.path}: ${t.reason}`)];
    return out;
  } finally {
    release();
  }
}

/** The record an applied plan leaves: enough for a no-op check, remove and doctor. */
function recordOf(plan) {
  return {
    service: plan.service, instance: plan.instance, scope: plan.scope, package: plan.package, version: plan.version,
    platform: plan.platform, signer: plan.signature.keyId, listen: plan.listen,
    binaries: plan.binaries.map((b) => ({ name: b.name, path: b.to, sha256: b.sha256 })),
    symlink: plan.symlink, dirs: plan.dirs.map((d) => ({ path: d.path, mode: d.mode, owner: d.owner, group: d.group })),
    files: plan.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    unit: plan.unit ? { name: plan.unit.name, path: plan.unit.path, sha256: plan.unit.sha256 } : null,
    state_dir: plan.state_dir, config_dir: plan.config_dir, modules: null,
  };
}

// `keep`: files the user edited that this install leaves as they are (fileConflicts).
function sameAsRecorded(sys, plan, rec, keep = []) {
  if (!rec || rec.version !== plan.version) return false;
  const want = recordOf(plan);
  // Compare what the plan determines; `previous` (the version before an upgrade) and the
  // signer's key id are history, and so is a legacy `modules` entry: not part of what this
  // install should look like.
  const comparable = (r) => JSON.stringify({ ...r, signer: null, previous: null, modules: null });
  if (comparable(want) !== comparable(rec)) return false;
  for (const f of [...want.binaries, ...want.files, ...(want.unit ? [want.unit] : [])]) {
    if (!keep.includes(f.path) && hashOf(sys.path(f.path)) !== f.sha256) return false;
  }
  // `current` may name another instance's newer version; it only has to be there.
  return linkOf(sys.path(plan.symlink.path)) !== null;
}

// Returns true only when this run created the user (and, with --user-group, its group), so a
// failed install takes out exactly that and never a user that was there before.
function ensureUser(sys, plan) {
  if (!plan.user) return false;
  if (sys.run("getent", ["passwd", plan.user.name]).status === 0) return false;
  must(sys, "useradd", ["--system", "--user-group", "--home-dir", PROFILES[plan.service].stateRoot, "--no-create-home",
    "--shell", plan.user.shell, plan.user.name], `creating the ${plan.user.name} user`);
  return true;
}

// Undo step for ensureUser: the user, then its group. useradd --user-group refuses a name whose
// group already exists (exit 9), so that group is this run's too. With USERGROUPS_ENAB=yes (the
// shadow default) userdel already takes the group and groupdel fails, which an undo step ignores;
// with it off, groupdel is what removes it.
function removeCreatedUser(sys, name) {
  sys.run("userdel", [name]);
  sys.run("groupdel", [name]);
}

function chownPlanned(sys, plan, path, owner, group) {
  if (plan.scope !== "system") return;
  must(sys, "chown", [`${owner}:${group}`, sys.path(path)], `chown ${path}`);
}

// Levels above the ones install owns (/etc, /var/lib, ~/.config/systemd …) are created only
// when missing, one at a time, each with an exact mode (the umask never decides it).
// `created` (optional) collects each directory this call made, top down.
function ensureParents(sys, scope, path, created = null) {
  const parent = dirname(path);
  if (existsSync(sys.path(parent))) return;
  ensureParents(sys, scope, parent, created);
  const m = scope === "system" ? 0o755 : 0o700;
  mkdirSync(sys.path(parent), { mode: m });
  if (created) created.push(parent);
  chmodSync(sys.path(parent), m);
}

// A level install owns: never through a symlink or onto a file, then its exact mode and owner.
function makeDir(sys, plan, d, created = null) {
  const p = sys.path(d.path);
  ensureParents(sys, plan.scope, d.path, created);
  let st = null;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (st && !st.isDirectory()) throw filesystemError(`Refusing ${d.path}: it is a symlink or not a directory.`);
  if (!st) {
    mkdirSync(p, { mode: mode(d.mode) });
    if (created) created.push(d.path);
  }
  chmodSync(p, mode(d.mode));
  chownPlanned(sys, plan, d.path, d.owner, d.group);
}

function writeBinary(sys, b) {
  const dest = sys.path(b.to);
  const tmp = `${dest}.vbcdx-tmp-${process.pid}`;
  // Write the exact bytes that were hashed at verify time: the release path is never read
  // again, so a rewrite or symlink swap after verification can't reach the install.
  if (!Buffer.isBuffer(b.bytes) || sha256(b.bytes) !== b.sha256) {
    throw conflictError(`${b.name}: the verified bytes are missing or do not match; nothing was switched over.`);
  }
  // O_EXCL ("wx"): never through an existing file or link at the temp name.
  writeFileSync(tmp, b.bytes, { mode: mode(b.mode), flag: "wx" });
  chmodSync(tmp, mode(b.mode));
  renameSync(tmp, dest);
}

function setLink(sys, path, target) {
  const link = sys.path(path);
  const tmp = `${link}.vbcdx-tmp-${process.pid}`;
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

// Undo step: put a file back as it was before this run. `chown` re-applies its planned owner,
// since a rewrite as root would otherwise leave group vbcdx unable to read it.
export function fileRestorer(sys, path, chown = () => {}) {
  const p = sys.path(path);
  let before = null;
  // Never through a link: what is read here is written back (and chowned) on an undo, so a link
  // to another file would copy that file's bytes here. A non-regular file is refused.
  let fd = null;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === "ELOOP") throw filesystemError(`Refusing ${path}: it is a symlink.`);
    /* absent before this run */
  }
  if (fd !== null) {
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw filesystemError(`Refusing ${path}: it is not a regular file.`);
      before = { bytes: readFileSync(fd), mode: st.mode & 0o777 };
    } finally {
      closeSync(fd);
    }
  }
  return () => {
    if (!before) return rmSync(p, { force: true });
    atomicWrite(p, before.bytes, { mode: before.mode });
    return chown();
  };
}

/**
 * The config and unit files this install would write, against what is on disk now. A file the
 * user edited (its bytes match neither what this install writes nor what an earlier install
 * recorded) is theirs: if this install would write the same bytes as last time, it is kept as
 * it is; if this install would change it, that is a conflict, refused unless --force. A file on
 * disk that no record names (kept by an earlier remove, say) counts as edited unless it already
 * holds exactly what this install writes.
 */
export function fileConflicts(sys, plan, rec) {
  const recorded = new Map();
  if (rec) {
    for (const f of rec.files || []) recorded.set(f.path, f.sha256);
    if (rec.unit) recorded.set(rec.unit.path, rec.unit.sha256);
  }
  const conflicts = [];
  const keep = [];
  for (const t of [...plan.files, ...(plan.unit ? [plan.unit] : [])]) {
    // Only a regular file is hashed: reading a FIFO would block, and a directory would look absent.
    let st = null;
    try {
      st = lstatSync(sys.path(t.path));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (st && !st.isFile()) {
      throw filesystemError(`${t.path} is not a regular file (install writes a regular file there). Move it away, then rerun.`);
    }
    const onDisk = hashOf(sys.path(t.path));
    if (onDisk === null || onDisk === t.sha256) continue;
    const before = recorded.get(t.path);
    if (before && onDisk === before) continue;
    if (before && t.sha256 === before) keep.push(t.path);
    else conflicts.push(t.path);
  }
  return { conflicts, keep };
}

/**
 * --force saves each conflicting file as <file>.vbcdx-old; one already there (an earlier
 * --force's copy) would be overwritten, so it is refused instead, before anything is written.
 */
export function backupClashes(sys, conflicts) {
  return conflicts.map((path) => `${path}.vbcdx-old`).filter((b) => {
    try {
      lstatSync(sys.path(b));
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  });
}

/** The same check for a dry run, against the record as it stands. */
export function planConflicts(plan, sys) {
  return fileConflicts(sys, plan, recordFor(sys, plan));
}

/**
 * What a reinstall over an installed instance changes, for its dry run: the directories that
 * don't exist yet, the binaries when their version directory is new, the `current` link when it
 * moves, and each config or unit file whose text changes, as a line diff (null for a new file).
 * Only install's own text is ever diffed: a file whose on-disk hash isn't the recorded one was
 * edited by the user (a conflict, or a file install keeps), so it is never read into the output
 * (its CONFLICT or keep line names it by path), and an unrecorded file is never diffed either. Diff lines are stripped of control
 * characters. Reads are of regular files only (lstat first: no symlink is followed, no FIFO read).
 */
export function planChanges(sys, plan, rec) {
  const exists = (p) => existsSync(sys.path(p));
  const text = (p) => {
    try {
      if (!lstatSync(sys.path(p)).isFile()) return null;
      return readFileSync(sys.path(p), "utf8");
    } catch {
      return null;
    }
  };
  const recorded = new Map([...((rec && rec.files) || []).map((f) => [f.path, f.sha256]),
    ...(rec && rec.unit ? [[rec.unit.path, rec.unit.sha256]] : [])]);
  let link = null;
  try {
    link = readlinkSync(sys.path(plan.symlink.path));
  } catch { /* no link yet */ }
  const files = [];
  for (const f of [...plan.files, ...(plan.unit ? [plan.unit] : [])]) {
    const now = text(f.path);
    if (now === f.text) continue;
    if (now === null) {
      files.push({ path: f.path, diff: null });
    } else if (recorded.get(f.path) === sha256(Buffer.from(now))) {
      files.push({ path: f.path, diff: lineDiff(now, f.text).map(stripControls) });
    }
    // Otherwise the user edited it: named by path in the CONFLICT line, never echoed here.
  }
  return {
    dirs: plan.dirs.filter((d) => !exists(d.path)).map((d) => d.path),
    binaries: exists(dirname(plan.binaries[0].to)) ? [] : plan.binaries.map((b) => b.to),
    symlink: link !== plan.symlink.target,
    files,
  };
}

/** A line diff of two small texts (a config, a unit): "-old" and "+new" lines, in order. */
export function lineDiff(a, b) {
  const lines = (t) => {
    const l = t.split("\n");
    if (l[l.length - 1] === "") l.pop();
    return l;
  };
  const x = lines(a);
  const y = lines(b);
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      out.push(`-${x[i++]}`);
    } else {
      out.push(`+${y[j++]}`);
    }
  }
  while (i < x.length) out.push(`-${x[i++]}`);
  while (j < y.length) out.push(`+${y[j++]}`);
  return out;
}

/** The record of the instance a plan installs, or undefined (none yet). */
export function recordFor(sys, plan) {
  return readServices(sys, { scope: plan.scope, home: plan.home }).services[key(plan.service, plan.instance)];
}

// Refuse before anything is written, naming each file and the way out.
function refuseConflicts(conflicts) {
  return conflictError(`Edited since install, and this install would change ${conflicts.length === 1 ? "it" : "them"}: `
    + `${conflicts.join(", ")}. Nothing was changed. Merge your edits into what install writes, or rerun with --force: `
    + "each file is first saved as <file>.vbcdx-old, then replaced.");
}

/**
 * Apply an install plan. Returns the report; `changed:false` when it was already in place.
 * A step that fails midway undoes the earlier ones (a new version directory, the config, the
 * unit) and the record is not written; `current` moves only once every other step has worked.
 */
export function applyInstall(plan, sys, { token = null, cert = null, force = false, allowDowngrade = false } = {}) {
  return withRecord(sys, { scope: plan.scope, home: plan.home }, (services) => {
    const rec = services[key(plan.service, plan.instance)];
    // First, under the record lock: an older version than this instance runs.
    const down = downgradeOf(plan, rec);
    if (down && !allowDowngrade) throw refuseDowngrade(plan, down);
    // The user's edits: checked before anything is written, and before the no-op shortcut, since
    // an edited file is never "already in place".
    const { conflicts, keep } = fileConflicts(sys, plan, rec);
    if (conflicts.length && !force) throw refuseConflicts(conflicts);
    const clashes = force ? backupClashes(sys, conflicts) : [];
    if (clashes.length) {
      throw conflictError(`${clashes.join(", ")} already ${clashes.length === 1 ? "exists" : "exist"} (an earlier --force saved a copy there), `
        + "so --force would overwrite it. Nothing was changed. Move or remove it, then rerun.");
    }
    const busy = listenInUse(sys, plan, rec);
    if (busy) {
      throw conflictError(`${busy}, so the ${SERVICES[plan.service].daemon} could not start. Nothing was changed. `
        + "Free that address or pick another --listen, then rerun.");
    }
    if (!conflicts.length && sameAsRecorded(sys, plan, rec, keep)) {
      // dispatch-server already in place, with its certificate now: written, checked, then started.
      if (plan.link && cert) {
        const undo = [];
        const done = [];
        // A running instance (with its previous certificate) is started again if this one fails.
        const wasRunning = Boolean(plan.unit && rec && rec.unit && unitState(sys, plan.scope, plan.unit.name).state === "active");
        try {
          serverLink(sys, plan, cert, undo, done);
          checkConfig(sys, plan);
          // restart starts a stopped unit too, so this covers the first start and a replaced certificate.
          if (plan.unit && plan.start) {
            ctl(sys, plan.scope, ["restart", plan.unit.name], `starting ${plan.unit.name}`);
            waitStarted(sys, plan);
          }
        } catch (e) {
          for (const step of undo.reverse()) {
            try {
              step();
            } catch { /* keep undoing the rest */ }
          }
          if (wasRunning && plan.start) withNote(e, restorePrevious(sys, plan, rec));
          throw e;
        }
        for (const step of done) step();
        return { write: false, changed: true, kept: keep, link: linkReport(plan, true), ...summary(plan) };
      }
      if (plan.link) return { write: false, changed: false, kept: keep, ...summary(plan),
        link: linkReport(plan, existsSync(sys.path(plan.link.cert))), started: plan.start && existsSync(sys.path(plan.link.cert)) };
      // Already in place: a token given now is still redeemed (enroll only, nothing rewritten),
      // then a running unit restarts, since only `run` starts the tunnel.
      if (!token) return { write: false, changed: false, kept: keep, ...summary(plan) };
      const id = enrollSidecar(sys, plan, token);
      try {
        if (plan.unit && plan.start) {
          ctl(sys, plan.scope, ["restart", plan.unit.name], `restarting ${plan.unit.name}`);
          waitStarted(sys, plan);
        }
      } catch (e) {
        throw afterEnrollFailure(sys, plan, id, e);
      }
      return { write: false, changed: true, enrolled: id, kept: keep, ...summary(plan) };
    }
    // A changed config (a new control_plane, say) reaches a running daemon only through a
    // restart: the tunnel starts in `run`.
    const configChanged = Boolean(rec) && rec.files.some((f, i) => !plan.files[i] || plan.files[i].sha256 !== f.sha256);
    const upgrade = Boolean(rec && rec.version !== plan.version);
    const versionDir = dirname(plan.binaries[0].to);
    const undo = [];
    let enrolled = null;
    // Set once the unit step is reached on an instance that was running: after the undo, its
    // previous version is started again (see restorePrevious).
    let restartPrevious = false;
    // dispatch-server: whether its link certificate is in place, and so whether the unit starts.
    let hasCert = false;
    let start = plan.start;
    // Run once the install is through: dropping the saved previous link certificate.
    const linkDone = [];
    // What this run creates that no file restorer covers: the user and every directory that
    // wasn't there before, so a failed install leaves the host as it found it. Undone last (the
    // undo list runs in reverse), after the files and unit inside them: the directories newest
    // first, then the user.
    const createdDirs = [];
    let createdUser = false;
    // Set when this run enrolled and its tunnel credentials couldn't be removed: the user stays,
    // so they are never left under a uid a later useradd could reuse.
    let keepUser = false;
    undo.push(() => {
      // rmdir, never a recursive delete. This runs after every other undo step, so when those
      // worked each file this run wrote is gone again, and a directory that still holds something
      // holds what this run didn't put there (or a file a failed restorer left): it stays.
      for (const d of [...createdDirs].reverse()) {
        try {
          rmdirSync(sys.path(d));
        } catch { /* not empty, or already gone: keep it */ }
      }
      if (createdUser && !keepUser) removeCreatedUser(sys, plan.user.name);
    });
    try {
      if (!existsSync(sys.path(versionDir))) undo.push(() => rmSync(sys.path(versionDir), { recursive: true, force: true }));
      createdUser = ensureUser(sys, plan);
      for (const d of plan.dirs) makeDir(sys, plan, d, createdDirs);
      for (const b of plan.binaries) writeBinary(sys, b);
      // --force: the user's copy of each conflicting file is saved first, so nothing is lost.
      // If a later step fails, the copy goes again (backupClashes made sure none was there
      // before), and the file restorer below puts the user's own file back.
      for (const path of conflicts) {
        const p = sys.path(path);
        undo.push(() => rmSync(`${p}.vbcdx-old`, { force: true }));
        atomicWrite(`${p}.vbcdx-old`, readFileSync(p), { mode: statSync(p).mode & 0o777 });
      }
      for (const f of plan.files) {
        if (keep.includes(f.path)) continue;
        undo.push(fileRestorer(sys, f.path, () => chownPlanned(sys, plan, f.path, f.owner, f.group)));
        atomicWrite(sys.path(f.path), f.text, { mode: mode(f.mode) });
        chownPlanned(sys, plan, f.path, f.owner, f.group);
      }
      if (plan.link) {
        // Without a certificate yet, nothing can pass `dispatch check`: the unit is installed but not started.
        hasCert = serverLink(sys, plan, cert, undo, linkDone);
        if (hasCert) checkConfig(sys, plan);
        start = plan.start && hasCert;
      } else {
        requireEnrolled(plan, checkConfig(sys, plan), token);
      }
      if (token) enrolled = enrollSidecar(sys, plan, token);
      if (plan.unit) {
        ensureParents(sys, plan.scope, plan.unit.path, createdDirs);
        const restoreUnit = fileRestorer(sys, plan.unit.path);
        undo.push(() => {
          const [cmd, pre] = systemctl(plan.scope);
          // A unit this run enabled for the first time is stopped and disabled before its file
          // goes, so a daemon that failed to start doesn't go on restarting (or start at boot).
          // An instance that was installed before keeps its unit enabled: it goes back onto its
          // previous version below, once every restorer has run. One installed with --service none
          // had no unit: this run's is its first.
          if (!(rec && rec.unit)) sys.run(cmd, [...pre, "disable", "--now", plan.unit.name]);
          restoreUnit();
          sys.run(cmd, [...pre, "daemon-reload"]);
        });
        restartPrevious = Boolean(rec && rec.unit && start);
        if (!keep.includes(plan.unit.path)) atomicWrite(sys.path(plan.unit.path), plan.unit.text, { mode: mode(plan.unit.mode) });
        ctl(sys, plan.scope, ["daemon-reload"], "systemctl daemon-reload");
        ctl(sys, plan.scope, start ? ["enable", "--now", plan.unit.name] : ["enable", plan.unit.name], `enabling ${plan.unit.name}`);
        // A new version, a changed config, a new enrollment or a new certificate reaches a unit
        // that was already running only through a restart.
        if (rec && start && (upgrade || configChanged || enrolled || cert)) ctl(sys, plan.scope, ["restart", plan.unit.name], `restarting ${plan.unit.name}`);
        // "Started" means the daemon stays up, not that systemctl returned.
        if (start) waitStarted(sys, plan);
      }
      // Last: nothing that can fail runs after it, so `current` never needs putting back.
      setLink(sys, plan.symlink.path, plan.symlink.target);
      // The saved previous certificate is dropped only now. A failure here doesn't undo the install.
      for (const step of linkDone) {
        try {
          step();
        } catch { /* a leftover <cert>.vbcdx-prev is harmless; the next install replaces it */ }
      }
    } catch (e) {
      // The tunnel credentials an enroll in this run wrote go first, so the state directory
      // holding them is empty again when the undo steps reach it. A failure here never skips the
      // undo or replaces the error that stopped the install; it keeps the user this run created
      // (the credentials stay owned by it), and the error says so.
      const removed = enrolled ? removeTunnel(sys, plan) : true;
      if (!removed) keepUser = true;
      // Best effort, last step first; the error reported is the one that stopped the install.
      for (const step of undo.reverse()) {
        try {
          step();
        } catch { /* keep undoing the rest */ }
      }
      // Last, with its unit, config and binaries all put back: the version that ran before.
      if (restartPrevious) withNote(e, restorePrevious(sys, plan, rec));
      throw enrolled ? afterEnrollFailure(sys, plan, enrolled, e, { removed, userKept: !removed && createdUser }) : e;
    }
    // After a successful upgrade, the version this instance ran before goes once no other
    // instance still runs it (remove does the same for the version it takes out).
    const stillUsed = upgrade && Object.values(services).some((s) => s !== rec && s.service === plan.service && s.version === rec.version);
    if (upgrade && !stillUsed) rmSync(sys.path(join(dirname(versionDir), rec.version)), { recursive: true, force: true });
    const legacy = removeLegacyModules(sys, rec);
    services[key(plan.service, plan.instance)] = { ...recordOf(plan), modules: legacy.retained, previous: rec ? rec.version : null };
    return { changed: true, upgraded_from: upgrade && !down ? rec.version : null, downgraded_from: down ? rec.version : null, ...(enrolled ? { enrolled } : {}),
      legacy_removed: legacy.removed, ...(legacy.failed ? { legacy_not_removed: legacy.failed } : {}), kept: [...keep, ...legacy.kept], replaced: conflicts.map((path) => ({ path, saved_as: `${path}.vbcdx-old` })), ...summary(plan),
      ...(plan.link ? { link: linkReport(plan, hasCert), started: start } : {}) };
  });
}

/** The highest of some versions (SemVer precedence; identifiers compared as text). */
export function newestVersion(versions) {
  const parts = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(v);
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? null : m[4] };
  };
  const cmp = (a, b) => {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
    if (pa.pre === pb.pre) return 0;
    if (pa.pre === null) return 1;
    if (pb.pre === null) return -1;
    return pa.pre < pb.pre ? -1 : 1;
  };
  return [...versions].sort(cmp).at(-1);
}

function summary(plan) {
  return { service: plan.service, instance: plan.instance, version: plan.version, scope: plan.scope,
    unit: plan.unit ? plan.unit.name : null, listen: plan.listen, started: plan.start };
}

const PUBLIC_RECORD_MAX = 4096;

/**
 * A system sidecar instance, for a non-root caller, from its public record (plan.js,
 * publicRecordText): just what `config service` needs (the version, for requireCommand, and
 * vbcdx-svc's path and sha256, for configExec's hash check). Trusted only when it and every
 * directory above it in /etc/vbcdx are root's and not writable by group or other, it is a regular
 * file (never followed through a symlink), and it names exactly the path install derives for its
 * version. The record itself is in root's home, which a non-root caller can't read.
 */
export function systemSidecar(sys, instance) {
  if (!INSTANCE_RE.test(instance)) throw configError("--instance is 1-32 of a-z, 0-9 and '-', starting with a letter or digit.");
  const L0 = layout({ service: "sidecar", instance, version: "0", scope: "system", home: "/" });
  const where = L0.publicRecord;
  const untrusted = (why) => filesystemError(`${where} ${why}, so it isn't trusted; a system install writes it root-owned 0640 root:vbcdx. `
    + "Ask root to reinstall: vbcdx install service sidecar.");
  for (const dir of [PROFILES.sidecar.confRoot, L0.confDir]) {
    let st;
    try {
      st = lstatSync(sys.path(dir));
    } catch (e) {
      if (e.code === "ENOENT") throw notInstalledForYou(instance, where, "no system sidecar instance is installed either");
      throw filesystemError(`${dir} can't be read (${e.code}), so ${where} isn't trusted.`);
    }
    if (!st.isDirectory() || st.uid !== sys.rootUid || (st.mode & 0o022) !== 0) {
      throw filesystemError(`${dir} is not a root-owned directory that only root can write, so ${where} isn't trusted.`);
    }
  }
  let fd;
  try {
    fd = openSync(sys.path(where), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === "ENOENT") {
      throw notInstalledForYou(instance, where, "and the system install has no public record (installer 0.2.3 or older "
        + "wrote none: ask root to rerun vbcdx install service sidecar once)");
    }
    if (e.code === "EACCES") {
      throw configError(`${where} isn't readable by you: a system sidecar serves root and members of group vbcdx. `
        + "Ask root to add you (usermod -aG vbcdx <user>), then log in again.");
    }
    if (e.code === "ELOOP") throw untrusted("is a symlink");
    throw filesystemError(`${where} can't be opened (${e.code}), so it isn't trusted.`);
  }
  let text;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw untrusted("is not a regular file");
    if (st.uid !== sys.rootUid || (st.mode & 0o022) !== 0) throw untrusted("is not root's, or is writable by group or other");
    if (st.size > PUBLIC_RECORD_MAX) throw untrusted("is larger than a public record");
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    throw untrusted("is not JSON");
  }
  const ok = fieldsAre(r, ["schema", "service", "instance", "version", "vbcdx_svc"]) && r.schema === 1 && r.service === "sidecar"
    && r.instance === instance && typeof r.version === "string" && SEMVER.test(r.version)
    && fieldsAre(r.vbcdx_svc, ["path", "sha256"]) && typeof r.vbcdx_svc.sha256 === "string" && HEX64.test(r.vbcdx_svc.sha256)
    && r.vbcdx_svc.path === join(layout({ service: "sidecar", instance, version: r.version, scope: "system", home: "/" }).versionDir, "vbcdx-svc");
  if (!ok) throw untrusted("has unexpected contents");
  return { service: "sidecar", instance, version: r.version, scope: "system",
    binaries: [{ name: "vbcdx-svc", path: r.vbcdx_svc.path, sha256: r.vbcdx_svc.sha256 }] };
}

function notInstalledForYou(instance, where, rest) {
  return configError(`No sidecar instance "${instance}" is installed for you (no record in your home), ${rest}. `
    + `A system sidecar is reached through ${where}.`);
}

/** Find the (validated) record for service:instance, or throw exit 2. */
export function findRecord(sys, where, service, instance) {
  const rec = readServices(sys, where).services[key(service, instance)];
  if (!rec) throw configError(`No ${service} instance "${instance}" is installed: vbcdx install service ${service}.`);
  return rec;
}

/**
 * Remove what install recorded. Files edited since are kept and named; --wipe also deletes
 * state. The record is validated on load, before any step, so every path below is the one
 * install derives for this instance: either all of it is checked or none of it runs.
 */
export function applyRemove({ where, service, instance, wipe, dryRun }, sys) {
  return withRecord(sys, where, (services) => {
    const rec = services[key(service, instance)];
    if (!rec) throw configError(`No ${service} instance "${instance}" is installed.`);
    const L = layout({ service, instance, version: rec.version, scope: rec.scope, home: where.home });
    const actions = [];
    const kept = [];
    const owned = [...rec.files, ...(rec.modules ? [rec.modules] : []), ...(rec.unit ? [rec.unit] : [])];
    // A level swapped for a symlink since install would carry every delete below somewhere
    // else, so each path's parents are checked before any step (dry run included).
    for (const p of [L.versionDir, L.current, L.state, ...owned.map((f) => f.path)]) assertNoSymlinkComponents(dirname(sys.path(p)));
    // A unit file already deleted by hand can't be disabled; it is stopped instead.
    const unitFile = Boolean(rec.unit) && existsSync(sys.path(rec.unit.path));
    if (rec.unit) actions.push(unitFile ? `stop and disable ${rec.unit.name}` : `stop ${rec.unit.name} (its unit file is already gone)`);
    for (const f of owned) {
      if (hashOf(sys.path(f.path)) === f.sha256) actions.push(`delete ${f.path}`);
      else if (existsSync(sys.path(f.path))) kept.push(f.path);
    }
    // The binaries go only when no other instance still runs this version; `current` goes
    // with the last instance, and otherwise moves to the newest version still installed.
    const others = Object.values(services).filter((s) => s !== rec && s.service === rec.service);
    const shared = others.some((s) => s.version === rec.version);
    if (!shared) actions.push(`delete ${L.versionDir}`);
    const repoint = !shared && others.length > 0 && linkOf(sys.path(L.current)) === rec.version ? newestVersion(others.map((s) => s.version)) : null;
    if (!others.length) actions.push(`delete ${L.current}`);
    if (repoint) actions.push(`point ${L.current} at ${repoint}`);
    if (wipe) actions.push(`delete ${L.state} (state and held credentials)`);
    // Without --wipe the state stays, and so does what it holds (keys, the CA, the database): say so.
    const state_kept = !wipe && existsSync(sys.path(L.state)) ? L.state : null;
    if (dryRun) return { write: false, dryRun: true, actions, kept, state_kept };

    if (rec.unit) {
      if (unitFile) ctl(sys, rec.scope, ["disable", "--now", rec.unit.name], `disabling ${rec.unit.name}`);
      else {
        const [cmd, pre] = systemctl(rec.scope);
        sys.run(cmd, [...pre, "stop", rec.unit.name]);
      }
    }
    for (const f of owned) if (hashOf(sys.path(f.path)) === f.sha256) unlinkSync(sys.path(f.path));
    if (rec.unit) ctl(sys, rec.scope, ["daemon-reload"], "systemctl daemon-reload");
    if (!shared) rmSync(sys.path(L.versionDir), { recursive: true, force: true });
    if (!others.length) rmSync(sys.path(L.current), { force: true });
    if (repoint) setLink(sys, L.current, repoint);
    if (wipe) rmSync(sys.path(L.state), { recursive: true, force: true });
    delete services[key(service, instance)];
    return { removed: true, actions, kept, state_kept };
  });
}

/** Every recorded instance with its unit state. */
/** Which instances the record names ({service, instance}), from the record file alone: no command runs. */
export function recordedInstances(sys, where) {
  return Object.values(readServices(sys, where).services).map((r) => ({ service: r.service, instance: r.instance }));
}

export function listServices(sys, where) {
  return Object.values(readServices(sys, where).services).map((r) => {
    let state = "no unit";
    if (r.unit) {
      const [cmd, pre] = systemctl(r.scope);
      state = (sys.run(cmd, [...pre, "is-active", r.unit.name]).stdout || "unknown").trim() || "unknown";
    }
    return { service: r.service, instance: r.instance, version: r.version, scope: r.scope, unit: r.unit ? r.unit.name : null,
      state, listen: r.listen };
  });
}

/** The health of one instance. ok only when every check passes (the CLI exits 0 or 5). */
export function doctorService(sys, rec, { probe = () => null } = {}) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ check: name, ok: Boolean(ok), detail });
  for (const b of rec.binaries) check(`binary ${b.name}`, hashOf(sys.path(b.path)) === b.sha256, b.path);
  // `current` may name another instance's version; it must resolve to an installed daemon.
  const link = linkOf(sys.path(rec.symlink.path));
  check("current symlink", existsSync(sys.path(join(rec.symlink.path, SERVICES[rec.service].daemon))), `${rec.symlink.path} -> ${link}`);
  for (const f of rec.files) check(`file ${f.path}`, hashOf(sys.path(f.path)) === f.sha256, "matches what install wrote");
  const st = (() => {
    try {
      return statSync(sys.path(rec.state_dir));
    } catch {
      return null;
    }
  })();
  check("state dir 0700", st && (st.mode & 0o777) === 0o700, rec.state_dir);
  if (rec.service === "dispatch-server" || rec.service === "keyhole-server") {
    const daemon = SERVICES[rec.service].daemon;
    const modeOf = (p) => {
      try {
        const s = lstatSync(sys.path(p));
        return s.isFile() ? s.mode & 0o777 : null;
      } catch {
        return null;
      }
    };
    const key = join(rec.state_dir, "link.key");
    const crt = join(rec.state_dir, "link.crt");
    check("link key 0600", modeOf(key) === 0o600, key);
    const hasCert = modeOf(crt) !== null;
    if (rec.service === "keyhole-server") {
      const kek = join(rec.state_dir, "kek");
      check("KEK 0600", modeOf(kek) === 0o600, kek);
    }
    check("link certificate", hasCert, hasCert ? crt
      : `${crt} is missing: run vbcdx-control services add ${daemon} on the control host, then reinstall with --service-cert`);
    // The installed daemon's own check of the env file, the certificate and the key (keyhole-server:
    // and the control CA and the KEK), as the unit's user.
    const argv = rec.service === "keyhole-server" ? ["--env-file", rec.files[0].path, "check"] : ["check", "--env-file", rec.files[0].path];
    const r = sys.run("runuser", ["-u", PROFILES[rec.service].user, "--", sys.path(rec.binaries[0].path), ...argv]);
    const said = (r.status === 0 ? r.stdout : r.stderr || "").trim().split("\n").pop();
    check(`${daemon} check`, r.status === 0, said || `${daemon} check exited ${r.status}`);
  }
  if (rec.unit) {
    check("unit file", hashOf(sys.path(rec.unit.path)) === rec.unit.sha256, rec.unit.path);
    const [cmd, pre] = systemctl(rec.scope);
    const active = (sys.run(cmd, [...pre, "is-active", rec.unit.name]).stdout || "").trim();
    // Not active: the daemon's own last line says why (systemd's state alone doesn't).
    const said = active === "active" ? null : lastDaemonLine(sys, rec.scope, rec.unit.name, SERVICES[rec.service].daemon);
    check("unit active", active === "active", `${rec.unit.name}: ${active || "unknown"}${said ? `; last: ${said}` : ""}`);
  }
  // Its sockets, where the installed config puts them: a system sidecar's are 0660 group vbcdx;
  // a user sidecar's, and the control plane's admin socket, are 0600.
  const sockets = socketsOf(sys, rec);
  if (!sockets) {
    check("sockets", false, `${rec.files[0].path} is not the config install wrote; reinstall to put it back`);
  } else {
    const shared = rec.service === "sidecar" && rec.scope === "system";
    const gid = shared ? groupId(sys, "vbcdx") : null;
    for (const [name, sock] of sockets) {
      let s = null;
      try {
        s = lstatSync(sys.path(sock));
      } catch { /* missing */ }
      const ok = s && s.isSocket() && (s.mode & 0o777) === (shared ? 0o660 : 0o600) && (!shared || s.gid === gid);
      check(`${name} ${shared ? "0660 group vbcdx" : "0600"}`, ok, sock);
    }
  }
  // A sidecar with a control plane: one authenticated ping over the tunnel, as the unit's user.
  const controlPlane = rec.service === "sidecar" ? controlPlaneOf(sys, rec) : null;
  if (controlPlane) {
    const bin = sys.path(rec.binaries.find((b) => b.name === "vbcdx-sidecar").path);
    const args = ["check", "--dial", "--instance", rec.instance, "--instance-dir", rec.config_dir];
    const r = rec.scope === "system" ? sys.run("runuser", ["-u", "vbcdx", "--", bin, ...args]) : sys.run(bin, args);
    // `check --dial` prints the daemon's summary with control_plane.dial = {ok, sidecar_id}
    // (vbcdx-core crates/vbcdx-sidecar/src/main.rs, Cmd::Check with --dial).
    let dial = null;
    try {
      const d = JSON.parse(r.stdout).control_plane.dial;
      if (r.status === 0 && d && d.ok === true && typeof d.sidecar_id === "string") dial = d;
    } catch { /* no summary: not ok */ }
    const said = (r.stderr || "").trim().split("\n").pop();
    check("control plane tunnel (check --dial)", dial !== null,
      dial ? `reached as sidecar ${dial.sidecar_id}` : said || `check --dial exited ${r.status} with no dial result`);
    // The running daemon's own tunnel, not a fresh dial from disk: is it connected, and as
    // the sidecar id on disk? `check --live` prints the summary with
    // control_plane.live = {ok, sidecar_id}; exit 10 = connected as another id, 9 = down.
    const largs = ["check", "--live", "--instance", rec.instance, "--instance-dir", rec.config_dir];
    const lr = rec.scope === "system" ? sys.run("runuser", ["-u", "vbcdx", "--", bin, ...largs]) : sys.run(bin, largs);
    let live = null;
    try {
      const l = JSON.parse(lr.stdout).control_plane.live;
      if (lr.status === 0 && l && l.ok === true && typeof l.sidecar_id === "string") live = l;
    } catch { /* no summary: not ok */ }
    const lsaid = (lr.stderr || "").trim().split("\n").pop();
    const name = "control plane tunnel (daemon, check --live)";
    if (lr.status === 2 && /unknown argument/.test(lsaid)) {
      // A sidecar release from before check --live: say so rather than fail every older install.
      check(name, true, "not checked: this vbcdx-sidecar is older than check --live");
    } else if (live && dial && live.sidecar_id !== dial.sidecar_id) {
      // Core compares the live id with the disk too; the doctor holds the disk's own answer
      // (the fresh dial above) and checks it again, so a wrong id never passes here.
      check(name, false, `the running daemon is connected as sidecar ${live.sidecar_id}, but the credential on disk dials as ${dial.sidecar_id}`);
    } else {
      check(name, live !== null,
        live ? `the running daemon is connected as sidecar ${live.sidecar_id}` : lsaid || `check --live exited ${lr.status} with no live result`);
    }
  }
  const health = probe(rec);
  if (health !== null) check("health probe", health.ok, health.detail);
  return { service: rec.service, instance: rec.instance, version: rec.version, ok: checks.every((c) => c.ok), checks };
}

// The sockets of the config install wrote, as [name, path] pairs: the sidecar's unix listen and
// admin socket, or the control plane's admin socket. Null when the file is not that one any more
// (edited, or written by an older installer).
function socketsOf(sys, rec) {
  const f = rec.files[0];
  if (hashOf(sys.path(f.path)) !== f.sha256) return null;
  // dispatch-server and keyhole-server listen on TCP only (their env files are not TOML): no socket to check.
  if (rec.service === "dispatch-server" || rec.service === "keyhole-server") return [];
  let conf;
  try {
    conf = tomlParse(readFileSync(sys.path(f.path), "utf8"));
  } catch {
    return null;
  }
  if (rec.service === "control-plane") return typeof conf.admin_socket === "string" ? [["admin socket", conf.admin_socket]] : null;
  const PREFIX = "vbcdx+unix://";
  if (typeof conf.listen !== "string" || !conf.listen.startsWith(PREFIX) || typeof conf.admin_socket !== "string") return null;
  try {
    return [["socket", decodeURIComponent(conf.listen.slice(PREFIX.length))], ["admin socket", conf.admin_socket]];
  } catch {
    return null;
  }
}

// The control_plane of the config install wrote, or null (none set, or the file was edited).
function controlPlaneOf(sys, rec) {
  const f = rec.files[0];
  if (hashOf(sys.path(f.path)) !== f.sha256) return null;
  try {
    const conf = tomlParse(readFileSync(sys.path(f.path), "utf8"));
    return typeof conf.control_plane === "string" ? conf.control_plane : null;
  } catch {
    return null;
  }
}

// A group's id from the host's group database; undefined when it has none.
function groupId(sys, name) {
  const r = sys.run("getent", ["group", name]);
  const gid = r.status === 0 ? Number((r.stdout || "").split(":")[2]) : NaN;
  return Number.isInteger(gid) ? gid : undefined;
}

/** status|start|stop|restart|logs for an instance. Output goes straight to the terminal. */
export function serviceAction(sys, rec, action, { follow = false } = {}) {
  if (!rec.unit) throw configError(`${rec.service} "${rec.instance}" was installed with --service none: run it in the foreground.`);
  const user = rec.scope === "user";
  if (action === "logs") {
    return sys.run("journalctl", [...(user ? ["--user-unit"] : ["-u"]), rec.unit.name, "--no-pager", ...(follow ? ["-f"] : [])], { inherit: true }).status;
  }
  const [cmd, pre] = systemctl(rec.scope);
  return sys.run(cmd, [...pre, action, rec.unit.name], { inherit: true }).status;
}

/**
 * `vbcdx config service <svc> …`: run this instance's own vbcdx-svc as `vbcdx-svc <svc> …`. `argv`
 * starts at the service name; the secret scan has already run on the whole command line. It runs
 * on the installer's own terminal and environment (`inherit`: stdin, stdout and stderr are
 * vbcdx-svc's, and the exit code is its own).
 */
export function configExec(sys, rec, argv) {
  const svc = rec.binaries.find((b) => b.name === "vbcdx-svc");
  if (!svc) throw conflictError("This install has no vbcdx-svc binary.");
  const bin = sys.path(svc.path);
  if (hashOf(bin) !== svc.sha256) throw conflictError("vbcdx-svc does not match what install wrote: run vbcdx doctor --service sidecar.");
  return sys.run(bin, argv, { inherit: true }).status;
}

/**
 * An old `modules.toml` an earlier release recorded (`install service keyhole|dispatch`, before
 * the sidecar lost its modules): the sidecar never reads it now. A successful install of the
 * sidecar takes it out if it is still the file install wrote, and names it as kept if it was
 * edited since. It is never parsed. It runs after the install is done, so it never fails it:
 * a file that can't be removed is named with the reason and stays recorded (`retained`), so
 * a later upgrade or remove still takes it out.
 */
function removeLegacyModules(sys, rec) {
  const none = { removed: null, kept: [], failed: null, retained: null };
  if (!rec || !rec.modules) return none;
  const p = sys.path(rec.modules.path);
  if (!existsSync(p)) return none;
  if (hashOf(p) !== rec.modules.sha256) return { ...none, kept: [rec.modules.path] };
  try {
    unlinkSync(p);
  } catch (e) {
    return { ...none, failed: { path: rec.modules.path, reason: e.code || e.message }, retained: rec.modules };
  }
  return { ...none, removed: rec.modules.path };
}
