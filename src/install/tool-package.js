// Locating an installed tool package and running its manifest command.
//
// `vbcdx install tool <package>` never installs anything from the registry: the
// package is found on disk as src/install/locate.js describes, and the error for a
// missing one names the `npm install` command to run.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readToolDeclaration } from "./tool-declaration.js";
import { checkPackageIdentity, locatePackageDir, isLocalPath } from "./locate.js";
import { lockedSource } from "../sources/lock.js";
import { configError, subprocessError } from "../errors.js";
import { validateManifest } from "../config/integrations.js";

export { searchRoots } from "./locate.js";

/**
 * Resolve a package spec to its directory, declaration and package.json.
 * @returns {{dir: string, name: string, version: string, declaration: object, pkg: object}}
 */
export function resolveToolPackage(spec, { cwd = process.cwd(), home, packageRoot, npmGlobalRoot, lock = null } = {}) {
  if (typeof spec !== "string" || spec === "") throw configError("install tool needs a package name or path.");
  // With a lock, a tool is a lock source (by source or package name), or a local path.
  const fromLock = lock && !isLocalPath(spec) ? lockedSource(lock, spec, "tool", "tool package") : null;
  const dir = fromLock ? fromLock.absDir : locatePackageDir(spec, { cwd, home, packageRoot, npmGlobalRoot, what: "tool package" });
  const { declaration, pkg } = readToolDeclaration(dir);
  checkPackageIdentity(dir, fromLock ? undefined : spec, pkg);
  return { dir, name: pkg.name, version: String(pkg.version || ""), declaration, pkg };
}

/** The absolute command and arguments that run one of the package's bin entries. */
export function binLaunch({ dir, pkg }, bin, args) {
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[bin];
  const abs = resolve(dir, rel);
  if (!abs.startsWith(dir + "/")) throw configError(`Package bin ${bin} points outside the package.`);
  if (!existsSync(abs)) throw configError(`Package bin ${bin} is missing: ${abs}.`);
  // A Node script runs under `node` so it needs no execute bit or PATH entry.
  let viaNode = /\.(c|m)?js$/.test(abs);
  if (!viaNode) {
    const head = readFileSync(abs, { encoding: "utf8" }).slice(0, 128);
    viaNode = /^#!.*\bnode\b/.test(head);
  }
  return viaNode ? { command: "node", args: [abs, ...args] } : { command: abs, args: [...args] };
}

// What the manifest child may see besides the variables its declaration names: enough
// to find node and a home directory, and nothing that is likely to be a secret.
const BASE_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot"];

/** The environment for a tool package's child: PATH, HOME and its declared variables only. */
export function toolChildEnv(declaration, env = process.env) {
  const names = [...BASE_ENV, ...declaration.env.map((e) => e.name)];
  return Object.fromEntries(names.filter((n) => typeof env[n] === "string").map((n) => [n, env[n]]));
}

/**
 * Run the package's manifest command and return its tool names. The child gets
 * PATH, HOME and the variables its declaration names, not the caller's whole
 * environment; nothing it prints is echoed beyond a bounded, single-line error.
 */
export function runToolManifest(toolPkg, { timeoutMs = 30000, env = process.env } = {}) {
  const { declaration } = toolPkg;
  const launch = binLaunch(toolPkg, declaration.stdio.bin, declaration.manifest.args);
  const command = launch.command === "node" ? process.execPath : launch.command;
  const res = spawnSync(command, launch.args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: toolChildEnv(declaration, env) });
  if (res.error) throw subprocessError(`${toolPkg.name} manifest command failed to run: ${res.error.code || res.error.message}.`);
  if (res.status !== 0) throw subprocessError(`${toolPkg.name} manifest command exited ${res.status}.`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw subprocessError(`${toolPkg.name} manifest command did not print JSON.`);
  }
  // The same strict check an integrations-file manifest gets, for the service the package
  // declares: its contract is what binds the tools to roles.
  const tools = validateManifest(parsed, declaration.server_name, `${toolPkg.name} manifest`);
  return { manifest: parsed, tools };
}
