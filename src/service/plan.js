// The install plan for a service (the service-CLI spec, Install and lifecycle): every user, directory, file,
// mode and unit `vbcdx install service` would create. `--dry-run --json` prints it; the real
// install applies exactly this plan, so what is reviewed is what is written.

import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { stringify as tomlStringify } from "smol-toml";
import { configError, conflictError } from "../errors.js";
import { SERVICES } from "./artifact.js";
import { compareVersions } from "./areas.js";

export const INSTANCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Each service's own system user (and group), roots and config file. A control plane co-hosted
// with a sidecar (rule 2) shares no user, socket, config or state with it. The control plane's
// follow vbcdx-core's reference unit (crates/vbcdx-control/systemd/vbcdx-control@.service) and
// its CONTROL schema defaults, except that the installer narrows the unit to AF_UNIX when no
// --tunnel is set (the reference allows AF_INET/AF_INET6 for the listener); it
// has no user (non-root) install in this version.
export const PROFILES = Object.freeze({
  sidecar: { user: "vbcdx", stateRoot: "/var/lib/vbcdx", confRoot: "/etc/vbcdx", runDir: "/run/vbcdx",
    config: "sidecar.toml", userScope: true },
  "control-plane": { user: "vbcdx-control", stateRoot: "/var/lib/vbcdx-control", confRoot: "/etc/vbcdx-control",
    runDir: "/run/vbcdx-control", config: "control.toml", userScope: false },
  // The Dispatch server in control-plane mode (the dispatch repo's docs): root only, its own user. Its one
  // recorded file is the unit's EnvironmentFile; the link key, CSR and certificate live in state.
  "dispatch-server": { user: "vbcdx-dispatch", stateRoot: "/var/lib/vbcdx-dispatch", confRoot: "/etc/vbcdx-dispatch",
    runDir: "/run/vbcdx-dispatch", config: "dispatch.env", userScope: false },
  // The Keyhole server in control-plane mode (the keyhole repo's README and docs/release.md): root only, its
  // own user, co-hosted with the control plane (its forward listener is loopback only). Its recorded
  // files are the EnvironmentFile (no secret) and the control CA (public); the link key, CSR,
  // certificate and the KEK live in state.
  "keyhole-server": { user: "vbcdx-keyhole", stateRoot: "/var/lib/vbcdx-keyhole", confRoot: "/etc/vbcdx-keyhole",
    runDir: "/run/vbcdx-keyhole", config: "keyhole.env", userScope: false },
});
/** The control CA's file name, in a keyhole-server instance's config directory. */
export const CONTROL_CA = "control-ca.pem";
/** A service this version can verify (artifact.js SERVICES) but has no install profile for. */
export const notInstallable = (service) =>
  conflictError(`${service} can't be installed, removed or managed by this version of the installer yet; nothing was fetched or written.`);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// The system unit's group and the config's socket_group: one value. A socket the daemon creates
// gets its process's group, so it never needs chown, which the unit's ~@privileged filter denies.
const SOCKET_GROUP = "vbcdx";
const digest = (text) => createHash("sha256").update(text).digest("hex");

/** A socket path as the daemon's `vbcdx+unix://` connection string (it percent-decodes the path). */
export const unixConn = (path) => `vbcdx+unix://${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Validate --control-plane, the sidecar's `control_plane` key, by the rules vbcdx-tunnel's
 * Endpoint::from_conn enforces (vbcdx-core crates/vbcdx-tunnel/src/client.rs): vbcdx+https,
 * auth=mtls, and exactly one of pin=sha256:<64 hex> or an absolute ca=. Nothing is fetched and
 * trusted, and there is no default. The rest of the grammar (timeout=, escapes) is left to the
 * daemon's own check, which install runs on the written file.
 */
export function parseControlPlane(value) {
  const usage = "--control-plane takes vbcdx+https://<host>:<port>?auth=mtls&pin=sha256:<64 hex> (or &ca=<absolute path> in place of pin=).";
  const m = /^vbcdx\+https:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})\?([^#]*)$/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw configError(usage);
  const params = new Map();
  for (const kv of m[3].split("&")) {
    const i = kv.indexOf("=");
    const k = i === -1 ? kv : kv.slice(0, i);
    if (params.has(k)) throw configError(`--control-plane gives ${k} twice.`);
    params.set(k, i === -1 ? "" : kv.slice(i + 1));
  }
  if (params.get("auth") !== "mtls") throw configError("--control-plane needs auth=mtls: the tunnel is mutual TLS only.");
  const pin = params.get("pin");
  const ca = params.get("ca");
  if (pin !== undefined && ca !== undefined) throw configError("--control-plane takes pin= or ca=, not both.");
  if (pin === undefined && ca === undefined) {
    throw configError("--control-plane needs pin=sha256:<64 hex> or ca=<absolute path>: a public CA is never trusted.");
  }
  if (pin !== undefined && !/^sha256:[0-9a-fA-F]{64}$/.test(pin)) {
    throw configError("--control-plane pin= must be sha256: followed by 64 hex digits (vbcdx-control tunnel pin prints it).");
  }
  if (ca !== undefined) {
    let path = null;
    try {
      path = decodeURIComponent(ca);
    } catch { /* refused below */ }
    if (!path || !path.startsWith("/")) throw configError("--control-plane ca= must be an absolute path.");
  }
  return value;
}

/**
 * Validate --tunnel <host>:<port> and --tunnel-name: the control plane's mTLS listener for
 * sidecars. tunnel_name is a CONTROL key of kind Id (vbcdx-config: A-Z a-z 0-9 _ . -, at most 128).
 */
export function parseTunnel(listen, name) {
  const m = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(listen);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw configError("--tunnel takes <host>:<port>, e.g. 0.0.0.0:8443.");
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw configError("--tunnel-name takes the name sidecars dial: A-Z a-z 0-9 _ . - (at most 128).");
  }
  return { conn: `vbcdx+https://${m[1]}:${m[2]}?auth=mtls`, name, text: `${m[1]}:${m[2]}` };
}

