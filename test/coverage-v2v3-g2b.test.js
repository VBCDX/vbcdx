// Branch coverage for src/sources/lock.js and src/sources/fetch.js. Nothing here touches
// the network: git runs against local repositories (file:// URLs, and a throwaway HOME
// whose gitconfig redirects a shorthand's URL to one), npm is a shell stand-in or absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, chmodSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tempDir } from "./helpers/temp-dir.js";
import { fetchSources, installDependencies } from "../src/sources/fetch.js";
import { readLock, provenance, lockedSource } from "../src/sources/lock.js";
import { SHORTHANDS } from "../src/sources/config.js";
import { treeDigest } from "../src/sources/tree.js";
import { EXIT } from "../src/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, "fixtures", "agent-pack");
const read = (p) => readFileSync(p, "utf8");

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return { code: err.code, message: err.message };
  }
  return { code: EXIT.OK, message: "" };
}

const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=trunk", ...args], { cwd, encoding: "utf8" }).trim();

function repoOf(root, name, fixture) {
  const dir = join(root, "repos", name);
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(fixture, dir, { recursive: true });
  g(dir, "init", "-q");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "one");
  return { dir, url: `file://${dir}`, sha: g(dir, "rev-parse", "HEAD") };
}

function sourcesFile(root, sources) {
  const p = join(root, "vbcdx.sources.json");
  writeFileSync(p, JSON.stringify({ schema_version: 1, sources }));
  return p;
}

