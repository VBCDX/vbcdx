// A service release, verified before anything is copied (the service-CLI spec, npm shipping).
//
// The same layout serves `--from <dir>` (a CI artifact, for offline and test hosts)
// and an npm install (the meta package, its platform package nested under node_modules):
//
//   <root>/checksums.json          {"schema":1,"package":"@vbcdx/sidecar","version":"x.y.z",
//                                   "files":{"@vbcdx/sidecar-<platform>/bin/<bin>":"<sha256>",…}}
//   <root>/checksums.json.minisig  minisign; trusted comment "vbcdx-release <package> <version>"
//   <root>/@vbcdx/sidecar-<platform>/bin/vbcdx-sidecar, vbcdx-svc    (or under node_modules/)
//
// Order: the signature over checksums.json first, then its trusted comment against the
// package and version, then each binary's SHA-256. Nothing is trusted before it is checked.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:process";
import { sha256 } from "../fs/safe-writer.js";
import { configError, conflictError } from "../errors.js";
import { verifyMinisign } from "./minisign.js";

// Semantic Versioning 2.0.0: x.y.z with no leading zeros, an optional pre-release and build;
// every identifier is [0-9A-Za-z-]+, so there is no "/" and no empty or "." segment.
const ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
export const SEMVER = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${ID}(?:\\.${ID})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export const SERVICES = Object.freeze({
  sidecar: { package: "@vbcdx/sidecar", binaries: ["vbcdx-sidecar", "vbcdx-svc"], daemon: "vbcdx-sidecar" },
  // The control plane's auth and registry daemon. It ships in the same signed
  // release tree as the sidecar, so it is verified exactly as the sidecar is.
  "control-plane": { package: "@vbcdx/sidecar", binaries: ["vbcdx-control"], daemon: "vbcdx-control" },
  // The Dispatch and Keyhole servers: each its own signed release (published by the dispatch
  // and keyhole repos' release jobs), verified exactly as the sidecar is. Plain "dispatch" and
  // "keyhole" are config areas of the sidecar (args.js CONFIG_AREAS), not services to install.
  // This version verifies them only: installing one is refused before
  // anything is fetched (index.js planInstall, plan.js buildPlan).
  "dispatch-server": { package: "@vbcdx/dispatch", binaries: ["dispatch"], daemon: "dispatch" },
  "keyhole-server": { package: "@vbcdx/keyhole", binaries: ["keyhole"], daemon: "keyhole" },
});

/** The platform package suffix for this host: linux-x64-gnu, linux-arm64-musl, darwin-arm64, … */
export function hostPlatform({ os = platform, cpu = arch, report = () => process.report.getReport() } = {}) {
  if (!["x64", "arm64"].includes(cpu)) throw conflictError(`Unsupported CPU: ${cpu} (x64 and arm64 are built).`);
  if (os === "darwin") return `darwin-${cpu}`;
  if (os !== "linux") throw conflictError(`Unsupported OS: ${os} (Linux and macOS are built).`);
  const glibc = report().header && report().header.glibcVersionRuntime;
  return `linux-${cpu}-${glibc ? "gnu" : "musl"}`;
}

function readRaw(path, what) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    throw conflictError(`The release has no ${what}: ${path}.`);
  }
  return raw;
}

/**
 * Verify a release rooted at `root` for `service` on `platformId`.
 * @param {{root: string, service: string, platformId: string, version?: string|null,
 *          trustedKeys: string[], binRoots?: string[]}} o
 * @returns {{package, version, platform, signature: {keyId, trustedComment}, binaries: {name, path, sha256}[]}}
 */
export function verifyRelease({ root, service, platformId, version = null, trustedKeys, binRoots = null }) {
  const svc = SERVICES[service];
  if (!svc) throw configError(`Unknown service: ${service}.`);
  const sumsPath = join(root, "checksums.json");
  const raw = readRaw(sumsPath, "checksums.json");
  let sigText;
  try {
    sigText = readFileSync(`${sumsPath}.minisig`, "utf8");
  } catch {
    throw conflictError(`The release is unsigned: ${sumsPath}.minisig is missing.`);
  }
  const signature = verifyMinisign(raw, sigText, trustedKeys);

  let sums;
  try {
    sums = JSON.parse(raw.toString("utf8"));
  } catch {
    throw conflictError("checksums.json is signed but is not JSON.");
  }
  if (!sums || sums.schema !== 1 || typeof sums.files !== "object" || sums.files === null) {
    throw conflictError("checksums.json is not schema 1.");
  }
  if (sums.package !== svc.package) throw conflictError(`The release is ${sums.package}, not ${svc.package}.`);
  // The version becomes a directory name (lib/<service>/<version>): strict semver only, so
  // even a validly signed "../x" can never leave lib/.
  if (typeof sums.version !== "string" || !SEMVER.test(sums.version)) {
    throw conflictError("checksums.json's version is not a semantic version (x.y.z).");
  }
  // The signed comment binds package and version, so a signed checksums.json can't be
  // replayed under another name or version.
  if (signature.trustedComment !== `vbcdx-release ${sums.package} ${sums.version}`) {
    throw conflictError("The signature's trusted comment does not name this package and version.");
  }
  if (version !== null && sums.version !== version) throw configError(`The release is version ${sums.version}, not ${version}.`);

  const pkgDir = `${svc.package}-${platformId}`;
  const roots = binRoots || [root, join(root, "node_modules")];
  const binaries = svc.binaries.map((name) => {
    const key = `${pkgDir}/bin/${name}`;
    const want = sums.files[key];
    if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) {
      throw conflictError(`The release has no checksum for ${key}: this platform (${platformId}) may not be built.`);
    }
    const path = roots.map((r) => join(r, key)).find((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (!path) throw conflictError(`The release is missing ${key}.`);
    // Read once: these exact bytes are hashed here and are what install writes, so nothing
    // that changes the path afterwards (a rewrite, a symlink swap) reaches the install.
    const bytes = readFileSync(path);
    const got = sha256(bytes);
    if (got !== want) throw conflictError(`${key} does not match its signed checksum.`);
    const binary = { name, path, sha256: got };
    // Not enumerable: it travels with the release but never into --json output.
    Object.defineProperty(binary, "bytes", { value: bytes, enumerable: false });
    return binary;
  });
  return { package: sums.package, version: sums.version, platform: platformId, signature, binaries };
}
