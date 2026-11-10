// Over an installed instance, install keeps every setting the user leaves out: an upgrade
// (`install service … --version <new>`, nothing else) runs with the same listen, control plane,
// tunnel and service manager as before. A flag that is given overrides only its own setting;
// --no-control-plane and --no-tunnel clear one. Nothing is ever dropped because a flag was left
// out.
//
// Where each setting comes from:
//   --listen                    the record (the sidecar's listen, as install wrote it);
//   --service none              the record (no unit recorded);
//   --control-plane             the installed sidecar.toml (`control_plane`);
//   --tunnel / --tunnel-name    the installed control.toml (`tunnel`, `tunnel_name`);
//   dispatch-server: --listen   the record; --link-listen, --control-url and --public-url from the
//                               installed dispatch.env (VBCDX_LINK_ADDR, VBCDX_CONTROL_URL,
//                               PUBLIC_URL; a PUBLIC_URL that is only the default for the recorded
//                               listen is not carried, so a new --listen gets its own default).
//   keyhole-server: the same, from the installed keyhole.env (SERVICE_LISTEN_ADDR, CONTROL_URL,
//                               PUBLIC_URL); --control-ca from the installed control-ca.pem.
// A config file is read only when one of its settings is needed. One that is missing or can't be
// parsed refuses the install (exit 5): guessing would drop the setting it held.

import { lstatSync, readFileSync } from "node:fs";
import { parse as tomlParse } from "smol-toml";
import { conflictError } from "../errors.js";
import { layout } from "./plan.js";
import { readPemCerts } from "./pem.js";
import { safeLine } from "./apply.js";

// The loopback listens parseListen accepts without an exposure acknowledgement (plan.js LOOPBACK).
const LOOPBACK_LISTEN = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

// parseTunnel's conn form, back to the --tunnel text: vbcdx+https://<host>:<port>?auth=mtls.
const TUNNEL_CONN = /^vbcdx\+https:\/\/((?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5})\?auth=mtls$/;

/**
 * The install options with the installed instance's settings filled in, and what was carried:
 * [{ setting, value, from }]. `rec` is the instance's record (or undefined: nothing to carry).
 */