function fetchAt(root, sources, env = process.env) {
  return fetchSources({ sourcesPath: sourcesFile(root, sources), lockPath: join(root, "vbcdx.lock.json"), storeDir: join(root, "store"), env });
}

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"0".repeat(64)}`;
const gitEntry = (over = {}) => ({ kinds: ["agents"], git: "file:///nowhere", ref: "main", sha: SHA, path: `s1@${SHA}`, digest: DIGEST, ...over });

function writeLock(root, doc) {
  const p = join(root, "vbcdx.lock.json");
  writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
  return p;
}

// ── lock.js: reading ─────────────────────────────────────────────────────────

test("lock.js 28 and 33: a relative --lock is refused, and an unreadable lock names its error code", () => {
  // 28:30-28:84. 33:69-33:84 (`|| "read error"`) is unreachable: fs errors always carry a code.
  assert.deepEqual(codeOf(() => readLock("rel/vbcdx.lock.json")), { code: EXIT.CONFIG, message: "--lock must be an absolute path." });
  const root = tempDir("vbcdx-g2b-");
  const missing = join(root, "absent.lock.json");
  assert.deepEqual(codeOf(() => readLock(missing)), { code: EXIT.CONFIG, message: `Cannot read the lock ${missing} (ENOENT); run vbcdx fetch first.` });
});

test("lock.js 37, 38, 42, 43, 45: top-level shape errors are refused by name", () => {
  const root = tempDir("vbcdx-g2b-");
  const p = join(root, "vbcdx.lock.json");
  const bad = (doc, re) => {
    writeLock(root, doc);
    const r = codeOf(() => readLock(p));
    assert.equal(r.code, EXIT.CONFIG, String(doc));
    assert.match(r.message, re, String(doc));
  };
  const ok = { schema_version: 1, store: "store", sources: {} };
  // 37:62-37:114
  bad("[]", new RegExp(`^Lock ${p} is not a JSON object\\.$`));
  bad("null", /is not a JSON object\./);
  // 38:94-38:161
  bad({ ...ok, extra: 1 }, new RegExp(`^Lock ${p}: unknown field "extra"\\.$`));
  // 42:51-42:129: absent, zero, and a string all fail the same rule
  for (const v of [undefined, 0, "1"]) bad({ ...ok, schema_version: v }, new RegExp(`^Lock ${p}: schema_version must be 1\\.$`));
  // 43:58-43:111
  for (const v of [undefined, "", 5]) bad({ ...ok, store: v }, new RegExp(`^Lock ${p}: store must be a path\\.$`));
  // 45:86-45:144
  for (const v of [undefined, null, [], "x"]) bad({ ...ok, sources: v }, new RegExp(`^Lock ${p}: sources must be an object\\.$`));
});

test("lock.js 49-63: each source-entry rule refuses its own bad entry before any store is read", () => {
  const root = tempDir("vbcdx-g2b-");
  const p = join(root, "vbcdx.lock.json");
  const label = `Lock ${p}: source "s1"`;
  const bad = (entry, re, name = "s1") => {
    writeLock(root, { schema_version: 1, store: "store", sources: { [name]: entry } });
    const r = codeOf(() => readLock(p));
    assert.equal(r.code, EXIT.CONFIG, JSON.stringify(entry));
    assert.match(r.message, re, JSON.stringify(entry));
  };
  // 49:37-49:82
  bad(gitEntry(), new RegExp(`^Lock ${p}: source "Bad_Name": invalid name\\.$`), "Bad_Name");
  // 50:58-50:107
  for (const e of [null, [], "x", 3]) bad(e, new RegExp(`^${label} must be an object\\.$`));
  // 51:66-51:133
  bad(gitEntry({ extra: 1 }), new RegExp(`^${label}: unknown field "extra"\\.$`));
  // 52:146-54:6: missing, empty, foreign, duplicated
  for (const kinds of [undefined, [], ["nope"], ["tool", "tool"], "agents"]) {
    bad(gitEntry({ kinds }), new RegExp(`^${label}: kinds must list agents, tool and/or overlay\\.$`));
  }
  // 55:40-55:104: both origins, and neither
  bad(gitEntry({ dir: "/d" }), new RegExp(`^${label} needs exactly one of git and dir\\.$`));
  const noOrigin = gitEntry();
  delete noOrigin.git;
  bad(noOrigin, new RegExp(`^${label} needs exactly one of git and dir\\.$`));
  // 58:26-58:70
  for (const ref of [undefined, "a..b", "-x", 5]) bad(gitEntry({ ref }), new RegExp(`^${label}: invalid ref\\.$`));
  // 59:66-59:128: short, upper-case, and not a string
  for (const sha of [undefined, "abc123", SHA.toUpperCase(), 7]) bad(gitEntry({ sha }), new RegExp(`^${label}: sha must be a full commit SHA\\.$`));
  // 60:61-62:6: a dir entry with a sha, a missing sha, or a non-string dir
  const dirEntry = (over) => ({ kinds: ["agents"], dir: "/d", sha: null, path: "s1@dir-0000000000000000", digest: DIGEST, ...over });
  for (const over of [{ sha: SHA }, { sha: undefined }, { dir: 5 }]) {
    bad(dirEntry(over), new RegExp(`^${label}: a dir source records its dir and a null sha\\.$`));
  }
  // 63:68-63:115
  for (const digest of [undefined, "sha256:abc", `sha1:${"0".repeat(64)}`, `sha256:${"0".repeat(64)}0`, 9]) {
    bad(gitEntry({ digest }), new RegExp(`^${label}: invalid digest\\.$`));
  }
});

test("lock.js 85: a shorthand source keeps its shorthand in the provenance, a plain git source does not", () => {
  // 85:21-85:49. The shorthand's URL is redirected to a local repository by a throwaway
  // HOME gitconfig (insteadOf), so the fetch is a real one with no network.
  const root = tempDir("vbcdx-g2b-");
  const pack = repoOf(root, "pack", PACK);
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), `[url "${pack.url}"]\n\tinsteadOf = ${SHORTHANDS["dev-agents"]}\n`);
  const env = { ...process.env, HOME: home };
  const out = fetchAt(root, { short: { shorthand: "dev-agents", ref: "trunk" }, plain: { git: pack.url, ref: "trunk" } }, env);
  assert.equal(out.sources[0].shorthand, "dev-agents");
  assert.equal(out.sources[0].git, SHORTHANDS["dev-agents"]);
  assert.equal(out.sources[1].shorthand, undefined);
  const lockDoc = JSON.parse(read(join(root, "vbcdx.lock.json")));
  assert.equal(lockDoc.sources.short.shorthand, "dev-agents");
  assert.equal("shorthand" in lockDoc.sources.plain, false);
  const prov = provenance(readLock(join(root, "vbcdx.lock.json")));
  assert.deepEqual(prov.map((e) => [e.name, e.git, e.ref, e.sha, e.shorthand]), [
    ["short", SHORTHANDS["dev-agents"], "trunk", pack.sha, "dev-agents"],
    ["plain", pack.url, "trunk", pack.sha, undefined],
  ]);
  assert.equal("shorthand" in prov[1], false);
});

test("lock.js 103: a lock with no source of the asked kind says 'it has: none'", () => {
  // 103:136-103:145. A lock built by hand: readLock only digests the stored tree.
  const root = tempDir("vbcdx-g2b-");
  const dir = join(root, "store", `s1@${SHA}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "f.txt"), "x\n");
  const lockPath = writeLock(root, { schema_version: 1, store: "store", sources: { s1: gitEntry({ digest: treeDigest(dir) }) } });
  const lock = readLock(lockPath);
  const r = codeOf(() => lockedSource(lock, "thing", "tool", "tool package"));
  assert.equal(r.code, EXIT.CONFIG);
  assert.equal(r.message, `thing is not a tool package in the lock ${lockPath} (it has: none); with --lock, nothing else is searched.`);
  // The same lock names what it does hold for its own kind, and picks "an" before a vowel.
  assert.match(codeOf(() => lockedSource(lock, "thing", "agents", "agent pack")).message, /^thing is not an agent pack in the lock .* \(it has: s1\);/);
});

