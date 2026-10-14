// `vbcdx fetch`: the build-time half of custom sources.
//
// For every source in vbcdx.sources.json: resolve its ref to a commit (git) or copy its
// directory (dir), into a temporary directory in the store; check that it ships a payload
// vbcdx knows (an agent pack's vbcdx-pack.json and/or a tool package's vbcdx.json) and
// that the payload is valid; install a tool package's npm dependencies from its lockfile
// (without running install scripts); digest the tree; and move it to
// <store>/<name>@<commit> (or <name>@dir-<digest>). Only when every source has passed is
// vbcdx.lock.json written, so a source's breaking change fails the build by name and never
// leaves a lock that half works.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { loadSources } from "./config.js";
import { gitEnv, readToken, resolveRef, fetchCommit } from "./git.js";
import { treeDigest, copyTree, assertLinksConfined } from "./tree.js";
import { readPack, PACK_DECLARATION_FILE } from "../packs/load.js";
import { readToolDeclaration, TOOL_DECLARATION_FILE } from "../install/tool-declaration.js";
import { readOverlay, OVERLAY_DECLARATION_FILE } from "../overlays/overlay.js";
import { parseStrictJson } from "../config/json.js";
import { configError, InstallerError } from "../errors.js";
import { LOCK_SCHEMA_VERSION } from "./lock.js";

const NPM_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
// What npm may see of the caller's environment: where programs are, and how to reach the
// network. Nothing else, so a ${VAR} in any npm config has no secret to expand.
const NPM_PASSTHROUGH = ["PATH", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];

/**
 * The environment `npm ci` runs with in a fetched tree: the tree is source
 * controlled, so npm gets a throwaway HOME and cache, empty user and global configs, and
 * the registry set explicitly (the caller's npm_config_registry, or npm's default), which
 * outranks any registry a project config could name. No token or other caller variable is
 * present, so none can be sent anywhere.
 */
export function npmEnv(callerEnv, scratch) {
  const env = {};
  for (const k of NPM_PASSTHROUGH) if (typeof callerEnv[k] === "string") env[k] = callerEnv[k];
  let registry = DEFAULT_NPM_REGISTRY;
  if (typeof callerEnv.npm_config_registry === "string" && callerEnv.npm_config_registry !== "") {
    let u;
    try {
      u = new URL(callerEnv.npm_config_registry);
    } catch {
      throw configError("npm_config_registry must be an http(s) URL.");
    }
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) {
      throw configError("npm_config_registry must be an http(s) URL with no credentials in it.");
    }
    registry = u.href;
  }
  // Two files: npm refuses to load one file as both its user and its global config.
  const userconfig = join(scratch, "user-npmrc");
  const globalconfig = join(scratch, "global-npmrc");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  Object.assign(env, {
    HOME: join(scratch, "home"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(scratch, "cache"),
    npm_config_registry: registry,
    npm_config_update_notifier: "false",
  });
  mkdirSync(env.HOME);
  return env;
}

/** The payload kinds a fetched tree ships, each validated; refuses a tree with none. */
export function payloadKinds(dir, label) {
  const kinds = [];
  if (existsSync(join(dir, PACK_DECLARATION_FILE))) {
    readPack(dir);
    kinds.push("agents");
  }
  if (existsSync(join(dir, TOOL_DECLARATION_FILE))) {
    readToolDeclaration(dir);
    kinds.push("tool");
  }
  // An overlay; the packs it names are checked when it is applied.
  if (existsSync(join(dir, OVERLAY_DECLARATION_FILE))) {
    readOverlay(dir);
    kinds.push("overlay");
  }
  if (!kinds.length) {
    throw configError(`${label} ships none of ${PACK_DECLARATION_FILE} (an agent pack), ${TOOL_DECLARATION_FILE} (a tool package) or ${OVERLAY_DECLARATION_FILE} (an overlay).`);
  }
  return kinds;
}

/**
 * A tool package with dependencies gets them from its lockfile, offline afterwards:
 * `npm ci --omit=dev --ignore-scripts`, with the environment npmEnv builds. The tree's own
 * `.npmrc` (npm's per-project config, read from the package root) is removed first, so a
 * source cannot configure the npm that installs it. A tree that already has
 * node_modules (a dir source the build installed) is left as it is.
 */
