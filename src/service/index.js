// `vbcdx install|remove|list|doctor|service|config … service`: the service lifecycle front
// door (the service-CLI spec, Install and lifecycle). A release is verified before anything
// is written; the plan --dry-run prints is exactly what install applies (apply.js).

import { closeSync, constants, existsSync, fstatSync, mkdtempSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { EXIT, conflictError, configError } from "../errors.js";
import { hostPlatform, verifyRelease, SERVICES } from "./artifact.js";
import { parseListen, parseControlPlane, parseTunnel, parseDispatch, parseKeyhole, buildPlan, PROFILES, notInstallable } from "./plan.js";
import { RELEASE_KEYS } from "./trust.js";
import { readPemCerts } from "./pem.js";
import { realSystem } from "./system.js";
import { requireCommand } from "./areas.js";
import { CONFIG_AREAS } from "./args.js";
import { recordLock, unrecordedLeftovers } from "./leftovers.js";
import { carryOver } from "./carry.js";
import { applyInstall, applyRemove, kekRefusal, configExec, doctorService, downgradeOf, findRecord, planChanges, listServices, planConflicts, backupClashes, listenInUse, recordFor, recordedInstances, serviceAction, systemSidecar } from "./apply.js";

/**
 * The host a service command runs on. Root's home comes from its passwd entry, never from
 * $HOME, so a root install record can't be redirected by the environment it runs in.
 */
export function serviceHost(sys, env = process.env) {
  return { uid: sys.uid, home: sys.uid === 0 ? sys.passwdHome() : env.HOME, runtimeDir: env.XDG_RUNTIME_DIR || null };
}
const hostOf = (deps, sys) => deps.host || serviceHost(sys);
const whereOf = (host) => {
  if (!host.home || !isAbsolute(host.home)) throw configError("HOME must be set to an absolute path.");
  return { scope: host.uid === 0 ? "system" : "user", home: host.home };
};

/**
 * Fetch a release from the registry into a private staging prefix: `npm install --global
 * --ignore-scripts`. The @vbcdx scope's registry and its auth come from the host's own npm
 * config (`@vbcdx:registry=…` in ~/.npmrc), never from a flag, so no token is on argv and
 * the installer names no registry of its own.
 */
function stageFromRegistry(opts, sys, host) {
  const pkg = SERVICES[opts.service].package;
  const base = sys.path(join(host.home, ".vbcdx", "cache"));
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const prefix = mkdtempSync(join(base, "npm-"));
  // Run from the empty staging dir, so no project .npmrc or package.json around the caller's
  // working directory can take part (global mode ignores project config as well).
  const r = sys.run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund",
    `${pkg}@${opts.version || "latest"}`], { cwd: prefix });
  if (r.status !== 0) {
    rmSync(prefix, { recursive: true, force: true });
    throw conflictError(`npm could not install ${pkg}@${opts.version || "latest"} (exit ${r.status}); check the @vbcdx registry in your npm config.`);
  }
  const root = join(prefix, "lib", "node_modules", ...pkg.split("/"));
  return { root, binRoots: [join(root, "node_modules"), join(prefix, "lib", "node_modules")], cleanup: () => rmSync(prefix, { recursive: true, force: true }) };
}