// ── fetch.js: dependencies ───────────────────────────────────────────────────

function toolDir(root, name = "tool") {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { dep: "1.0.0" } }));
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  return dir;
}

function npmShim(root, body) {
  const bin = join(root, "npm-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}

test("fetch.js 111: a tree that already has node_modules is left as it is, with no npm run", () => {
  // 111:46-111:59. The PATH has no npm: reaching it would fail with "could not run".
  const root = tempDir("vbcdx-g2b-");
  const dir = toolDir(root);
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, ".npmrc"), "keep\n");
  const empty = join(root, "empty-bin");
  mkdirSync(empty);
  assert.equal(installDependencies(dir, "Source tool", { PATH: empty }), false);
  assert.equal(read(join(dir, ".npmrc")), "keep\n", "the early return happens before the .npmrc is removed");
});

test("fetch.js 122: an npm that cannot be started is reported with its error code", () => {
  // 122:18-122:109
  const root = tempDir("vbcdx-g2b-");
  const dir = toolDir(root);
  const empty = join(root, "empty-bin");
  mkdirSync(empty);
  const r = codeOf(() => installDependencies(dir, "Source tool", { PATH: empty }));
  assert.deepEqual(r, { code: EXIT.CONFIG, message: "Source tool: npm could not run (ENOENT)." });
});

test("fetch.js 123: a failing npm ci reports the last three stderr lines, or its exit status when silent", () => {
  // 123:25-123:164
  const root = tempDir("vbcdx-g2b-");
  const dir = toolDir(root);
  const loud = npmShim(root, `echo one >&2; echo two >&2; echo three >&2; echo four >&2; exit 3`);
  assert.deepEqual(codeOf(() => installDependencies(dir, "Source tool", { PATH: loud })), {
    code: EXIT.CONFIG, message: "Source tool: npm ci failed: two | three | four",
  });
  const quiet = npmShim(join(root, "q"), "exit 5");
  assert.equal(codeOf(() => installDependencies(dir, "Source tool", { PATH: quiet })).message, "Source tool: npm ci failed: exit 5");
});

// ── fetch.js: fetchSources ───────────────────────────────────────────────────

test("fetch.js 144: the sources file, the lock and the store paths must each be absolute", () => {
  // 144:25-144:81
  const root = tempDir("vbcdx-g2b-");
  const abs = { sourcesPath: join(root, "s.json"), lockPath: join(root, "l.json"), storeDir: join(root, "store") };
  for (const [key, what] of [["sourcesPath", "sources file"], ["lockPath", "lock"], ["storeDir", "store"]]) {
    assert.deepEqual(codeOf(() => fetchSources({ ...abs, [key]: "relative/path" })), { code: EXIT.CONFIG, message: `The ${what} path must be absolute.` });
  }
  assert.equal(existsSync(abs.storeDir), false, "nothing is created before the paths are checked");
});