export function installDependencies(dir, label, env) {
  const pkg = parseStrictJson(readFileSync(join(dir, "package.json"), "utf8"), join(dir, "package.json"));
  const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
  if (deps.length === 0) return false;
  // The lockfile rule holds whatever the tree ships: a committed node_modules does not
  // excuse a tool from having one.
  if (!existsSync(join(dir, "package-lock.json")) && !existsSync(join(dir, "npm-shrinkwrap.json"))) {
    throw configError(`${label} has dependencies but no package-lock.json; vbcdx installs a tool's dependencies only from its lockfile.`);
  }
  if (existsSync(join(dir, "node_modules"))) return false;
  rmSync(join(dir, ".npmrc"), { force: true });
  const scratch = mkdtempSync(join(tmpdir(), "vbcdx-npm-"));
  let res;
  try {
    res = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: dir, env: npmEnv(env, scratch), encoding: "utf8", timeout: NPM_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (res.error) throw configError(`${label}: npm could not run (${res.error.code || res.error.message}).`);
  if (res.status !== 0) throw configError(`${label}: npm ci failed: ${String(res.stderr || "").trim().split("\n").slice(-3).join(" | ") || `exit ${res.status}`}`);
  return true;
}

function writeAtomic(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Fetch every source and write the lock.
 * @param {object} o
 * @param {string} o.sourcesPath absolute vbcdx.sources.json
 * @param {string} o.lockPath absolute vbcdx.lock.json to write
 * @param {string} o.storeDir absolute store directory (created if missing)
 * @param {object} [o.env] process environment (tokens are read from it by name)
 * @returns {{lock:string, store:string, sources:object[]}}
 */
export function fetchSources({ sourcesPath, lockPath, storeDir, env = process.env }) {
  for (const [what, p] of [["sources file", sourcesPath], ["lock", lockPath], ["store", storeDir]]) {
    if (!isAbsolute(p)) throw configError(`The ${what} path must be absolute.`);
  }
  const sources = loadSources(sourcesPath);
  mkdirSync(storeDir, { recursive: true });
  const fetched = [];
  const temps = [];
  try {
    for (const s of sources) {
      const label = `Source ${s.name}`;
      const tmp = join(storeDir, `.fetch-${s.name}-${process.pid}-${randomBytes(4).toString("hex")}`);
      temps.push(tmp);
      let sha = null;
      if (s.origin === "git") {
        const token = s.authEnv ? readToken(s.authEnv, env) : null;
        const opts = { env: gitEnv(s.git, token, env), secret: token, label };
        sha = resolveRef(s.git, s.ref, opts);
        fetchCommit(s.git, sha, tmp, opts);
      } else {
        if (!existsSync(s.dir)) throw configError(`${label}: no directory at ${s.dir}.`);
        // A directory that holds the store would be copied into itself.
        const within = relative(realpathSync(s.dir), realpathSync(storeDir));
        if (within === "" || (!within.startsWith("..") && !isAbsolute(within))) {
          throw configError(`${label}: ${s.dir} contains the store ${storeDir}; put the store outside the source (--store).`);
        }
        copyTree(s.dir, tmp);
      }
      let kinds;
      try {
        // Before anything reads the payload: a link out of the tree is refused.
        assertLinksConfined(tmp);
        kinds = payloadKinds(tmp, label);
        if (kinds.includes("tool")) installDependencies(tmp, label, env);
      } catch (err) {
        if (err instanceof InstallerError && !err.message.startsWith(label)) {
          throw new InstallerError(err.code, `${label}: ${err.message.split(tmp).join("<source>")}`, err.details);
        }
        throw err;
      }
      const digest = treeDigest(tmp);
      const id = sha || `dir-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
      const path = `${s.name}@${id}`;
      const final = join(storeDir, path);
      if (existsSync(final)) {
        // The same commit fetched before: keep the copy only if it is still what it was.
        if (treeDigest(final) !== digest) rmSync(final, { recursive: true, force: true });
      }
      if (existsSync(final)) rmSync(tmp, { recursive: true, force: true });
      else renameSync(tmp, final);
      const entry = { kinds, ref: s.ref, sha, path, digest };
      if (s.origin === "git") {
        entry.git = s.git;
        if (s.shorthand) entry.shorthand = s.shorthand;
      } else {
        entry.dir = s.dir;
        delete entry.ref;
      }
      fetched.push([s.name, entry]);
    }
  } finally {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  }
  const lockDir = dirname(lockPath);
  const rel = relative(lockDir, storeDir);
  // A store next to (or under) the lock is recorded relative to it, so the two can move together.
  const store = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : storeDir;
  const lock = { schema_version: LOCK_SCHEMA_VERSION, store, sources: Object.fromEntries(fetched) };
  mkdirSync(lockDir, { recursive: true });
  writeAtomic(lockPath, JSON.stringify(lock, null, 2) + "\n");
  return { lock: lockPath, store: storeDir, sources: fetched.map(([name, e]) => ({ name, ...e })) };
}