/** The plan for `install service …`, from a verified release. `deps` is for tests only. */
export function planInstall(given, deps = {}) {
  const sys = deps.sys || realSystem();
  const host = hostOf(deps, sys);
  const trustedKeys = deps.trustedKeys || RELEASE_KEYS;
  // Refused before the registry is asked for anything (buildPlan refuses it too).
  if (!PROFILES[given.service]) throw notInstallable(given.service);
  // Over an installed instance, a setting left out is kept from what is installed (carry.js).
  const rec = recordFor(sys, { scope: host.uid === 0 ? "system" : "user", home: host.home, service: given.service, instance: given.instance });
  const { opts, carried } = carryOver(given, rec, sys, host);
  const listen = opts.listen ? parseListen(opts.listen, { expose: opts.expose, acknowledged: opts.acknowledged }) : null;
  if (opts.expose && !listen) throw configError("--expose-on-network needs a --listen <host>:<port>.");
  const controlPlane = opts.controlPlane ? parseControlPlane(opts.controlPlane) : null;
  const tunnel = opts.tunnel ? parseTunnel(opts.tunnel, opts.tunnelName) : null;
  const enroll = opts.enrollTokenFile ? `file ${opts.enrollTokenFile}` : opts.enrollTokenStdin ? "stdin" : null;
  // dispatch-server's control-plane-mode flags, checked before anything is fetched (buildPlan uses them).
  const dispatch = opts.service === "dispatch-server"
    ? { linkListen: opts.linkListen, controlUrl: opts.controlUrl, publicUrl: opts.publicUrl } : null;
  if (dispatch) parseDispatch(dispatch, listen && listen.kind === "tcp" ? listen : parseListen("127.0.0.1:8080"));
  // keyhole-server's, the same way; the control CA is read now (or carried from the installed copy).
  const keyhole = opts.service === "keyhole-server"
    ? { linkListen: opts.linkListen, controlUrl: opts.controlUrl, publicUrl: opts.publicUrl,
      controlCa: opts.controlCa ? readControlCA(opts) : opts.controlCaText || null } : null;
  if (keyhole) parseKeyhole(keyhole, listen && listen.kind === "tcp" ? listen : parseListen("127.0.0.1:8080"));
  const staged = opts.from
    ? { root: isAbsolute(opts.from) ? opts.from : resolve(deps.cwd || process.cwd(), opts.from), binRoots: null, cleanup: () => {} }
    : stageFromRegistry(opts, sys, host);
  try {
    const release = verifyRelease({ root: staged.root, binRoots: staged.binRoots, service: opts.service, version: opts.version,
      platformId: deps.platformId || hostPlatform(), trustedKeys });
    const plan = buildPlan({ service: opts.service, instance: opts.instance, release, serviceManager: opts.serviceManager,
      listen, start: opts.start, host, controlPlane, enroll, tunnel, dispatch, keyhole });
    plan.carried = carried;
    return { plan, cleanup: staged.cleanup };
  } catch (e) {
    staged.cleanup();
    throw e;
  }
}

/**
 * dispatch-server's or keyhole-server's --service-cert: the chain `vbcdx-control services add
 * dispatch|keyhole --cert-out` wrote. `dispatch check` / `keyhole check` decides whether it names
 * the service and fits the key.
 */
export function readServiceCert(opts) {
  if (!opts.serviceCert) return null;
  const name = opts.service === "keyhole-server" ? "keyhole" : "dispatch";
  return readPemCerts("--service-cert", opts.serviceCert, `from vbcdx-control services add ${name} --cert-out`);
}

/** keyhole-server's --control-ca: the control CA certificate (PEM), public. Its text, or null. */
export function readControlCA(opts) {
  if (!opts.controlCa) return null;
  return readPemCerts("--control-ca", opts.controlCa, "the control plane's CA certificate").toString("latin1");
}

// A vbx_enr_ token is far shorter; anything larger is not one, and is never read whole.
const TOKEN_MAX = 4096;

// How long stdin may take to deliver the token (piped from a slow command, e.g. a remote mint),
// and how long to wait before trying an empty non-blocking stdin again.
export const STDIN_WAIT_MS = 60_000;
const STDIN_RETRY_MS = 20;

/**
 * Reads fd 0 to end of input, but at most `max + 1` bytes (one past the limit, so the caller can
 * tell "too large" without reading the rest). A non-blocking stdin with nothing yet answers EAGAIN:
 * that is waited out and tried again, until STDIN_WAIT_MS has passed. `io` is for
 * tests: `read(buf, offset, length)`, `sleep(ms)` and `now()`.
 */