test("fetch.js 162: a dir source that does not exist is refused by name and no lock is written", () => {
  // 162:33-162:90
  const root = tempDir("vbcdx-g2b-");
  const gone = join(root, "no-such-dir");
  const r = codeOf(() => fetchAt(root, { gone: { dir: gone } }));
  assert.deepEqual(r, { code: EXIT.CONFIG, message: `Source gone: no directory at ${gone}.` });
  assert.equal(existsSync(join(root, "vbcdx.lock.json")), false);
});

test("fetch.js 186-190: refetching an unchanged source keeps the stored copy; a changed copy is replaced by the fresh one", () => {
  // 190:30-190:76 (the fresh temp copy is dropped when the stored one still matches),
  // then 186:30-189:8 (the stored copy no longer matches: it is removed and replaced).
  const root = tempDir("vbcdx-g2b-");
  const first = fetchAt(root, { local: { dir: PACK } });
  const stored = join(root, "store", first.sources[0].path);
  const before = statSync(stored).ino;
  const again = fetchAt(root, { local: { dir: PACK } });
  assert.equal(again.sources[0].path, first.sources[0].path);
  assert.equal(statSync(stored).ino, before, "the matching copy is kept, not re-created");
  assert.deepEqual(readdirSync(join(root, "store")).filter((n) => n.startsWith(".")), [], "the temporary copy is gone");
  // Tamper with the stored copy: same name, different content.
  const original = read(join(stored, "package.json"));
  writeFileSync(join(stored, "package.json"), `${original}\n\n`);
  assert.notEqual(treeDigest(stored), first.sources[0].digest);
  const third = fetchAt(root, { local: { dir: PACK } });
  assert.equal(third.sources[0].digest, first.sources[0].digest);
  assert.equal(read(join(stored, "package.json")), original, "the stored copy is the fresh fetch again");
  assert.equal(treeDigest(stored), first.sources[0].digest);
  assert.deepEqual(readdirSync(join(root, "store")).filter((n) => n.startsWith(".")), []);
  assert.equal(readLock(join(root, "vbcdx.lock.json")).sources[0].absDir, stored, "the lock reads clean again");
});

test("fetch.js 195: a shorthand git source records its shorthand in the lock", () => {
  // 195:26-195:56. Same local redirect as above; the lock entry is read back from disk.
  const root = tempDir("vbcdx-g2b-");
  const pack = repoOf(root, "pack", PACK);
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), `[url "${pack.url}"]\n\tinsteadOf = ${SHORTHANDS.forgejo}\n`);
  fetchAt(root, { fj: { shorthand: "forgejo", ref: pack.sha } }, { ...process.env, HOME: home });
  const entry = JSON.parse(read(join(root, "vbcdx.lock.json"))).sources.fj;
  assert.deepEqual(entry, { kinds: ["agents"], ref: pack.sha, sha: pack.sha, path: `fj@${pack.sha}`, digest: entry.digest, git: SHORTHANDS.forgejo, shorthand: "forgejo" });
});

test("fetch.js 208: a store outside the lock's directory is recorded by its absolute path", () => {
  // 208:72-208:82
  const root = tempDir("vbcdx-g2b-");
  const lockPath = join(root, "locks", "vbcdx.lock.json");
  const storeDir = join(root, "store");
  const out = fetchSources({ sourcesPath: sourcesFile(root, { local: { dir: PACK } }), lockPath, storeDir, env: process.env });
  assert.equal(out.lock, lockPath);
  assert.equal(JSON.parse(read(lockPath)).store, storeDir);
  assert.equal(readLock(lockPath).store, storeDir);
  // A store under the lock's directory stays relative (the other side of the same ternary).
  const nested = join(root, "locks", "inner-store");
  fetchSources({ sourcesPath: sourcesFile(root, { local: { dir: PACK } }), lockPath, storeDir: nested, env: process.env });
  assert.equal(JSON.parse(read(lockPath)).store, "inner-store");
  rmSync(nested, { recursive: true, force: true });
});
