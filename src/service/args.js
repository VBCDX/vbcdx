// The service command grammar (the service-CLI spec, Install and lifecycle):
//
//   vbcdx install service sidecar|control-plane [--instance <i>] [--version <semver>|--from <dir>]
//         [--service systemd|launchd|none] [--listen unix:<path>|<host>:<port>]
//         [--expose-on-network --i-understand-network-exposure] [--no-start] [--force] [--allow-downgrade]
//         [--dry-run] [--json]
//         (--force: replace a config or unit file edited since install; the edited copy is saved
//          as <file>.vbcdx-old first. Without it, install refuses to change an edited file.)
//         (Over an installed instance, a setting left out is kept from what is installed:
//          --listen, --service none, --control-plane, --tunnel/--tunnel-name. --no-control-plane
//          and --no-tunnel clear one. --allow-downgrade installs a version older than the
//          instance's; without it that is refused.)
//   vbcdx remove  service sidecar|control-plane [--instance <i>] [--wipe] [--dry-run] [--json]
//   vbcdx list    services [--json]
//   vbcdx doctor  --service sidecar|control-plane [--instance <i>] [--json]
//   vbcdx service sidecar|control-plane status|start|stop|restart|logs [--follow] [--instance <i>]
//   (control-plane: root only, and no --listen, in this version)
//   sidecar only:       [--control-plane <vbcdx+https conn> | --no-control-plane]
//                       [--enroll-token-file <0600 file> | --enroll-token-stdin]
//   control-plane only: [--tunnel <host>:<port> --tunnel-name <name sidecars dial> | --no-tunnel]
//   vbcdx config  service sidecar|keyhole|dispatch [--instance <i>] …   (the sidecar instance's
//         vbcdx-svc gets `<service> …`; every option, --instance too, comes after the service name)
//
// Options take `--key value` (as the spec writes them) or `--key=value`.

import { configError } from "../errors.js";
import { shownOption, shownWord, unexpectedArgument } from "../shown.js";
import { SEMVER, SERVICES } from "./artifact.js";
import { PROFILES, notInstallable } from "./plan.js";

const VALUED = new Set(["--instance", "--version", "--from", "--service", "--listen", "--control-plane", "--tunnel",
  "--tunnel-name", "--enroll-token-file", "--link-listen", "--control-url", "--public-url", "--service-cert", "--control-ca"]);
// Each command's options, as the parser allows them. `vbcdx --help` documents every one of them
// (test/help-surface.test.js compares the two, so a new option can't land without its help line).
export const INSTALL_COMMON = Object.freeze(["--instance", "--version", "--from", "--service", "--listen",
  "--expose-on-network", "--i-understand-network-exposure", "--no-start", "--force", "--allow-downgrade", "--dry-run", "--json"]);
export const SIDECAR_ONLY = Object.freeze(["--control-plane", "--no-control-plane", "--enroll-token-file", "--enroll-token-stdin"]);
export const CONTROL_ONLY = Object.freeze(["--tunnel", "--tunnel-name", "--no-tunnel"]);
// The control-plane-mode server flags: dispatch-server's, and keyhole-server's (which also takes --control-ca).
export const DISPATCH_ONLY = Object.freeze(["--link-listen", "--control-url", "--public-url", "--service-cert"]);
export const KEYHOLE_ONLY = Object.freeze(["--control-ca"]);
export const REMOVE_OPTIONS = Object.freeze(["--instance", "--wipe", "--dry-run", "--json"]);
export const LIST_OPTIONS = Object.freeze(["--json"]);
export const DOCTOR_OPTIONS = Object.freeze(["--service", "--instance", "--json"]);
export const SERVICE_OPTIONS = Object.freeze(["--instance", "--follow"]);
const SERVER = new Set(["dispatch-server", "keyhole-server"]);
export const ACTIONS = Object.freeze(["status", "start", "stop", "restart", "logs"]);

/** Is this argv a service command? (Everything else stays with the agent/skill/tool parser.) */
export function isServiceCommand(argv) {
  const [a, b] = argv;
  return ((a === "install" || a === "remove" || a === "config") && b === "service")
    || (a === "list" && b === "services")
    || (a === "doctor" && argv.some((x) => x === "--service" || x.startsWith("--service=")))
    || a === "service";
}