export function readStdinBounded(max, io = {}) {
  const read = io.read || ((buf, off, len) => readSync(0, buf, off, len, null));
  const sleep = io.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const now = io.now || Date.now;
  const buf = Buffer.alloc(max + 1);
  const deadline = now() + STDIN_WAIT_MS;
  let n = 0;
  while (n < buf.length) {
    let k;
    try {
      k = read(buf, n, buf.length - n);
    } catch (e) {
      if (e.code === "EOF") break;
      if (e.code !== "EAGAIN" && e.code !== "EWOULDBLOCK") throw e;
      if (now() >= deadline) {
        throw configError(`No enrollment token arrived on stdin within ${STDIN_WAIT_MS / 1000} s; nothing was written.`);
      }
      sleep(STDIN_RETRY_MS);
      continue;
    }
    if (k === 0) break;
    n += k;
  }
  return buf.subarray(0, n);
}

/**
 * The enrollment token, from a 0600 regular file the caller owns (opened without following a
 * symlink, and non-blocking, so a planted FIFO can't hang the installer) or from stdin: never
 * argv. Read before anything is written; its value is never printed.
 */
export function readEnrollToken(opts, sys, readStdin = () => readStdinBounded(TOKEN_MAX)) {
  if (!opts.enrollTokenFile && !opts.enrollTokenStdin) return null;
  let raw;
  if (opts.enrollTokenFile) {
    const f = opts.enrollTokenFile;
    let fd;
    try {
      fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      throw configError(`--enroll-token-file ${f} can't be opened (${e.code}); it must be a regular file, not a symlink.`);
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw configError(`--enroll-token-file ${f} must be a regular file.`);
      if ((st.mode & 0o077) !== 0 || st.uid !== sys.euid) {
        throw configError(`--enroll-token-file ${f} must be 0600 (no group or other access) and owned by you.`);
      }
      const buf = Buffer.alloc(TOKEN_MAX + 1);
      let n = 0;
      for (let k; n < buf.length && (k = readSync(fd, buf, n, buf.length - n, null)) > 0;) n += k;
      if (n > TOKEN_MAX) throw configError(`--enroll-token-file ${f} is larger than an enrollment token.`);
      raw = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } else {
    const buf = readStdin();
    if (buf.length > TOKEN_MAX) throw configError("stdin is larger than an enrollment token.");
    raw = buf.toString("utf8");
  }
  const token = raw.replace(/\r?\n$/, "");
  if (!/^vbx_enr_\S+$/.test(token)) throw configError("The enrollment token is not one vbx_enr_ token on one line; nothing was written. Its value is not shown.");
  return Buffer.from(token);
}

/** Run a parsed service command. Returns {report, code, kind}. */
export function runService(opts, deps = {}) {
  const sys = deps.sys || realSystem();
  const host = hostOf(deps, sys);
  switch (opts.command) {
    case "install": {
      const { plan, cleanup } = planInstall(opts, { ...deps, sys });
      try {
        if (opts.dryRun) {
          // The same file check install makes: a dry run that would be refused says so, and exits 5.
          const { conflicts, keep } = planConflicts(plan, sys);
          const clashes = opts.force ? backupClashes(sys, conflicts) : [];
          // And the lock install takes: a live holder refuses the real run (exit 4), a stale one is
          // taken over. Files an interrupted install left, which install would adopt, are listed.
          const where = { scope: plan.scope, home: plan.home };
          const lock = recordLock(sys, where);
          const leftovers = unrecordedLeftovers(sys, { service: plan.service, instance: plan.instance, ...where }, recordedInstances(sys, where));
          const rec = recordFor(sys, plan);
          // A TCP --listen something already holds: install would refuse it before writing (exit 5).
          const busy = listenInUse(sys, plan, rec);
          // An older version than the instance runs: refused (exit 5) unless --allow-downgrade.
          const downgrade = downgradeOf(plan, rec);
          const refused = downgrade && !opts.allowDowngrade ? "downgrade" : null;
          // A server's link step install would refuse (a missing KEK on an instance that has run).
          const link_steps = plan.link ? linkSteps(plan, sys, Boolean(opts.serviceCert)) : null;
          const code = lock.state === "held" ? EXIT.FILESYSTEM
            : (conflicts.length && !opts.force) || clashes.length || busy || refused || (link_steps && link_steps.refused) ? EXIT.CONFLICT : 0;
          // Over an installed instance: an upgrade (or downgrade) of it, and only what changes.
          const upgrade = rec && !downgrade && rec.version !== plan.version ? { from: rec.version, to: plan.version } : null;
          const changes = rec ? planChanges(sys, plan, rec) : null;
          return { kind: "plan", report: { dryRun: true, ...plan, conflicts, kept: keep, force: Boolean(opts.force), backup_clashes: clashes,
            lock, leftovers, listen_in_use: busy, downgrade, refused, upgrade, changes, ...(link_steps ? { link_steps } : {}) }, code };
        }
        const token = readEnrollToken(opts, sys, deps.readStdin);
        const cert = readServiceCert(opts);
        return { kind: "install", report: applyInstall(plan, sys, { token, cert, force: Boolean(opts.force), allowDowngrade: Boolean(opts.allowDowngrade) }), code: 0 };
      } finally {
        cleanup();
      }
    }
    case "remove":
      return { kind: "remove", report: applyRemove({ where: whereOf(host), service: opts.service,
        instance: opts.instance, wipe: opts.wipe, dryRun: opts.dryRun }, sys), code: 0 };
    case "list":
      return { kind: "list", report: { services: listServices(sys, whereOf(host)) }, code: 0 };
    case "doctor": {
      const where = whereOf(host);
      let rec;
      try {
        rec = findRecord(sys, where, opts.service, opts.instance);
      } catch (e) {
        // Not installed, but an interrupted install may have left files or a lock behind: name them.
        const report = partialState(sys, where, opts);
        if (!report) throw e;
        return { kind: "doctor", report, code: 5 };
      }
      const report = doctorService(sys, rec, deps);
      return { kind: "doctor", report, code: report.ok ? 0 : 5 };
    }
    case "service":
      return { kind: "passthrough", report: null,
        code: serviceAction(sys, findRecord(sys, whereOf(host), opts.service, opts.instance), opts.action, { follow: opts.follow }) };
    case "config": {
      // Keyhole's and Dispatch's commands run on the sidecar instance's own vbcdx-svc, as
      // `vbcdx-svc keyhole|dispatch …`; the sidecar forwards them (no per-service module).
      if (opts.service !== "sidecar" && !CONFIG_AREAS.includes(opts.service)) {
        throw conflictError(`config service ${opts.service} is not available: config service takes sidecar, keyhole or dispatch.`);
      }
      const instance = instanceFrom(opts.passthrough);
      const where = whereOf(host);
      // A non-root caller with no sidecar of its own uses the system one, through its public
      // record (its sockets are 0660 group vbcdx; the install record is in root's home).
      const own = recordFor(sys, { ...where, service: "sidecar", instance });
      const rec = own || (host.uid !== 0 ? systemSidecar(sys, instance) : findRecord(sys, where, "sidecar", instance));
      requireCommand(rec, opts.passthrough);
      return { kind: "passthrough", report: null, code: configExec(sys, rec, opts.passthrough) };
    }
    default:
      throw configError(`Unknown service command: ${opts.command}.`);
  }
}

// doctor for an instance no record names: null when nothing is left behind, else a failing
// report naming each unrecorded file (and a lock nobody holds any more), so a stranger sees the
// partial state an interrupted install leaves instead of "not installed".
function partialState(sys, where, opts) {
  const leftovers = unrecordedLeftovers(sys, { service: opts.service, instance: opts.instance, ...where }, recordedInstances(sys, where));
  const lock = recordLock(sys, where);
  if (!leftovers.length && lock.state !== "stale") return null;
  const checks = [{ check: "install record", ok: false, detail: `no ${opts.service} instance "${opts.instance}" is recorded` }];
  for (const p of leftovers) checks.push({ check: "unrecorded leftover", ok: false, detail: p });
  if (lock.state === "stale") checks.push({ check: "install record lock", ok: false, detail: `stale (${lock.reason}); the next install or remove takes it over` });
  return { service: opts.service, instance: opts.instance, version: "not installed", ok: false, checks,
    hint: `an interrupted install left these; rerun vbcdx install service ${opts.service} to finish it` };
}

// vbcdx-svc reads --instance itself (from `<svc> …`); the installer only needs it to find the record.
// Only up to `--`: after it every argument is vbcdx-svc's positional, even one spelled --instance.
function instanceFrom(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === "--instance" && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith("--instance=")) return argv[i].slice("--instance=".length);
  }
  return "default";
}