export function carryOver(opts, rec, sys, host) {
  if (!rec) return { opts, carried: [] };
  const out = { ...opts };
  const carried = [];
  const keep = (setting, value, from) => carried.push({ setting, value, from });

  if (!opts.serviceManagerGiven && !rec.unit) {
    out.serviceManager = "none";
    keep("service", "none", "record");
  }

  let cfg;
  const config = () => {
    if (cfg) return cfg;
    const path = rec.files && rec.files[0] && rec.files[0].path;
    const flags = opts.service === "control-plane" ? "--tunnel/--tunnel-name, or --no-tunnel" : "--control-plane, or --no-control-plane";
    try {
      // A regular file only: no symlink is followed and no FIFO is opened.
      if (!lstatSync(sys.path(path)).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
      cfg = tomlParse(readFileSync(sys.path(path), "utf8"));
    } catch (e) {
      throw conflictError(`${safeLine(path)} can't be read (${safeLine(e.code || e.message.split("\n")[0])}), so the settings it holds can't be carried over to this install. `
        + `Nothing was changed. Restore it, or give the setting again (${flags}).`, { refused: "carry-over", path });
    }
    return cfg;
  };

  if (opts.service === "sidecar") {
    // The default socket is the plan's own; only a listen the user chose is carried.
    const L = layout({ service: "sidecar", instance: rec.instance, version: rec.version, scope: rec.scope, home: host.home,
      runtimeDir: host.runtimeDir });
    if (!opts.listen && rec.listen && (!L.socket || rec.listen !== `unix:${L.socket}`)) {
      out.listen = rec.listen;
      keep("listen", rec.listen, "record");
    }
    if (!opts.controlPlane && !opts.noControlPlane) {
      const cp = config().control_plane;
      if (cp !== undefined && typeof cp !== "string") {
        throw conflictError(`${safeLine(rec.files[0].path)} holds a control_plane this install can't carry over (not a string). Nothing was changed. `
          + "Give it again with --control-plane, or install without one with --no-control-plane.", { refused: "carry-over", path: rec.files[0].path });
      }
      if (typeof cp === "string") {
        out.controlPlane = cp;
        keep("control_plane", cp, rec.files[0].path);
      }
    }
  }

  if (opts.service === "dispatch-server" || opts.service === "keyhole-server") {
    if (!opts.listen && rec.listen) {
      out.listen = rec.listen;
      keep("listen", rec.listen, "record");
      // A recorded network listen was only ever installed with --expose-on-network
      // --i-understand-network-exposure (parseListen refuses it otherwise), so carrying it carries
      // that acknowledgement too. A loopback listen carries none.
      if (!LOOPBACK_LISTEN.test(rec.listen) && !opts.expose) {
        out.expose = true;
        out.acknowledged = true;
        keep("expose_on_network", "acknowledged at install", "record");
      }
    }
    const [linkVar, controlVar] = opts.service === "keyhole-server"
      ? ["SERVICE_LISTEN_ADDR", "CONTROL_URL"] : ["VBCDX_LINK_ADDR", "VBCDX_CONTROL_URL"];
    const want = [["linkListen", linkVar, "link_listen"], ["controlUrl", controlVar, "control_url"],
      ["publicUrl", "PUBLIC_URL", "public_url"]].filter(([k]) => !opts[k]);
    if (want.length) {
      const env = envFile(rec, sys);
      for (const [k, name, setting] of want) {
        const v = env[name];
        if (v === undefined) continue;
        if (k === "publicUrl" && v === `http://${rec.listen}`) continue;
        out[k] = v;
        keep(setting, v, rec.files[0].path);
      }
    }
  }

  // keyhole-server's control CA: the copy install wrote (root's, in the config directory).
  if (opts.service === "keyhole-server" && !opts.controlCa) {
    const f = rec.files && rec.files[1];
    if (f) {
      out.controlCaText = recordedCA(f.path, sys);
      keep("control_ca", f.path, "record");
    }
  }

  if (opts.service === "control-plane" && !opts.tunnel && !opts.noTunnel) {
    const c = config();
    if (c.tunnel !== undefined || c.tunnel_name !== undefined) {
      const m = typeof c.tunnel === "string" ? TUNNEL_CONN.exec(c.tunnel) : null;
      if (!m || typeof c.tunnel_name !== "string") {
        throw conflictError(`${rec.files[0].path} holds a tunnel this install can't carry over (tunnel = ${JSON.stringify(c.tunnel)}, `
          + `tunnel_name = ${JSON.stringify(c.tunnel_name)}). Nothing was changed. Give it again with --tunnel <host>:<port> --tunnel-name <name>, `
          + "or install without it with --no-tunnel.", { refused: "carry-over", path: rec.files[0].path });
      }
      out.tunnel = m[1];
      out.tunnelName = c.tunnel_name;
      keep("tunnel", `${m[1]} (sidecars dial ${c.tunnel_name})`, rec.files[0].path);
    }
  }
  return { opts: out, carried };
}

// The recorded control CA (root's, in the config directory), read by the same rules as
// --control-ca (pem.js: no symlink, a regular file, size-capped, PEM certificates only, no private
// key). Anything else refuses the carry-over: it is never written into the new install.
function recordedCA(path, sys) {
  try {
    return readPemCerts("the installed control CA", sys.path(path), "as install wrote it").toString("latin1");
  } catch (e) {
    throw conflictError(`${safeLine(path)} can't be carried over to this install (${safeLine(e.message)}). Nothing was changed. `
      + "Restore it, or give --control-ca again.", { refused: "carry-over", path });
  }
}

// dispatch-server's dispatch.env (or keyhole-server's keyhole.env) as install wrote it: KEY=VALUE lines, comments skipped. A file
// that is missing, not regular, or holds another kind of line refuses the install (exit 5).
function envFile(rec, sys) {
  const path = rec.files && rec.files[0] && rec.files[0].path;
  const refuse = (why) => conflictError(`${safeLine(path)} ${why}, so the settings it holds can't be carried over to this install. `
    + "Nothing was changed. Restore it, or give the settings again (--link-listen, --control-url, --public-url).", { refused: "carry-over", path });
  let text;
  try {
    if (!lstatSync(sys.path(path)).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
    text = readFileSync(sys.path(path), "utf8");
  } catch (e) {
    throw refuse(`can't be read (${safeLine(e.code || e.message.split("\n")[0])})`);
  }
  const env = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw refuse("holds a line that isn't KEY=VALUE");
    env[m[1]] = m[2];
  }
  return env;
}
