// Locating an installed npm package on disk, for tool packages and agent packs alike.
//
// vbcdx never installs anything from the registry. It finds a package that is already
// on disk: a local path, then node_modules walking up from the working directory, then
// the node_modules this package is itself installed in (so `npm i -g @vbcdx/vbcdx <pkg>`
// finds its siblings), then the global root `npm root -g` reports. When none has it,
// the error names the `npm install` command to run.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseStrictJson } from "../config/json.js";
import { configError } from "../errors.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// npm package names: optional @scope/, lowercase, no leading dot or underscore.
export const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// A version is printed and recorded; it is one short token, never free text.
export const PACKAGE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export const isLocalPath = (spec) => spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~");

export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** node_modules directories to search for a named package, nearest first. */
export function searchRoots({ cwd, packageRoot = PACKAGE_ROOT, npmGlobalRoot = defaultNpmGlobalRoot }) {
  const roots = [];
  let dir = cwd;
  for (;;) {
    roots.push(join(dir, "node_modules"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // This package lives at <node_modules>/@vbcdx/vbcdx: its siblings are two levels up.
  const own = resolve(packageRoot, "..", "..");
  if (own.endsWith("node_modules")) roots.push(own);
  const g = npmGlobalRoot();
  if (g) roots.push(g);
  return [...new Set(roots)];
}

function defaultNpmGlobalRoot() {
  const res = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15000 });
  if (res.error || res.status !== 0) return null;
  const out = String(res.stdout).trim();
  return isAbsolute(out) ? out : null;
}

/**
 * Resolve a package spec (an npm name or a local path) to its real directory.
 * @param {string} spec
 * @param {object} o
 * @param {string} o.what  what the package is, for messages ("tool package", "agent pack")
 * @returns {string} the package directory, symlinks resolved
 */
export function locatePackageDir(spec, { cwd = process.cwd(), home, packageRoot, npmGlobalRoot, what = "package" } = {}) {
  if (typeof spec !== "string" || spec === "") throw configError(`A ${what} needs a package name or path.`);
  let dir;
  if (isLocalPath(spec)) {
    const expanded = spec.startsWith("~") ? join(home || "", spec.slice(1)) : spec;
    dir = resolve(cwd, expanded);
    if (!isDir(dir)) throw configError(`No package directory at ${dir}.`);
  } else {
    if (!PACKAGE_NAME_RE.test(spec)) throw configError(`${JSON.stringify(spec)} is not an npm package name or a path.`);
    for (const root of searchRoots({ cwd, packageRoot, npmGlobalRoot })) {
      const candidate = join(root, spec);
      if (existsSync(join(candidate, "package.json"))) {
        dir = candidate;
        break;
      }
    }
    if (!dir) {
      const lines = [`${spec} is not installed. Install it first, then rerun:`, `  npm install -g ${spec}`];
      throw configError(lines.join("\n"), { lines });
    }
  }
  return realpathSync(dir);
}

/**
 * Read and check a located package's package.json: a package found by path picked its
 * own name and version, so both are checked as strictly as a named spec before either
 * is printed or recorded, and a named spec must find the package it named.
 */
export function readPackageJson(dir, spec) {
  const pkgPath = join(dir, "package.json");
  let raw;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch (err) {
    throw configError(`${dir} has no readable package.json (${err.code || "read error"}).`);
  }
  const pkg = parseStrictJson(raw, pkgPath);
  checkPackageIdentity(dir, spec, pkg);
  return pkg;
}

export function checkPackageIdentity(dir, spec, pkg) {
  if (typeof pkg.name !== "string" || !PACKAGE_NAME_RE.test(pkg.name)) {
    throw configError(`${dir}/package.json has no valid npm package name.`);
  }
  if (pkg.version !== undefined && (typeof pkg.version !== "string" || !PACKAGE_VERSION_RE.test(pkg.version))) {
    throw configError(`${dir}/package.json has an invalid version.`);
  }
  if (spec !== undefined && !isLocalPath(spec) && pkg.name !== spec) {
    throw configError(`${dir} holds package ${pkg.name}, not ${spec}.`);
  }
}

/**
 * Every package directly under the search roots (including @scope/name) that holds
 * `marker`, nearest root first; a name found in a nearer root shadows the same name
 * further out, as Node's own resolution does. Returns [{ name, dir }].
 */
export function findPackagesWith(marker, { cwd = process.cwd(), packageRoot, npmGlobalRoot } = {}) {
  const found = new Map();
  const list = (d) => {
    try {
      return readdirSync(d).sort();
    } catch {
      return [];
    }
  };
  for (const root of searchRoots({ cwd, packageRoot, npmGlobalRoot })) {
    for (const entry of list(root)) {
      const names = entry.startsWith("@") ? list(join(root, entry)).map((n) => `${entry}/${n}`) : [entry];
      for (const name of names) {
        if (!PACKAGE_NAME_RE.test(name) || found.has(name)) continue;
        const dir = join(root, name);
        if (existsSync(join(dir, marker)) && existsSync(join(dir, "package.json"))) found.set(name, realpathSync(dir));
      }
    }
  }
  return [...found].map(([name, dir]) => ({ name, dir }));
}
