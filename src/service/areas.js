// `vbcdx config service keyhole|dispatch …` runs the sidecar's vbcdx-svc: the sidecar carries
// Keyhole's and Dispatch's calls, so their commands belong to its vbcdx-svc
// (`vbcdx-svc dispatch messages send …`). Every vbcdx-svc has the sidecar, keyhole and dispatch
// areas, but some commands under them are newer than an installed sidecar can be. Running such a
// command on an older vbcdx-svc would only print a parser's "unrecognized subcommand", so the
// installer names the release that added it instead, before anything runs.

import { conflictError } from "../errors.js";

// The first @vbcdx/sidecar release whose vbcdx-svc has each command. A command missing here
// is in every release.
export const SINCE = Object.freeze([
  { words: ["dispatch", "messages"], version: "0.1.0-dev.4.1" },
]);

// vbcdx-svc's global options that take a value (so the value isn't read as a command word).
const VALUE_OPTIONS = new Set(["--instance", "--sidecar", "--admin-socket", "--org", "--workspace", "--profile", "--config"]);

/** The command words of a vbcdx-svc argv (`dispatch --org o messages send ws` → dispatch, messages, send, ws). */
export function commandWords(argv) {
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("-")) words.push(a);
  }
  return words;
}

/**
 * SemVer 2.0.0 precedence: < 0 when a is older than b. Build metadata is ignored; pre-release
 * identifiers compare numerically when both are numbers, a number is older than a word, and a
 * shorter list is older when it is a prefix of the other (so 0.1.0-dev.4 < 0.1.0-dev.4.1 <
 * 0.1.0-dev.10 < 0.1.0).
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (!m) throw new Error(`not a version: ${v}`);
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split(".") };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  const numeric = (s) => /^\d+$/.test(s);
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === y) continue;
    if (numeric(x) && numeric(y)) return Number(x) - Number(y);
    if (numeric(x)) return -1;
    if (numeric(y)) return 1;
    return x < y ? -1 : 1;
  }
  return pa.pre.length - pb.pre.length;
}

/**
 * Refuse (exit 5) a command the installed sidecar's vbcdx-svc doesn't have, naming the release
 * that has it. `argv` is what vbcdx-svc would get (`dispatch messages send …`).
 */
export function requireCommand(rec, argv) {
  const words = commandWords(argv);
  for (const { words: need, version } of SINCE) {
    if (need.every((w, i) => words[i] === w) && compareVersions(rec.version, version) < 0) {
      const instance = rec.instance === "default" ? "" : ` --instance ${rec.instance}`;
      throw conflictError(`\`${need.join(" ")}\` needs @vbcdx/sidecar ${version} or later; sidecar instance "${rec.instance}" `
        + `runs ${rec.version}. Upgrade it first: vbcdx install service sidecar${instance} --version ${version} (or later).`);
    }
  }
}