/** Validate and normalise --listen: a unix socket path, or host:port (loopback unless exposed). */
export function parseListen(value, { expose = false, acknowledged = false } = {}) {
  if (value.startsWith("unix:")) {
    const path = value.slice(5);
    if (!isAbsolute(path)) throw configError("--listen unix: needs an absolute socket path.");
    return { kind: "unix", path, text: value };
  }
  const m = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw configError("--listen takes unix:<path> or <host>:<port>.");
  if (!LOOPBACK.has(m[1])) {
    // Off loopback needs the flag AND its acknowledgement (and, daemon-side, a
    // matching enrolled intent). Either one alone is refused.
    if (!expose || !acknowledged) {
      throw configError("--listen on a non-loopback address needs --expose-on-network --i-understand-network-exposure.");
    }
  }
  return { kind: "tcp", host: m[1], port: Number(m[2]), text: value };
}

// The hardened unit: the installer baseline (NoNewPrivileges, ProtectSystem=strict, PrivateTmp,
// LimitCORE=0) plus systemd's standard sandboxing. A user unit keeps only what an unprivileged user manager can honour.
const SYSTEM_HARDENING = [
  "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes",
  "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes",
  "ProtectClock=yes", "ProtectHostname=yes", "ProtectProc=invisible", "ProcSubset=pid",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "RestrictNamespaces=yes", "RestrictRealtime=yes",
  "RestrictSUIDSGID=yes", "LockPersonality=yes", "MemoryDenyWriteExecute=yes", "SystemCallArchitectures=native",
  "SystemCallFilter=@system-service", "SystemCallFilter=~@privileged @resources",
  "CapabilityBoundingSet=", "AmbientCapabilities=", "LimitCORE=0",
];
const USER_HARDENING = [
  "NoNewPrivileges=yes", "LimitCORE=0", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "LockPersonality=yes", "SystemCallArchitectures=native",
];

// The daemon defaults --instance to "default" and, as a non-root user, looks for its files under
// ~/.vbcdx/services/<instance>: both are named, so the unit reads exactly the files install wrote.
const runArgs = (instance, confDir) => `run --instance ${instance} --instance-dir ${confDir}`;

// vbcdx-control's unit: core's reference with the sidecar's system hardening, but narrower in
// one line: unix sockets only unless it has a tunnel listener for sidecars (--tunnel), which
// needs AF_INET/AF_INET6 (the reference unit allows those always).
// A daemon that keeps failing ends in `failed` instead of restarting forever. The window must be
// longer than RestartSec x StartLimitBurst (2 s x 5): with systemd's default 10 s, five restarts
// 2 s apart never fit, so the limit never trips. These are [Unit] settings; [Service] ignores them.
// The cost: a sidecar that crash-loops for about 12 s (a control plane it can't reach at start,
// say) now stays `failed` until `systemctl reset-failed` (or a start/restart by hand), where it
// used to retry forever.
const START_LIMIT = ["StartLimitIntervalSec=60", "StartLimitBurst=5"];