/** The human form of each report. */
export function humanReport(kind, r) {
  const body = humanBody(kind, r);
  const warnings = ((r && r.warnings) || []).map((w) => `warning: ${w}`);
  return [...warnings, body].filter(Boolean).join("\n");
}
function humanBody(kind, r) {
  if (kind === "plan") return humanPlan(r);
  if (kind === "install") {
    const kept = (r.kept || []).map((f) => `  kept ${f} (edited since install; left as it is)`);
    const replaced = (r.replaced || []).map((x) => `  replaced ${x.path} (edited since install; your copy is ${x.saved_as})`);
    // While the link certificate is missing, the step that gets it (also in --json as link.next).
    const next = r.link && r.link.next ? [`  next: ${r.link.next}`] : [];
    // An old modules.toml an earlier release recorded: the sidecar has no modules now.
    const legacy = r.legacy_removed ? [`  removed ${r.legacy_removed} (an old modules.toml; the sidecar has no modules)`]
      : r.legacy_not_removed ? [`  could not remove ${r.legacy_not_removed.path} (${r.legacy_not_removed.reason}): an old modules.toml `
        + "the sidecar ignores; it stays recorded, so the next upgrade or remove takes it out"] : [];
    if (!r.changed) return [`install service ${r.service} ${r.version} (${r.instance}): already in place, nothing changed`, ...kept, ...next].join("\n");
    const from = r.upgraded_from ? `, upgraded from ${r.upgraded_from}` : r.downgraded_from ? `, downgraded from ${r.downgraded_from} (--allow-downgrade)` : "";
    return [`Installed service ${r.service} ${r.version} as instance ${r.instance} (${r.scope})${from}`,
      r.unit ? `  unit ${r.unit}${r.started ? " (started)" : " (enabled, not started)"}` : "  no unit (--service none)",
      `  listen ${r.listen}`, ...(r.enrolled ? [`  enrolled with the control plane as ${r.enrolled}`] : []), ...kept, ...replaced, ...legacy, ...next].join("\n");
  }
  if (kind === "remove") {
    const lines = [`${r.dryRun ? "Planned" : "Applied"} remove:`, ...r.actions.map((a) => `  ${a}`)];
    for (const k of r.kept) lines.push(`  kept (edited since install): ${k}`);
    if (r.state_kept) {
      lines.push(r.dryRun ? `  keep ${r.state_kept} (state and held credentials); --wipe in place of this remove deletes it too`
        : `  kept ${r.state_kept} (state and held credentials); the instance is no longer recorded, so a later remove --wipe won't find it`);
    }
    return lines.join("\n");
  }
  if (kind === "list") {
    if (!r.services.length) return "no services installed";
    return r.services.map((s) => `${s.service}  ${s.instance}  ${s.version}  ${s.scope}  ${s.state}  ${s.listen}`).join("\n");
  }
  if (kind === "doctor") {
    return [`doctor ${r.service} (${r.instance}, ${r.version}): ${r.ok ? "ok" : "problems found"}`,
      ...r.checks.map((c) => `  ${c.ok ? "ok  " : "FAIL"} ${c.check}: ${c.detail}`), ...(r.hint ? [`  ${r.hint}`] : [])].join("\n");
  }
  return "";
}