// `offset` is the 1-based position of rest[0] after `vbcdx`, so an error can name where a stray
// argument was without quoting it.
function options(rest, allowed, offset) {
  const opts = { positional: [], positionAt: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      opts.positional.push(arg);
      opts.positionAt.push(offset + i);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (!allowed.has(key)) throw configError(`Unknown or misplaced option: ${shownOption(key)}.`);
    if (VALUED.has(key)) {
      const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) throw configError(`${key} needs a value.`);
      if (opts[key] !== undefined) throw configError(`${key} is given twice.`);
      opts[key] = value;
    } else {
      if (eq !== -1) throw configError(`${key} takes no value.`);
      opts[key] = true;
    }
  }
  return opts;
}

// The command areas of the sidecar's vbcdx-svc besides its own (`vbcdx config service
// keyhole|dispatch …`). They are not things to install: the sidecar has no per-service
// modules and forwards each service's calls; the servers are keyhole-server and dispatch-server.
export const CONFIG_AREAS = Object.freeze(["keyhole", "dispatch"]);

function oneService(name, what) {
  if (!name) throw configError(`${what} needs a service: sidecar, control-plane, dispatch-server or keyhole-server.`);
  if (CONFIG_AREAS.includes(name)) {
    throw configError(`${name} is not a service of its own: the sidecar carries its calls with no module. `
      + `The server is ${name}-server (vbcdx ${what} ${name}-server).`);
  }
  if (!SERVICES[name]) throw configError(`Unknown service: ${shownWord(name)}.`);
  // A service this version verifies but has no install profile for: every command refuses it here.
  if (SERVICES[name] && !PROFILES[name]) throw notInstallable(name);
  return name;
}