function controlUnitText({ instance, exec, confDir, network }) {
  const args = `--instance ${instance} --instance-dir ${confDir}`;
  return [
    "# Written by vbcdx install service control-plane; vbcdx remove service control-plane takes it out.",
    "[Unit]",
    `Description=vbcdx control plane: auth and registry (instance ${instance})`,
    "After=network.target",
    ...START_LIMIT,
    "",
    "[Service]",
    "Type=exec",
    "User=vbcdx-control",
    "Group=vbcdx-control",
    `ExecStartPre=${exec} check ${args}`,
    `ExecStart=${exec} serve ${args}`,
    "Restart=on-failure",
    "RestartSec=2s",
    "UMask=0077",
    `StateDirectory=vbcdx-control/${instance}`, "StateDirectoryMode=0700",
    "RuntimeDirectory=vbcdx-control", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=yes",
    ...SYSTEM_HARDENING.map((l) => (l.startsWith("RestrictAddressFamilies=")
      ? `RestrictAddressFamilies=${network ? "AF_UNIX AF_INET AF_INET6" : "AF_UNIX"}` : l)),
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function unitText({ scope, instance, exec, confDir }) {
  const system = scope === "system";
  return [
    "# Written by vbcdx install service sidecar; vbcdx remove service sidecar takes it out.",
    "[Unit]",
    `Description=vbcdx sidecar (instance ${instance})`,
    ...(system ? ["After=network-online.target", "Wants=network-online.target"] : []),
    ...START_LIMIT,
    "",
    "[Service]",
    "Type=exec",
    ...(system ? ["User=vbcdx", `Group=${SOCKET_GROUP}`] : []),
    `ExecStart=${exec} ${runArgs(instance, confDir)}`,
    // SIGHUP makes the sidecar re-read its tunnel settings.
    "ExecReload=/bin/kill -HUP $MAINPID",
    "Restart=on-failure",
    "RestartSec=2s",
    // 0007 so the daemon's admin socket can be 0660 for group vbcdx; state is 0700 below.
    `UMask=${system ? "0007" : "0077"}`,
    ...(system
      ? [`StateDirectory=vbcdx/${instance}`, "StateDirectoryMode=0700",
        "RuntimeDirectory=vbcdx", "RuntimeDirectoryMode=0750", "RuntimeDirectoryPreserve=yes"]
      : ["RuntimeDirectory=vbcdx", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=yes"]),
    ...(system ? SYSTEM_HARDENING : USER_HARDENING),
    "",
    "[Install]",
    `WantedBy=${system ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
}

/** Where the installer keeps the record of what it installed: root uses its own passwd home. */
export const recordFile = (home) => join(home, ".vbcdx", "manifests", "installation.json");

/**
 * Every path an install of service/instance/version puts down, derived from those alone. The
 * plan is built from it, and every record read back is checked against it, so a record can
 * only ever name what install would have written.
 */
export function layout({ service, instance, version, scope, home, runtimeDir = null }) {
  const system = scope === "system";
  const P = PROFILES[service];
  if (!P) throw notInstallable(service);
  const lib = system ? "/usr/local/lib/vbcdx" : join(home, ".vbcdx", "lib");
  const serviceLib = join(lib, service);
  const versionDir = join(serviceLib, version);
  const stateRoot = system ? P.stateRoot : join(home, ".vbcdx", "services");
  const state = join(stateRoot, instance);
  const confRoot = system ? P.confRoot : null;
  const confDir = system ? join(confRoot, instance) : state;
  const unitName = `vbcdx-${service}-${instance}.service`;
  const unitDir = system ? "/etc/systemd/system" : join(home, ".config", "systemd", "user");
  const runDir = system ? P.runDir : runtimeDir ? join(runtimeDir, "vbcdx") : null;
  const root = { owner: "root", group: "root" };
  const svcOwner = system ? { owner: P.user, group: P.user } : { owner: "(you)", group: "(you)" };
  const libOwner = system ? root : svcOwner;
  // Each level install owns, top down, with its own mode: a parent never inherits a leaf's
  // mode, so the service's group can always traverse to its config and state.
  const dirs = [
    { path: lib, mode: "0755", ...libOwner },
    { path: serviceLib, mode: "0755", ...libOwner },
    { path: versionDir, mode: "0755", ...libOwner },
    { path: stateRoot, mode: system ? "0755" : "0700", ...(system ? root : svcOwner) },
    { path: state, mode: "0700", ...svcOwner },
    ...(system ? [{ path: confRoot, mode: "0755", ...root }, { path: confDir, mode: "0750", owner: "root", group: P.user }] : []),
  ];
  return {
    versionDir, serviceLib, current: join(serviceLib, "current"), state, confDir, dirs,
    config: join(confDir, P.config), unitName, unitPath: join(unitDir, unitName), runDir,
    socket: runDir ? join(runDir, `${instance}.sock`) : null,
    adminSocket: runDir ? join(runDir, `${instance}.admin.sock`) : null, record: recordFile(home),
    // A system sidecar's public record (see publicRecordText); a user install has none.
    publicRecord: system ? join(confDir, PUBLIC_RECORD) : null,
  };
}

/** The public record's file name, in a system instance's config directory. */
export const PUBLIC_RECORD = "install.json";

/**
 * A system sidecar's public record: the installed vbcdx-svc's path and sha256, in the instance's
 * config directory (0750 root:vbcdx), written 0640 root:vbcdx. The install record itself is in
 * root's home, which no one else can read; this is what lets a non-root member of group vbcdx run
 * `vbcdx config service …` against the system sidecar (its sockets are 0660 group vbcdx), with
 * the same hash check root gets. It names nothing secret.
 */
export function publicRecordText({ instance, version, svc }) {
  return `${JSON.stringify({ schema: 1, service: "sidecar", instance, version,
    vbcdx_svc: { path: svc.to, sha256: svc.sha256 } }, null, 2)}\n`;
}

// The control plane's plan: its admin socket, state and optional tunnel listener (CONTROL schema keys only).
function controlPlan({ instance, release, serviceManager, listen, start, host, P, tunnel }) {
  // No network listener before the tunnel: the admin socket is all it serves.
  if (listen) throw configError("--listen is for the sidecar; the control plane serves its admin socket only in this version.");
  const L = layout({ service: "control-plane", instance, version: release.version, scope: "system", home: host.home });
  const configText = tomlStringify({ admin_socket: L.adminSocket, state_dir: L.state,
    ...(tunnel ? { tunnel: tunnel.conn, tunnel_name: tunnel.name } : {}) }) + "\n";
  const exec = join(L.versionDir, SERVICES["control-plane"].daemon);
  const binaries = release.binaries.map((b) => {
    const out = { name: b.name, sha256: b.sha256, from: b.path, to: join(L.versionDir, b.name), mode: "0755" };
    Object.defineProperty(out, "bytes", { value: b.bytes, enumerable: false });
    return out;
  });
  const files = [{ path: L.config, mode: "0640", owner: "root", group: P.user, sha256: digest(configText), text: configText }];
  let unit = null;
  if (serviceManager === "systemd") {
    const text = controlUnitText({ instance, exec, confDir: L.confDir, network: Boolean(tunnel) });
    unit = { manager: "systemd", name: L.unitName, path: L.unitPath, mode: "0644", sha256: digest(text), text };
  }
  return {
    service: "control-plane", instance, scope: "system", version: release.version, package: release.package,
    platform: release.platform, signature: release.signature,
    user: { name: P.user, system: true, shell: "/usr/sbin/nologin" },
    dirs: L.dirs, binaries, symlink: { path: L.current, target: release.version }, files, unit,
    state_dir: L.state, config_dir: L.confDir, home: host.home,
    listen: `unix:${L.adminSocket}`, start: Boolean(start && unit),
    tunnel: tunnel ? { listen: tunnel.text, name: tunnel.name } : null,
    check: [exec, "check", "--instance", instance, "--instance-dir", L.confDir],
    run: unit ? null : `${exec} serve --instance ${instance} --instance-dir ${L.confDir}`,
    record: L.record,
  };
}

/**
 * Build the plan. `release` is verifyRelease's result; `host` describes where it runs.
 * @param {{service, instance, release, serviceManager, listen, start, host: {uid, home, runtimeDir}}} o
 */
export function buildPlan({ service, instance, release, serviceManager, listen, start, host, controlPlane = null,
  enroll = null, tunnel = null, dispatch = null, keyhole = null }) {
  if (!SERVICES[service]) throw configError(`Unknown service: ${service}.`);
  if (!PROFILES[service]) throw notInstallable(service);
  if (!INSTANCE_RE.test(instance)) throw configError("--instance is 1-32 of a-z, 0-9 and '-', starting with a letter or digit.");
  if (serviceManager === "launchd") throw conflictError("launchd units are not available in this version yet (Linux systemd and --service none are).");
  const scope = host.uid === 0 ? "system" : "user";
  if (!host.home || !isAbsolute(host.home)) throw configError("HOME must be set to an absolute path.");
  const P = PROFILES[service];
  if (scope === "user" && !P.userScope) {
    throw conflictError(`A ${service} install needs root in this version: it runs as the system user ${P.user}.`);
  }
  if (service === "control-plane") return controlPlan({ instance, release, serviceManager, listen, start, host, P, tunnel });
  if (service === "dispatch-server") return dispatchPlan({ instance, release, serviceManager, listen, start, host, P, dispatch });
  if (service === "keyhole-server") return keyholePlan({ instance, release, serviceManager, listen, start, host, P, keyhole });

  const L = layout({ service, instance, version: release.version, scope, home: host.home, runtimeDir: host.runtimeDir });
  // The admin socket is unix-only, so even a TCP listen needs the runtime directory.
  if (!L.socket) throw configError("A user install needs XDG_RUNTIME_DIR: the sidecar's sockets go in $XDG_RUNTIME_DIR/vbcdx.");
  // ProtectSystem=strict leaves the unit only its runtime directory to create a socket in.
  if (listen && listen.kind === "unix" && dirname(listen.path) !== L.runDir) {
    throw configError(`--listen unix: must be a socket directly in ${L.runDir}; the unit can create it nowhere else.`);
  }
  if (listen && listen.kind === "unix" && listen.path === L.adminSocket) {
    throw configError(`--listen unix: ${listen.path} is the instance's admin socket; pick another name.`);
  }
  // The daemon refuses expose_on_network = true without an enrolled intent, which a
  // standalone sidecar never has: refused here, before anything is written.
  if (listen && listen.kind === "tcp" && !LOOPBACK.has(listen.host)) {
    throw conflictError("A standalone sidecar serves loopback only: --listen on a network address needs an enrolled intent, which this version can't set up.");
  }
  const listenText = listen ? listen.text : `unix:${L.socket}`;

  // Only keys of the daemon's sidecar schema (the instance is the file's directory). A TCP
  // listen is in addition to the unix socket, which the CLI and admin commands use.
  const configText = tomlStringify({
    listen: unixConn(listen && listen.kind === "unix" ? listen.path : L.socket),
    admin_socket: L.adminSocket,
    ...(listen && listen.kind === "tcp" ? { tcp: `vbcdx+http://${listen.host}:${listen.port}` } : {}),
    // 0660 for group vbcdx with it, 0600 without (the daemon sets both sockets' modes from it).
    ...(scope === "system" ? { socket_group: SOCKET_GROUP } : {}),
    state_dir: L.state,
    // The tunnel to the control plane (--control-plane, already validated); unset, no tunnel.
    ...(controlPlane ? { control_plane: controlPlane } : {}),
  }) + "\n";
  // The unit runs its own version's binary: installing another version for another instance
  // (which moves `current`) never changes what this one runs.
  const exec = join(L.versionDir, SERVICES[service].daemon);
  const svcOwner = scope === "system" ? { owner: "vbcdx", group: "vbcdx" } : { owner: "(you)", group: "(you)" };
  const binaries = release.binaries.map((b) => {
    const out = { name: b.name, sha256: b.sha256, from: b.path, to: join(L.versionDir, b.name), mode: "0755" };
    // The verified bytes ride along, unseen by --json; install writes these, never `from`.
    Object.defineProperty(out, "bytes", { value: b.bytes, enumerable: false });
    return out;
  });
  const files = [{ path: L.config, mode: scope === "system" ? "0640" : "0600",
    ...(scope === "system" ? { owner: "root", group: "vbcdx" } : svcOwner), sha256: digest(configText), text: configText }];
  // After the config, so files[0] stays the config everywhere a record is read.
  if (scope === "system") {
    const svc = binaries.find((b) => b.name === "vbcdx-svc");
    const text = publicRecordText({ instance, version: release.version, svc });
    files.push({ path: L.publicRecord, mode: "0640", owner: "root", group: "vbcdx", sha256: digest(text), text });
  }

  let unit = null;
  if (serviceManager === "systemd") {
    const text = unitText({ scope, instance, exec, confDir: L.confDir });
    unit = { manager: scope === "system" ? "systemd" : "systemd --user", name: L.unitName, path: L.unitPath,
      mode: "0644", sha256: digest(text), text };
  }
  return {
    service, instance, scope, version: release.version, package: release.package, platform: release.platform,
    signature: release.signature,
    user: scope === "system" ? { name: "vbcdx", system: true, shell: "/usr/sbin/nologin" } : null,
    dirs: L.dirs, binaries, symlink: { path: L.current, target: release.version }, files, unit,
    state_dir: L.state, config_dir: L.confDir, home: host.home,
    listen: listenText, start: Boolean(start && unit),
    // Run by install once the config is written, before the unit: the daemon's own parser.
    check: [exec, "check", "--instance", instance, "--instance-dir", L.confDir],
    control_plane: controlPlane,
    // With an enrollment token: redeemed after check, before the unit. The token goes on its
    // stdin only (`from` says where install reads it); it is never in the plan.
    enroll: enroll && controlPlane
      ? { from: enroll, argv: [exec, "enroll", "--instance", instance, "--instance-dir", L.confDir, "--token-stdin"] } : null,
    run: unit ? null : `${exec} ${runArgs(instance, L.confDir)}`,
    record: L.record,
  };
}

// --- dispatch-server ----------------------------------------------------------------------------

const HOSTPORT = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;
const portOk = (p) => Number(p) >= 1 && Number(p) <= 65535;
const isLoopbackHost = (h) => LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);

/**
 * Validate dispatch-server's control-plane-mode flags by the rules Dispatch's own config enforces
 * (dispatch internal/config: VBCDX_LINK_ADDR host:port, VBCDX_CONTROL_URL https://host:port,
 * PUBLIC_URL scheme://host[:port], https unless loopback). Values only: nothing is dialled.
 */
export function parseDispatch({ linkListen, controlUrl, publicUrl }, web) {
  // Each value becomes one line of dispatch.env: a control character (new URL() would silently
  // drop a tab, CR or LF, letting a value add a line), a space, or a bare ? or # is refused.
  for (const [flag, v] of [["--link-listen", linkListen], ["--control-url", controlUrl], ["--public-url", publicUrl]]) {
    if (typeof v === "string" && /[\x00-\x20\x7f?#]/.test(v)) throw configError(`${flag} has a control character, a space, ? or #.`);
  }
  if (!linkListen || !controlUrl) {
    throw configError("dispatch-server runs in control-plane mode: it needs --link-listen <host>:<port> (where vbcdx-control reaches it) "
      + "and --control-url https://<control host>:<port> (the control plane's tunnel listener).");
  }
  const l = HOSTPORT.exec(linkListen);
  if (!l || !portOk(l[2])) throw configError("--link-listen takes <host>:<port>.");
  let cu;
  try {
    cu = new URL(controlUrl);
  } catch {
    cu = null;
  }
  if (!cu || cu.protocol !== "https:" || !cu.port || cu.username || cu.password || (cu.pathname !== "/" && cu.pathname !== "")
    || cu.search || cu.hash || controlUrl.endsWith("/")) {
    throw configError("--control-url takes https://<host>:<port>, with no path, query or credentials.");
  }
  const pub = publicUrl || `http://${web.host}:${web.port}`;
  let pu;
  try {
    pu = new URL(pub);
  } catch {
    pu = null;
  }
  if (!pu || !["http:", "https:"].includes(pu.protocol) || pu.username || pu.password || (pu.pathname !== "/" && pu.pathname !== "")
    || pu.search || pu.hash) {
    throw configError("--public-url takes http(s)://<host>[:<port>], with no path.");
  }
  if (pu.protocol === "http:" && !isLoopbackHost(pu.hostname)) throw configError("--public-url must be https unless its host is loopback.");
  // What is written is the URL as parsed (scheme, host, port), never the raw text.
  return { linkListen, controlUrl: `${cu.protocol}//${cu.host}`, publicUrl: `${pu.protocol}//${pu.host}` };
}

function dispatchUnitText({ instance, exec, confDir, env }) {
  return [
    "# Written by vbcdx install service dispatch-server; vbcdx remove service dispatch-server takes it out.",
    "[Unit]",
    `Description=Dispatch server, control-plane mode (instance ${instance})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    "User=vbcdx-dispatch",
    "Group=vbcdx-dispatch",
    `EnvironmentFile=${env}`,
    // The same check install ran: the settings, the link certificate and key.
    `ExecStartPre=${exec} check`,
    `ExecStart=${exec} serve`,
    "Restart=on-failure",
    "RestartSec=2s",
    "UMask=0077",
    `StateDirectory=vbcdx-dispatch/${instance}`, "StateDirectoryMode=0700",
    // The sidecar's system hardening, with one difference: the Go runtime raises its own open-file
    // limit at start (setrlimit, in @resources), so @resources is not denied, and a denied call
    // returns EPERM instead of killing the process.
    ...SYSTEM_HARDENING.map((l) => (l === "SystemCallFilter=~@privileged @resources" ? "SystemCallFilter=~@privileged" : l)),
    "SystemCallErrorNumber=EPERM",
    `# ${confDir} holds dispatch.env (0640 root:vbcdx-dispatch); the link key and certificate are in the state directory.`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

// dispatch-server's plan: the env file (no secret in it), the unit, and the link credential's
// paths. The key and CSR are made at install time as the service user; the certificate comes
// from `vbcdx-control services add dispatch` (--service-cert) and starts the unit.
function dispatchPlan({ instance, release, serviceManager, listen, start, host, P, dispatch }) {
  const web = listen || parseListen("127.0.0.1:8080");
  if (web.kind !== "tcp") throw configError("--listen for dispatch-server takes <host>:<port> (its web app and API).");
  const d = parseDispatch(dispatch || {}, web);
  const L = layout({ service: "dispatch-server", instance, version: release.version, scope: "system", home: host.home });
  const link = { key: join(L.state, "link.key"), csr: join(L.state, "link.csr"), cert: join(L.state, "link.crt") };
  const configText = [
    "# Written by vbcdx install service dispatch-server; vbcdx remove service dispatch-server takes it out.",
    "# systemd's EnvironmentFile= for the unit, and `dispatch check --env-file` reads it the same way.",
    `LISTEN_ADDR=${web.host}:${web.port}`,
    `PUBLIC_URL=${d.publicUrl}`,
    `DATA_DIR=${L.state}`,
    `VBCDX_LINK_ADDR=${d.linkListen}`,
    `VBCDX_CONTROL_URL=${d.controlUrl}`,
    `VBCDX_SERVICE_CERT=${link.cert}`,
    `VBCDX_SERVICE_KEY=${link.key}`,
    "",
  ].join("\n");
  const exec = join(L.versionDir, SERVICES["dispatch-server"].daemon);
  const binaries = release.binaries.map((b) => {
    const out = { name: b.name, sha256: b.sha256, from: b.path, to: join(L.versionDir, b.name), mode: "0755" };
    Object.defineProperty(out, "bytes", { value: b.bytes, enumerable: false });
    return out;
  });
  const files = [{ path: L.config, mode: "0640", owner: "root", group: P.user, sha256: digest(configText), text: configText }];
  let unit = null;
  if (serviceManager === "systemd") {
    const text = dispatchUnitText({ instance, exec, confDir: L.confDir, env: L.config });
    unit = { manager: "systemd", name: L.unitName, path: L.unitPath, mode: "0644", sha256: digest(text), text };
  }
  const [lh, lp] = [HOSTPORT.exec(d.linkListen)[1], HOSTPORT.exec(d.linkListen)[2]];
  const dialHost = ["0.0.0.0", "[::]"].includes(lh) ? "<this host's address>" : lh;
  return {
    service: "dispatch-server", instance, scope: "system", version: release.version, package: release.package,
    platform: release.platform, signature: release.signature,
    user: { name: P.user, system: true, shell: "/usr/sbin/nologin" },
    dirs: L.dirs, binaries, symlink: { path: L.current, target: release.version }, files, unit,
    state_dir: L.state, config_dir: L.confDir, home: host.home,
    listen: web.text, start: Boolean(start && unit),
    link: { ...link, listen: d.linkListen, control_url: d.controlUrl,
      // Dispatch serves the link under /vbcdx/v1 (its LinkPrefix); vbcdx-control forwards to <url>/<tail>.
      services_add: `vbcdx-control services add dispatch --url https://${dialHost}:${lp}/vbcdx/v1 --csr ${link.csr} --cert-out dispatch.crt` },
    csr: [exec, "link", "csr", "--key-out", link.key, "--csr-out", link.csr],
    check: [exec, "check", "--env-file", L.config],
    run: unit ? null : `${exec} serve, as ${P.user}, with ${L.config}'s settings in its environment`,
    record: L.record,
  };
}

// --- keyhole-server -----------------------------------------------------------------------------

/**
 * Validate keyhole-server's control-plane-mode flags by the rules Keyhole's own config enforces (keyhole
 * internal/config: SERVICE_LISTEN_ADDR a loopback host:port, CONTROL_URL https://HOST[:PORT],
 * PUBLIC_URL scheme://host[:port], https unless loopback), plus D-b's: each value is one env line
 * (no control character, space, ? or #), and what is written is the URL as parsed. The forward
 * listener is loopback only: vbcdx-control on the same host is its only caller. `controlCa` is the
 * PEM text (readControlCA), required. Values only: nothing is dialled.
 */
export function parseKeyhole({ linkListen, controlUrl, publicUrl, controlCa }, web) {
  for (const [flag, v] of [["--link-listen", linkListen], ["--control-url", controlUrl], ["--public-url", publicUrl]]) {
    if (typeof v === "string" && /[\x00-\x20\x7f?#]/.test(v)) throw configError(`${flag} has a control character, a space, ? or #.`);
  }
  if (!linkListen || !controlUrl || !controlCa) {
    throw configError("keyhole-server runs in control-plane mode: it needs --link-listen 127.0.0.1:<port> (where vbcdx-control on this host "
      + "reaches it), --control-url https://<control host>:<port> (the control plane's tunnel listener) and --control-ca <file> "
      + "(the control CA certificate, PEM).");
  }
  const l = HOSTPORT.exec(linkListen);
  if (!l || !portOk(l[2])) throw configError("--link-listen takes 127.0.0.1:<port>.");
  const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
  if (!(new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`).test(l[1]) || l[1] === "[::1]")) {
    throw configError("--link-listen must be a loopback address (127.0.0.1:<port> or [::1]:<port>): Keyhole's forward listener "
      + "serves vbcdx-control on this host only.");
  }
  // The web listener and the forward listener can't share an address: one of them would fail to
  // bind. A wildcard or localhost --listen holds the port on every loopback address too.
  if (Number(l[2]) === Number(web.port) && (l[1] === web.host || ["0.0.0.0", "[::]", "localhost"].includes(web.host))) {
    throw configError(`--link-listen ${linkListen} is the address --listen ${web.host}:${web.port} serves the web app on: give each its own port.`);
  }
  let cu;
  try {
    cu = new URL(controlUrl);
  } catch {
    cu = null;
  }
  if (!cu || cu.protocol !== "https:" || !cu.port || cu.username || cu.password || (cu.pathname !== "/" && cu.pathname !== "")
    || cu.search || cu.hash || controlUrl.endsWith("/")) {
    throw configError("--control-url takes https://<host>:<port>, with no path, query or credentials.");
  }
  const pub = publicUrl || `http://${web.host}:${web.port}`;
  let pu;
  try {
    pu = new URL(pub);
  } catch {
    pu = null;
  }
  if (!pu || !["http:", "https:"].includes(pu.protocol) || pu.username || pu.password || (pu.pathname !== "/" && pu.pathname !== "")
    || pu.search || pu.hash) {
    throw configError("--public-url takes http(s)://<host>[:<port>], with no path.");
  }
  if (pu.protocol === "http:" && !isLoopbackHost(pu.hostname)) throw configError("--public-url must be https unless its host is loopback.");
  return { linkListen, controlUrl: `${cu.protocol}//${cu.host}`, publicUrl: `${pu.protocol}//${pu.host}`, controlCa };
}

function keyholeUnitText({ instance, exec, confDir, env }) {
  return [
    "# Written by vbcdx install service keyhole-server; vbcdx remove service keyhole-server takes it out.",
    "[Unit]",
    `Description=Keyhole server, control-plane mode (instance ${instance})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=exec",
    "User=vbcdx-keyhole",
    "Group=vbcdx-keyhole",
    `EnvironmentFile=${env}`,
    // The same check install ran: the settings, the link certificate and key, the control CA, the KEK.
    `ExecStartPre=${exec} check`,
    `ExecStart=${exec} serve`,
    "Restart=on-failure",
    "RestartSec=2s",
    // keyhole sets umask 077 itself too; the unit does not rely on it.
    "UMask=0077",
    `StateDirectory=vbcdx-keyhole/${instance}`, "StateDirectoryMode=0700",
    // dispatch-server's: the sidecar's system hardening minus @resources (the Go runtime raises its
    // own open-file limit at start), and a denied call returns EPERM instead of killing the process.
    ...SYSTEM_HARDENING.map((l) => (l === "SystemCallFilter=~@privileged @resources" ? "SystemCallFilter=~@privileged" : l)),
    "SystemCallErrorNumber=EPERM",
    `# ${confDir} holds keyhole.env and ${CONTROL_CA} (0640 root:vbcdx-keyhole); the link key and certificate and the KEK are in the state directory.`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

// keyhole-server's plan: the env file and the control CA (no secret in either), the unit, and the
// paths of the link credential and the KEK. The key, CSR and KEK are made at install time as the
// service user (the KEK once: never again, since it seals every stored value); the certificate
// comes from `vbcdx-control services add keyhole` (--service-cert) and starts the unit.
// The first @vbcdx/keyhole with `keyhole check` and `--env-file`, which the unit's
// ExecStartPre, install's gate and doctor run.
export const KEYHOLE_MIN = "0.1.0-dev.2";

function keyholePlan({ instance, release, serviceManager, listen, start, host, P, keyhole }) {
  if (compareVersions(release.version, KEYHOLE_MIN) < 0) {
    throw conflictError(`keyhole-server needs @vbcdx/keyhole ${KEYHOLE_MIN} or newer (its \`keyhole check\` and --env-file), `
      + `not ${release.version}. Nothing was changed. Install --version ${KEYHOLE_MIN} or later.`);
  }
  const web = listen || parseListen("127.0.0.1:8080");
  if (web.kind !== "tcp") throw configError("--listen for keyhole-server takes <host>:<port> (its web app and API).");
  const k = parseKeyhole(keyhole || {}, web);
  const L = layout({ service: "keyhole-server", instance, version: release.version, scope: "system", home: host.home });
  const link = { key: join(L.state, "link.key"), csr: join(L.state, "link.csr"), cert: join(L.state, "link.crt"),
    kek: join(L.state, "kek") };
  const caPath = join(L.confDir, CONTROL_CA);
  const configText = [
    "# Written by vbcdx install service keyhole-server; vbcdx remove service keyhole-server takes it out.",
    "# systemd's EnvironmentFile= for the unit; `keyhole --env-file <this file> <command>` reads it the same way.",
    `LISTEN_ADDR=${web.host}:${web.port}`,
    `PUBLIC_URL=${k.publicUrl}`,
    `DATA_DIR=${L.state}`,
    "AUTH_MODE=local",
    `SERVICE_LISTEN_ADDR=${k.linkListen}`,
    `SERVICE_CERT_FILE=${link.cert}`,
    `SERVICE_KEY_FILE=${link.key}`,
    `CONTROL_CA_FILE=${caPath}`,
    `CONTROL_URL=${k.controlUrl}`,
    `KEK_FILE=${link.kek}`,
    "",
  ].join("\n");
  const exec = join(L.versionDir, SERVICES["keyhole-server"].daemon);
  const binaries = release.binaries.map((b) => {
    const out = { name: b.name, sha256: b.sha256, from: b.path, to: join(L.versionDir, b.name), mode: "0755" };
    Object.defineProperty(out, "bytes", { value: b.bytes, enumerable: false });
    return out;
  });
  const files = [
    { path: L.config, mode: "0640", owner: "root", group: P.user, sha256: digest(configText), text: configText },
    // After the config, so files[0] stays the config everywhere a record is read.
    { path: caPath, mode: "0640", owner: "root", group: P.user, sha256: digest(k.controlCa), text: k.controlCa },
  ];
  let unit = null;
  if (serviceManager === "systemd") {
    const text = keyholeUnitText({ instance, exec, confDir: L.confDir, env: L.config });
    unit = { manager: "systemd", name: L.unitName, path: L.unitPath, mode: "0644", sha256: digest(text), text };
  }
  return {
    service: "keyhole-server", instance, scope: "system", version: release.version, package: release.package,
    platform: release.platform, signature: release.signature,
    user: { name: P.user, system: true, shell: "/usr/sbin/nologin" },
    dirs: L.dirs, binaries, symlink: { path: L.current, target: release.version }, files, unit,
    state_dir: L.state, config_dir: L.confDir, home: host.home,
    listen: web.text, start: Boolean(start && unit),
    link: { key: link.key, csr: link.csr, cert: link.cert, listen: k.linkListen, control_url: k.controlUrl, control_ca: caPath,
      // Keyhole serves the forwarded routes at its root (POST /orgs/{org}/resolve); vbcdx-control
      // forwards to <url>/<tail>, so the URL has no path.
      services_add: `vbcdx-control services add keyhole --url https://${k.linkListen} --csr ${link.csr} --cert-out keyhole.crt` },
    // `db`: Keyhole's SQLite file (DATA_DIR/keyhole.db). With it, or the link key, present the
    // instance has run, so a missing KEK is never replaced (apply.js serverLink).
    kek: { path: link.kek, db: join(L.state, "keyhole.db"), argv: [exec, "kek", "generate", "--out", link.kek] },
    csr: [exec, "service", "csr", "--key-out", link.key, "--csr-out", link.csr],
    check: [exec, "--env-file", L.config, "check"],
    run: unit ? null : `${exec} serve, as ${P.user}, with ${L.config}'s settings in its environment`,
    record: L.record,
  };
}