/**
 * What a dispatch-server or keyhole-server install does about its link, for a dry run: the files it
 * makes as the service user (keyhole-server's KEK, the link key and CSR; only those not there yet,
 * by path, mode and owner, never content), and whether the unit starts, which it does only with a
 * certificate (given now, or already installed). Existence is a stat, as install's own check is.
 */
function linkSteps(plan, sys, certGiven) {
  const there = (p) => existsSync(sys.path(p));
  const owner = `${plan.user.name}:${plan.user.name}`;
  // Install's own guard first: a missing KEK on an instance that has run is a refusal, not a new KEK.
  const refused = kekRefusal(sys, plan);
  if (refused) return { make: [], cert: certGiven ? "given" : there(plan.link.cert) ? "installed" : "missing", starts: false, refused };
  const make = [];
  if (plan.kek && !there(plan.kek.path)) make.push({ what: "KEK", path: plan.kek.path, mode: "0600", owner });
  // As install does: the key and CSR are made together when the key is absent (an old CSR is
  // replaced); with the key there, neither is made.
  if (!there(plan.link.key)) {
    make.push({ what: "link key", path: plan.link.key, mode: "0600", owner }, { what: "link CSR", path: plan.link.csr, mode: "0600", owner });
  }
  // "installed" means link.crt exists; whether it fits is the daemon's check, at install.
  const cert = certGiven ? "given" : there(plan.link.cert) ? "installed" : "missing";
  return { make, cert, starts: Boolean(plan.start && plan.unit && cert !== "missing"), refused: null };
}