export function parseServiceArgs(argv) {
  const [cmd, second, ...rest] = argv;
  if (cmd === "install") {
    const o = options(rest, new Set([...INSTALL_COMMON, ...SIDECAR_ONLY, ...CONTROL_ONLY, ...DISPATCH_ONLY, ...KEYHOLE_ONLY]), 3);
    const [name, ...extra] = o.positional;
    if (extra.length) throw configError(unexpectedArgument(o.positionAt[1]));
    // Plain keyhole or dispatch: name the server before judging any flag against it.
    if (CONFIG_AREAS.includes(name)) oneService(name, "install service");
    if (o["--version"] && o["--from"]) throw configError("Use --version or --from, not both.");
    // It goes to npm as <package>@<version>: a range, tag or URL there would fetch something else.
    if (o["--version"] && !SEMVER.test(o["--version"])) throw configError("--version takes an exact version (x.y.z), not a range or tag.");
    const manager = o["--service"] || "systemd";
    if (!["systemd", "launchd", "none"].includes(manager)) throw configError("--service takes systemd, launchd or none.");
    if (o["--i-understand-network-exposure"] && !o["--expose-on-network"]) {
      throw configError("--i-understand-network-exposure goes with --expose-on-network.");
    }
    if (name === "control-plane") {
      for (const k of SIDECAR_ONLY) if (o[k] !== undefined) throw configError(`${k} is for the sidecar; the control plane is what it connects to.`);
    } else if (SERVER.has(name)) {
      for (const k of [...SIDECAR_ONLY, ...CONTROL_ONLY]) {
        if (o[k] !== undefined) throw configError(`${k} is not a ${name} flag; it reaches the control plane with --control-url.`);
      }
    } else {
      for (const k of CONTROL_ONLY) if (o[k] !== undefined) throw configError(`${k} is for the control plane; a sidecar dials one with --control-plane.`);
    }
    if (!SERVER.has(name)) {
      for (const k of DISPATCH_ONLY) if (o[k] !== undefined) throw configError(`${k} is for dispatch-server and keyhole-server.`);
    }
    if (name !== "keyhole-server") {
      for (const k of KEYHOLE_ONLY) if (o[k] !== undefined) throw configError(`${k} is for keyhole-server.`);
    }
    if (o["--enroll-token-file"] && o["--enroll-token-stdin"]) throw configError("Give the enrollment token once: --enroll-token-file or --enroll-token-stdin.");
    if ((o["--enroll-token-file"] || o["--enroll-token-stdin"]) && !o["--control-plane"]) {
      throw configError("An enrollment token needs --control-plane: the sidecar enrolls with that control plane.");
    }
    if (o["--no-control-plane"] && (o["--control-plane"] || o["--enroll-token-file"] || o["--enroll-token-stdin"])) {
      throw configError("--no-control-plane clears the sidecar's control plane: it can't go with --control-plane or an enrollment token.");
    }
    if (o["--no-tunnel"] && (o["--tunnel"] || o["--tunnel-name"])) {
      throw configError("--no-tunnel clears the control plane's tunnel listener: it can't go with --tunnel or --tunnel-name.");
    }
    if (Boolean(o["--tunnel"]) !== Boolean(o["--tunnel-name"])) {
      throw configError("--tunnel and --tunnel-name go together: the name is what sidecars dial, and the tunnel certificate's name.");
    }
    return { command: "install", service: oneService(name, "install service"), instance: o["--instance"] || "default",
      version: o["--version"] || null, from: o["--from"] || null, serviceManager: manager, serviceManagerGiven: Boolean(o["--service"]),
      listen: o["--listen"] || null,
      expose: Boolean(o["--expose-on-network"]), acknowledged: Boolean(o["--i-understand-network-exposure"]),
      start: !o["--no-start"], force: Boolean(o["--force"]), allowDowngrade: Boolean(o["--allow-downgrade"]),
      dryRun: Boolean(o["--dry-run"]), json: Boolean(o["--json"]),
      controlPlane: o["--control-plane"] || null, noControlPlane: Boolean(o["--no-control-plane"]),
      tunnel: o["--tunnel"] || null, tunnelName: o["--tunnel-name"] || null, noTunnel: Boolean(o["--no-tunnel"]),
      enrollTokenFile: o["--enroll-token-file"] || null, enrollTokenStdin: Boolean(o["--enroll-token-stdin"]),
      linkListen: o["--link-listen"] || null, controlUrl: o["--control-url"] || null, publicUrl: o["--public-url"] || null,
      serviceCert: o["--service-cert"] || null, controlCa: o["--control-ca"] || null };
  }
  if (cmd === "remove") {
    const o = options(rest, new Set(REMOVE_OPTIONS), 3);
    if (o.positional.length > 1) throw configError(unexpectedArgument(o.positionAt[1]));
    const name = oneService(o.positional[0], "remove service");
    return { command: "remove", service: name, instance: o["--instance"] || "default",
      wipe: Boolean(o["--wipe"]), dryRun: Boolean(o["--dry-run"]), json: Boolean(o["--json"]) };
  }
  if (cmd === "list") {
    const o = options(rest, new Set(LIST_OPTIONS), 3);
    if (o.positional.length) throw configError("list services takes no arguments.");
    return { command: "list", json: Boolean(o["--json"]) };
  }
  if (cmd === "doctor") {
    const o = options([second, ...rest].filter((x) => x !== undefined), new Set(DOCTOR_OPTIONS), 2);
    if (o.positional.length) throw configError(unexpectedArgument(o.positionAt[0]));
    return { command: "doctor", service: oneService(o["--service"], "doctor --service"),
      instance: o["--instance"] || "default", json: Boolean(o["--json"]) };
  }
  if (cmd === "service") {
    const o = options(rest, new Set(SERVICE_OPTIONS), 3);
    const [action, ...extra] = o.positional;
    if (!ACTIONS.includes(action)) throw configError(`service ${second === undefined ? "<service>" : shownWord(second)} needs one of: ${ACTIONS.join(", ")}.`);
    if (extra.length) throw configError(unexpectedArgument(o.positionAt[1]));
    if (o["--follow"] && action !== "logs") throw configError("--follow goes with logs.");
    return { command: "service", service: oneService(second, "service"), action,
      instance: o["--instance"] || "default", follow: Boolean(o["--follow"]) };
  }
  // config service <svc> …: vbcdx-svc gets `<svc> …`, the service name and everything after it.
  // The `config service` prefix is the installer's own and is never passed on.
  if (rest[0] && rest[0].startsWith("-")) {
    throw configError(`config service takes the service name first: vbcdx config service sidecar [--instance <i>] <command…> (not ${shownOption(rest[0])} before it).`);
  }
  // keyhole and dispatch are vbcdx-svc command areas here, not services to install.
  const area = rest[0] === "sidecar" || CONFIG_AREAS.includes(rest[0]) ? rest[0] : null;
  return { command: "config", service: area || oneService(rest[0], "config service"), passthrough: rest };
}