/**
 * The human form of a dry-run plan: one line per action. Over an installed instance (`changes`
 * set) it is an upgrade, downgrade or reinstall of it, and only what changes is listed: the
 * settings kept from the installed instance, new directories and binaries, the `current` link,
 * and each config or unit file that changes, as a line diff.
 */
export function humanPlan(p) {
  const c = p.changes;
  const head = !c ? `Planned install service ${p.service} ${p.version}`
    : p.upgrade ? `Planned upgrade service ${p.service} ${p.upgrade.from} → ${p.upgrade.to}`
      : p.downgrade ? `Planned downgrade service ${p.service} ${p.downgrade.from} → ${p.downgrade.to}`
        : `Planned reinstall service ${p.service} ${p.version}`;
  const lines = [`${head} (${p.platform}, ${p.scope}) as instance ${p.instance}`,
    `  signature: key ${p.signature.keyId}, "${p.signature.trustedComment}"`];
  if (!c) {
    if (p.user) lines.push(`  user: create system user ${p.user.name} (${p.user.shell})`);
    for (const d of p.dirs) lines.push(`  dir ${d.mode} ${d.owner}:${d.group} ${d.path}`);
    for (const b of p.binaries) lines.push(`  binary ${b.mode} ${b.to}  sha256 ${b.sha256}`);
    lines.push(`  symlink ${p.symlink.path} -> ${p.symlink.target}`);
    for (const f of p.files) lines.push(`  file ${f.mode} ${f.owner}:${f.group} ${f.path}`);
    lines.push(`  listen ${p.listen}`);
    if (p.tunnel) lines.push(`  tunnel listener ${p.tunnel.listen} (mTLS; sidecars dial ${p.tunnel.name})`);
    if (p.control_plane) lines.push(`  control plane ${p.control_plane}`);
    if (p.link) lines.push(`  link listener ${p.link.listen} (mTLS; vbcdx-control calls it), control ${p.link.control_url}`);
  } else {
    for (const k of p.carried || []) lines.push(`  keep ${k.setting} ${k.value} (from the installed ${k.from})`);
    for (const d of p.dirs) if (c.dirs.includes(d.path)) lines.push(`  dir ${d.mode} ${d.owner}:${d.group} ${d.path}`);
    for (const b of p.binaries) if (c.binaries.includes(b.to)) lines.push(`  binary ${b.mode} ${b.to}  sha256 ${b.sha256}`);
    if (c.symlink) lines.push(`  symlink ${p.symlink.path} -> ${p.symlink.target}`);
    for (const f of c.files) {
      lines.push(f.diff ? `  change ${f.path}:` : `  file ${f.path} (new)`);
      for (const l of f.diff || []) lines.push(`      ${l}`);
    }
    if (!c.dirs.length && !c.binaries.length && !c.symlink && !c.files.length) lines.push("  no file changes");
  }
  if (p.enroll) lines.push(`  enroll with it, token from ${p.enroll.from}: ${p.enroll.argv.join(" ")}`);
  const ls = p.link_steps;
  for (const m of (ls && ls.make) || []) lines.push(`  make as ${p.user.name}: ${m.what} ${m.mode} ${m.owner} ${m.path}`);
  if (ls && ls.refused) lines.push(`  CONFLICT ${ls.refused} Install would refuse (exit 5).`);
  if (ls && ls.cert === "given") {
    lines.push(`  link certificate ${p.link.cert} (--service-cert), checked as ${p.user.name}${ls.starts ? " before the start" : ""}`);
  }
  // A server's unit starts only with its link certificate; the sidecar and control plane start as planned.
  const starts = ls ? ls.starts : p.start;
  const notStarted = ls && p.start && p.unit ? `, not started: no link certificate yet (${p.link.services_add}, then rerun with --service-cert)`
    : ", not started (--no-start)";
  if (p.unit && !c) lines.push(`  unit (${p.unit.manager}) ${p.unit.mode} ${p.unit.path}${starts ? ", then start it" : notStarted}`);
  else if (p.unit && p.start && !p.refused && (p.upgrade || p.downgrade || c.files.length || p.enroll)) {
    lines.push(`  restart ${p.unit.name}, then check it stays up`);
  } else if (!p.unit) lines.push(`  no unit (--service none); run it with: ${p.run}`);
  for (const f of p.kept || []) lines.push(`  keep ${f} (edited since install; this install would not change it)`);
  if (p.downgrade) {
    lines.push(p.refused ? `  REFUSED downgrade ${p.downgrade.from} → ${p.downgrade.to}: install would refuse (exit 5); --allow-downgrade installs the older version`
      : `  downgrade ${p.downgrade.from} → ${p.downgrade.to} (--allow-downgrade)`);
  }
  if (p.listen_in_use) lines.push(`  CONFLICT ${p.listen_in_use}: install would refuse. Free it or pick another address`);
  for (const b of p.backup_clashes || []) lines.push(`  CONFLICT ${b} already exists: --force would overwrite it, so install would refuse. Move or remove it first`);
  for (const f of p.conflicts || []) {
    lines.push(p.force ? `  replace ${f} (edited since install; saved first as ${f}.vbcdx-old, --force)`
      : `  CONFLICT ${f}: edited since install, and this install would change it. Install would refuse; --force replaces it after saving ${f}.vbcdx-old`);
  }
  if (p.lock && p.lock.state === "held") {
    lines.push(`  LOCK ${p.record}.lock is held by ${p.lock.pid ? `process ${p.lock.pid}${p.lock.command ? ` (${p.lock.command})` : ""}` : "another process"}, for ${Math.round(p.lock.ageMs / 1000)} s: install would refuse (exit 4) until it finishes`);
  }
  if (p.lock && p.lock.state === "stale") lines.push(`  lock ${p.record}.lock is stale (${p.lock.reason}): install takes it over`);
  for (const f of p.leftovers || []) lines.push(`  exists, not recorded: ${f} (left by an interrupted install; install adopts it)`);
  lines.push(`  record ${p.record}`);
  return lines.join("\n");
}
