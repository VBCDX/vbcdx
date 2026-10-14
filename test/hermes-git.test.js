// Hermes git: roles clone org repos and open pull requests from their own fork; they
// never push to an org repo. Renderer + installer tests, then the rendered hermes-git helper
// run for real (python3 + git) against a stub Forgejo API and local bare repositories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRole } from "../src/roles/index.js";
import { renderHermes, renderHermesGit, HERMES_GIT_READ_SCOPE } from "../src/renderers/hermes.js";
import { loadIntegrations } from "../src/config/integrations.js";
import { init } from "../src/index.js";
import { parsePy, stringifyPy } from "../src/fs/pyyaml.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
const files = (out) => Object.fromEntries(out.files.map((f) => [f.name, f]));

function writeIntegrations(service, dir = tmp("hermes-git-int-")) {
  const tool = (name, effect) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect, required_permissions: [] });
  const manifest = { schema_version: 1, service: "forgejo", contract: "vbcdx.forgejo/1", package_version: "0.1.0",
    tools: [tool("create_comment", "write"), tool("whoami", "read")] };
  writeFileSync(join(dir, "forgejo.json"), JSON.stringify(manifest));
  const file = join(dir, "integrations.json");
  writeFileSync(file, JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: join(dir, "forgejo.json"), ...service } } }));
  chmodSync(file, 0o600);
  return file;
}
const HTTP = { transport: "http", url: "https://gw.example/mcp/Forgejo", roles: ["code-agent"] };

// ---- renderer and integrations

test("git_url renders the token passthrough, the helper and the SOUL note for bound roles only", () => {
  const integrations = loadIntegrations(writeIntegrations({ ...HTTP, git_url: "https://git.example/", git_roles: { "code-agent": "fork" } }));
  const out = files(renderHermes(getRole("code-agent"), { integrations }));
  assert.deepEqual(parsePy(out["config.yaml"].content).terminal, { env_passthrough: ["VBCDX_FORGEJO_TOKEN"] });
  assert.equal(out["bin/hermes-git"].mode, 0o755);
  assert.match(out["bin/hermes-git"].content, /^FORGEJO_URL = "https:\/\/git\.example"\.rstrip/m); // trailing slash dropped
  assert.doesNotMatch(out["bin/hermes-git"].content, /@@FORGEJO_URL@@/);
  assert.match(out["SOUL.md"].content, /## Git: clone, and pull requests from your fork/);
  assert.match(out["SOUL.md"].content, /never push to an organisation's repository/);
  // a role not bound to forgejo gets none of it
  const other = files(renderHermes(getRole("adversarial-auditor"), { integrations }));
  assert.equal(parsePy(other["config.yaml"].content).terminal, undefined);
  assert.equal(other["bin/hermes-git"], undefined);
  assert.doesNotMatch(other["SOUL.md"].content, /hermes-git/);
  // git_url without git_roles enables git for no role (an explicit opt-in per role)
  const noRoles = files(renderHermes(getRole("code-agent"), { integrations: loadIntegrations(writeIntegrations({ ...HTTP, git_url: "https://git.example" })) }));
  assert.equal(parsePy(noRoles["config.yaml"].content).terminal, undefined);
  assert.equal(noRoles["bin/hermes-git"], undefined);
  assert.doesNotMatch(noRoles["SOUL.md"].content, /hermes-git/);
  // without git_url nothing changes
  const plain = files(renderHermes(getRole("code-agent"), { integrations: loadIntegrations(writeIntegrations(HTTP)) }));
  assert.equal(parsePy(plain["config.yaml"].content).terminal, undefined);
  assert.equal(plain["bin/hermes-git"], undefined);
});

test("git_url is only for forgejo over http, and never sends the token in cleartext", () => {
  const bad = (svc, re) => assert.throws(() => loadIntegrations(writeIntegrations(svc)), re);
  for (const u of [["https://git.example"], 42, { href: "https://git.example" }]) {
    bad({ ...HTTP, git_url: u }, /git_url must be a string/); // an array used to throw a TypeError
  }
  for (const u of ['https://git.example/"x', "https://git.example/$&", "https://git.example/a\\b", "https://git.example/\nx", "https://git.example/ x", "https://git.example/'x"]) {
    bad({ ...HTTP, git_url: u }, /must be a plain URL/);
  }
  bad({ credentials: {}, git_url: "https://git.example" }, /only valid for a vbcdx\.forgejo\/1 service with transport "http"/);
  bad({ ...HTTP, git_url: "http://git.example" }, /plain http/);
  bad({ ...HTTP, git_url: "https://u:p@git.example" }, /embed credentials/);
  assert.equal(loadIntegrations(writeIntegrations({ ...HTTP, git_url: "http://127.0.0.1:3000" })).services.forgejo.gitUrl, "http://127.0.0.1:3000");
});

test("the rendered helper keeps git_url a plain Python string whatever it contains", () => {
  for (const u of ["https://git.example/$&x", "https://git.example/a$'b", 'https://git.example/";import os;os.system("echo PWNED")#']) {
    const src = renderHermesGit(u, "fork");
    assert.doesNotMatch(src, /@@FORGEJO_URL@@/);
    assert.doesNotMatch(src, /@@/); // and no other render placeholder survives
    const r = run("python3", ["-c", `import runpy,sys; g = runpy.run_path(sys.argv[1], run_name="not_main"); print(g["FORGEJO_URL"])`, writeTmp(src)]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), u.replace(/\/+$/, ""));
    assert.deepEqual(r.stdout.split("\n").filter(Boolean), [u]); // exactly the URL; an injected os.system would print its own line
  }
});

// ---- installer: files land, and the key-level merge owns terminal.env_passthrough only

function env({ git = true } = {}) {
  const root = tmp("hermes-git-inst-");
  const integ = writeIntegrations(git ? { ...HTTP, git_url: "https://git.example", git_roles: { "code-agent": git === true ? "fork" : git } } : HTTP, root);
  const cfg = join(root, "config.env");
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`,
    `VBCDX_AGENTS_HERMES_HOME=${root}/hermes`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${integ}`].join("\n") + "\n");
  return { root, cfg, prof: join(root, "hermes", "profiles", "code-agent") };
}

test("the installer writes bin/hermes-git 0755 and adds the passthrough to an existing profile as an update", () => {
  const e = env({ git: false });
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=code-agent"]);
  const conf = join(e.prof, "config.yaml");
  // the operator's own terminal setting, saved by Hermes Web UI
  const doc = parsePy(readFileSync(conf, "utf8"));
  doc.terminal = { timeout: 300 };
  writeFileSync(conf, stringifyPy(doc));
  // now with git_url
  const withGit = env();
  writeFileSync(e.cfg, readFileSync(e.cfg, "utf8").replace(/VBCDX_AGENTS_INTEGRATIONS_FILE=.*/, `VBCDX_AGENTS_INTEGRATIONS_FILE=${join(withGit.root, "integrations.json")}`));
  const report = init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=code-agent"]);
  assert.equal(report.generated.find((g) => g.destination === conf).action, "update");
  assert.deepEqual(parsePy(readFileSync(conf, "utf8")).terminal, { timeout: 300, env_passthrough: ["VBCDX_FORGEJO_TOKEN"] });
  const helper = join(e.prof, "bin", "hermes-git");
  assert.equal(statSync(helper).mode & 0o777, 0o755);
  // a rerun changes nothing
  const again = init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=code-agent"]);
  assert.ok(again.generated.filter((g) => g.destination.startsWith(e.prof)).every((g) => g.action === "noop"));
});

test("removing git_url drops the passthrough, and an emptied terminal map with it", () => {
  const e = env();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=code-agent"]);
  const conf = join(e.prof, "config.yaml");
  assert.deepEqual(parsePy(readFileSync(conf, "utf8")).terminal, { env_passthrough: ["VBCDX_FORGEJO_TOKEN"] });
  const noGit = env({ git: false });
  writeFileSync(e.cfg, readFileSync(e.cfg, "utf8").replace(/VBCDX_AGENTS_INTEGRATIONS_FILE=.*/, `VBCDX_AGENTS_INTEGRATIONS_FILE=${join(noGit.root, "integrations.json")}`));
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=code-agent"]);
  assert.equal(Object.hasOwn(parsePy(readFileSync(conf, "utf8")), "terminal"), false);
});

// ---- the helper itself: python3 + git against a stub Forgejo API and bare repositories

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
// The helper talks to the stub API in this process: it must run asynchronously, or the
// blocked event loop would never answer it.
function runAsync(cmd, args, { input, ...opts } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input || "");
  });
}
const writeTmp = (content) => { const p = join(tmp("hermes-git-src-"), "hermes-git.py"); writeFileSync(p, content); return p; };
const writeTmpNamed = (content, name) => { const p = join(tmp("hermes-git-src-"), name); writeFileSync(p, content); return p; };
// The one probe answer an HTTP stub cannot produce without a 60 s wait: a socket read that never
// returns. This driver runs the REAL rendered helper and injects the exact exception a hung read
// raises (TimeoutError), so the timeout arm is exercised for real without the wall-clock wait.
const HUNG_READ_DRIVER = `import contextlib, io, json, runpy, sys
g = runpy.run_path(sys.argv[1], run_name="hermes_probe")

class Hung:
    def open(self, req, timeout=None):
        raise TimeoutError("timed out")

g["assert_read_token_scope"].__globals__["OPENER"] = Hung()
err = io.StringIO()
code = 0
try:
    with contextlib.redirect_stderr(err):
        g["assert_read_token_scope"]()
except SystemExit as e:
    code = e.code if isinstance(e.code, int) else 1
print(json.dumps({"code": code, "stderr": err.getvalue()}))
`;
// The push check's hung read, injected the same way.
const HUNG_PUSH_DRIVER = HUNG_READ_DRIVER
  .replace('g["assert_read_token_scope"].__globals__', 'g["assert_cannot_push"].__globals__')
  .replace('g["assert_read_token_scope"]()', 'g["assert_cannot_push"]("org/proj", {})');
const gitOk = (args, cwd, extra = {}) => {
  const r = run("git", args, { cwd, ...extra });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

async function forge({ mode = "fork", overScoped = false, userStatus, userBody, userRedirect, userTruncate,
  canPush, pushStatus, pushType, pushRedirect, pushDrop, repoFlags, blanket403, controlStatus } = {}) {
  const dir = tmp("hermes-git-forge-");
  const repos = join(dir, "repos");
  // org/proj with one commit on main
  const seed = join(dir, "seed");
  mkdirSync(seed);
  gitOk(["init", "-q", "-b", "main"], seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], seed);
  gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], seed);
  mkdirSync(join(repos, "org"), { recursive: true });
  gitOk(["clone", "-q", "--bare", seed, join(repos, "org", "proj.git")], dir);
  const state = { pulls: [], forks: 0, auth: [], pushChecks: [] };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // git's push discovery, answered like Forgejo's httpBase: Basic auth with the token as the
      // password; 403 unless the token's scope reaches write:repository, else the receive-pack
      // advertisement. canPush defaults to what the token is: broad in fork mode or when overScoped.
      // pushStatus / pushType / pushRedirect / pushDrop drive the check's other outcomes.
      if (/^\/[^/]+\/[^/]+\.git\/info\/refs\?service=git-receive-pack$/.test(req.url)) {
        state.pushChecks.push(req.headers.authorization);
        if (pushRedirect) { res.writeHead(302, { Location: pushRedirect }); return res.end(); }
        if (pushDrop) return res.destroy();
        // blanket403: an intermediary that answers 403 to this path whatever the credential.
        if (blanket403) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("Forbidden\n"); }
        if (req.headers.authorization !== `Basic ${Buffer.from("hermes-git-read:tok-123").toString("base64")}`) {
          if (controlStatus !== undefined) { res.writeHead(controlStatus, { "Content-Type": "text/plain" }); return res.end("x\n"); }
          res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("Unauthorized\n");
        }
        if (pushStatus !== undefined) { res.writeHead(pushStatus, { "Content-Type": pushType || "text/plain" }); return res.end("x\n"); }
        if (!(canPush ?? (mode !== "read" || overScoped))) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("Forbidden\n"); }
        res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-advertisement" });
        return res.end("001f# service=git-receive-pack\n0000");
      }
      state.auth.push(req.headers.authorization);
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "token tok-123") return send(401, { message: "bad token" });
      const p = req.url.replace(/^\/api\/v1/, "");
      const has = (full) => existsSync(join(repos, `${full}.git`));
      // a read:repository token cannot read its account on Forgejo: the read helper must not need it
      // overScoped models a broad token in read mode, which the read-only clone must refuse.
      // userStatus / userBody / userRedirect / userTruncate drive the probe's other outcomes (2900 B1).
      if (p === "/user") {
        if (userRedirect) { res.writeHead(302, { Location: userRedirect, "Content-Type": "application/json" }); return res.end("{}"); }
        if (userTruncate) { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" }); res.write('{"login":"bot"}'); return res.destroy(); }
        if (userStatus !== undefined) {
          res.writeHead(userStatus, { "Content-Type": "application/json" });
          return res.end(userBody === undefined ? JSON.stringify({ message: "x" }) : userBody);
        }
        return mode === "read" && !overScoped ? send(403, { message: "token does not have at least one of required scope(s): [read:user]" }) : send(200, { login: "bot", email: "bot@x" });
      }
      let m;
      if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && req.method === "GET") {
        const full = `${m[1]}/${m[2]}`;
        if (!has(full)) return send(404, {});
        if (full === "bot/proj") return send(200, { full_name: full, fork: !state.notFork, parent: state.notFork ? null : { full_name: "org/proj" } });
        return send(200, { full_name: full, default_branch: "main", fork: false, ...(repoFlags || {}) });
      }
      if (p === "/repos/org/proj/forks" && req.method === "POST") {
        state.forks += 1;
        mkdirSync(join(repos, "bot"), { recursive: true });
        gitOk(["clone", "-q", "--bare", join(repos, "org", "proj.git"), join(repos, "bot", "proj.git")], dir);
        return send(202, { full_name: "bot/proj" });
      }
      if ((m = p.match(/^\/repos\/bot\/proj\/branches\/(.+)$/))) {
        const r = run("git", ["rev-parse", "--verify", `refs/heads/${decodeURIComponent(m[1])}`], { cwd: join(repos, "bot", "proj.git") });
        return r.status === 0 ? send(200, { name: m[1] }) : send(404, {});
      }
      if (p === "/repos/org/proj/pulls" && req.method === "POST") {
        state.pulls.push(JSON.parse(body));
        return send(201, { number: 7, html_url: "http://forge/org/proj/pulls/7" });
      }
      return send(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const helper = join(dir, "hermes-git");
  writeFileSync(helper, renderHermesGit(base, mode));
  chmodSync(helper, 0o755);
  // git itself talks to file:// repos: rewrite the Forgejo URL, exactly as a user's insteadOf would
  // a read role's helper must use VBCDX_FORGEJO_GIT_TOKEN; its MCP token here is one the stub rejects
  const tokens = mode === "read"
    ? { VBCDX_FORGEJO_GIT_TOKEN: "tok-123", VBCDX_FORGEJO_GIT_TOKEN_SCOPE: "read:repository", VBCDX_FORGEJO_TOKEN: "tok-WRITE-not-for-git" }
    : { VBCDX_FORGEJO_TOKEN: "tok-123" };
  const gitEnv = { ...process.env, ...tokens, GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${repos}/.insteadOf`, GIT_CONFIG_VALUE_0: `${base}/`,
    GIT_TERMINAL_PROMPT: "0", HOME: dir, GIT_CONFIG_GLOBAL: join(dir, "gitconfig") };
  writeFileSync(join(dir, "gitconfig"), "");
  const hg = (args, cwd = dir, extra = {}, input) => runAsync("python3", [helper, ...args], { cwd, env: { ...gitEnv, ...extra }, input });
  return { dir, repos, base, state, hg, gitEnv, close: () => srv.close() };
}

test("clone forks once, keeps origin fetch-only, scopes the credential helper, and never stores the token", async () => {
  const f = await forge();
  try {
    const r = await f.hg(["clone", "org/proj", "work"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state.forks, 1);
    const w = join(f.dir, "work");
    assert.equal(gitOk(["remote", "get-url", "--push", "origin"], w, { env: f.gitEnv }), "PUSH-DISABLED--push-to-the-fork-remote-and-open-a-pr");
    assert.equal(gitOk(["remote", "get-url", "fork"], w), `${f.base}/bot/proj.git`);
    const cfg = readFileSync(join(w, ".git", "config"), "utf8");
    assert.match(cfg, new RegExp(`\\[credential "${f.base.replace(/[.]/g, "\\.")}"\\]`)); // scoped, not bare
    assert.doesNotMatch(cfg, /^\[credential\]$/m);
    assert.doesNotMatch(cfg, /tok-123/);
    // a second clone reuses the fork
    assert.equal((await f.hg(["clone", "org/proj", "work2"])).status, 0);
    assert.equal(f.state.forks, 1);
  } finally { f.close(); }
});

test("pushes reach only the fork: origin and an explicit org URL are refused", async () => {
  const f = await forge();
  try {
    assert.equal((await f.hg(["clone", "org/proj", "work"])).status, 0);
    const w = join(f.dir, "work");
    const g = (args) => run("git", args, { cwd: w, env: f.gitEnv });
    gitOk(["switch", "-q", "-c", "feat"], w, { env: f.gitEnv });
    writeFileSync(join(w, "x.txt"), "x\n");
    gitOk(["add", "."], w, { env: f.gitEnv });
    gitOk(["commit", "-q", "-m", "x"], w, { env: f.gitEnv });
    assert.notEqual(g(["push", "origin", "feat"]).status, 0);
    const explicit = g(["push", `${f.base}/org/proj.git`, "feat"]);
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /hermes-git: refused push/);
    assert.equal(run("git", ["rev-parse", "--verify", "refs/heads/feat"], { cwd: join(f.repos, "org", "proj.git") }).status === 0, false);
    // re-pointing the fork remote at the org repo does not get around it
    gitOk(["remote", "set-url", "fork", `${f.base}/org/proj.git`], w, { env: f.gitEnv });
    const repointed = g(["push", "fork", "feat"]);
    assert.notEqual(repointed.status, 0);
    assert.match(repointed.stderr, /fork remote no longer points at/);
    gitOk(["remote", "set-url", "fork", `${f.base}/bot/proj.git`], w, { env: f.gitEnv });
    const toFork = g(["push", "-q", "fork", "feat"]);
    assert.equal(toFork.status, 0, toFork.stderr);
    assert.equal(run("git", ["rev-parse", "--verify", "refs/heads/feat"], { cwd: join(f.repos, "bot", "proj.git") }).status, 0);
    // pr opens bot:feat -> org/proj main
    const pr = await f.hg(["pr", "--title", "Add x", "--body", "why"], w);
    assert.equal(pr.status, 0, pr.stderr);
    assert.deepEqual(f.state.pulls, [{ head: "bot:feat", base: "main", title: "Add x", body: "why" }]);
    assert.match(pr.stdout, /pulls\/7/);
  } finally { f.close(); }
});

test("a push-URL re-point, a -c pushurl override and a later insteadOf rule cannot reach the org repo", async () => {
  const f = await forge();
  try {
    assert.equal((await f.hg(["clone", "org/proj", "work"])).status, 0);
    const w = join(f.dir, "work");
    const org = join(f.repos, "org", "proj.git");
    const g = (args) => run("git", args, { cwd: w, env: f.gitEnv });
    const landed = (ref) => run("git", ["rev-parse", "--verify", ref], { cwd: org }).status === 0;
    gitOk(["switch", "-q", "-c", "feat"], w, { env: f.gitEnv });
    writeFileSync(join(w, "x.txt"), "x\n");
    gitOk(["add", "."], w, { env: f.gitEnv });
    gitOk(["commit", "-q", "-m", "x"], w, { env: f.gitEnv });
    // 1. only the push URL moved (git remote set-url --push)
    gitOk(["remote", "set-url", "--push", "fork", `${f.base}/org/proj.git`], w, { env: f.gitEnv });
    const a = g(["push", "fork", "feat:refs/heads/via-pushurl"]);
    assert.notEqual(a.status, 0);
    assert.match(a.stderr, /separate push URL/);
    assert.equal(landed("refs/heads/via-pushurl"), false);
    gitOk(["config", "--unset-all", "remote.fork.pushurl"], w, { env: f.gitEnv });
    // 2. the same, per invocation
    const b = g(["-c", `remote.fork.pushurl=${f.base}/org/proj.git`, "push", "fork", "feat:refs/heads/via-c"]);
    assert.notEqual(b.status, 0);
    assert.equal(landed("refs/heads/via-c"), false);
    // 3. an insteadOf rule added after the clone that turns the fork URL into the org URL
    // straight to the org repo on disk: git does not chain insteadOf rules, and an http target
    // would call the in-process stub server while spawnSync blocks its event loop
    gitOk(["config", `url.file://${f.repos}/org/proj.git.insteadOf`, `${f.base}/bot/proj.git`], w, { env: f.gitEnv });
    const c = g(["push", "fork", "feat:refs/heads/via-insteadof"]);
    assert.notEqual(c.status, 0);
    assert.match(c.stderr, /now resolves to/);
    assert.equal(landed("refs/heads/via-insteadof"), false);
    gitOk(["config", "--unset", `url.file://${f.repos}/org/proj.git.insteadOf`], w, { env: f.gitEnv });
    // and the fork still works afterwards
    const ok = g(["push", "-q", "fork", "feat"]);
    assert.equal(ok.status, 0, ok.stderr);
  } finally { f.close(); }
});

// A rewrite already in effect at clone time (env config here) is refused in the scratch repo, before
// any local clone exists. The fork itself is created by the API call that runs first.
for (const [label, key, target, reason] of [
  ["an insteadOf of the fork URL to the org repo", "insteadOf", "org/proj.git", /rewrites .*bot\/proj\.git to .*org\/proj\.git/],
  ["the same with pushInsteadOf, which `ls-remote --get-url` does not apply", "pushInsteadOf", "org/proj.git", /push URL of .*bot\/proj\.git to .*org\/proj\.git/],
  ["a rewrite to another path that merely ends in /bot/proj.git", "insteadOf", "elsewhere/bot/proj.git", /push URL of .*bot\/proj\.git to .*elsewhere\/bot\/proj\.git/],
]) {
  test(`clone refuses ${label}`, async () => {
    const f = await forge();
    try {
      const extra = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: `url.file://${f.repos}/${target}.${key}`, GIT_CONFIG_VALUE_1: `${f.base}/bot/proj.git` };
      const r = await f.hg(["clone", "org/proj", "work"], f.dir, extra);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, reason);
      assert.equal(existsSync(join(f.dir, "work")), false, "no local clone may be created");
    } finally { f.close(); }
  });
}

test("a hook directory that cannot be written is a clean error and leaves no unguarded fork remote", async () => {
  const f = await forge();
  try {
    const extra = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/proc/hermes-git-no-such/hooks" };
    const r = await f.hg(["clone", "org/proj", "work"], f.dir, extra);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not install the pre-push hook/);
    assert.doesNotMatch(r.stderr, /Traceback/);
    assert.doesNotMatch(gitOk(["remote"], join(f.dir, "work"), { env: f.gitEnv }), /^fork$/m);
  } finally { f.close(); }
});

test("a DIR that looks like a git option is a directory name, never an option", async () => {
  const f = await forge();
  try {
    const marker = join(f.dir, "PWNED");
    const d = await f.hg(["clone", "org/proj", `--upload-pack=touch ${marker}`]);
    assert.equal(existsSync(marker), false, d.stderr);
  } finally { f.close(); }
});

test("a whole-host rewrite is trusted: the hook bakes the rewritten fork URL and pushes land in the fork", async () => {
  // The harness itself rewrites the whole Forgejo host to file:// repos (forge() gitEnv).
  const f = await forge();
  try {
    assert.equal((await f.hg(["clone", "org/proj", "work"])).status, 0);
    const w = join(f.dir, "work");
    const hook = readFileSync(join(w, ".git", "hooks", "pre-push"), "utf8");
    assert.match(hook, new RegExp(`^expected='?file://${f.repos.replace(/[.]/g, "\\.")}/bot/proj\\.git'?$`, "m"));
    gitOk(["switch", "-q", "-c", "feat"], w, { env: f.gitEnv });
    writeFileSync(join(w, "x.txt"), "x\n");
    gitOk(["add", "."], w, { env: f.gitEnv });
    gitOk(["commit", "-q", "-m", "x"], w, { env: f.gitEnv });
    const p = run("git", ["push", "-q", "fork", "feat"], { cwd: w, env: f.gitEnv });
    assert.equal(p.status, 0, p.stderr);
    assert.equal(run("git", ["rev-parse", "--verify", "refs/heads/feat"], { cwd: join(f.repos, "bot", "proj.git") }).status, 0);
  } finally { f.close(); }
});

test("a rewrite scoped to a branch (includeIf onbranch) passes clone but is refused by the hook at push time", async () => {
  const f = await forge();
  try {
    assert.equal((await f.hg(["clone", "org/proj", "work"])).status, 0);
    const w = join(f.dir, "work");
    const rules = join(f.dir, "branch-rules");
    writeFileSync(rules, `[url "file://${f.repos}/org/proj.git"]\n\tinsteadOf = ${f.base}/bot/proj.git\n`);
    writeFileSync(join(f.dir, "gitconfig"), `[includeIf "onbranch:feat*"]\n\tpath = ${rules}\n`);
    gitOk(["switch", "-q", "-c", "feat"], w, { env: f.gitEnv });
    writeFileSync(join(w, "x.txt"), "x\n");
    gitOk(["add", "."], w, { env: f.gitEnv });
    gitOk(["commit", "-q", "-m", "x"], w, { env: f.gitEnv });
    const p = run("git", ["push", "fork", "feat:refs/heads/via-onbranch"], { cwd: w, env: f.gitEnv });
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /now resolves to .*org\/proj\.git/);
    assert.equal(run("git", ["rev-parse", "--verify", "refs/heads/via-onbranch"], { cwd: join(f.repos, "org", "proj.git") }).status === 0, false);
  } finally { f.close(); }
});

test("an exported GIT_DIR / GIT_WORK_TREE does not redirect clone or its checks to another repository", async () => {
  const f = await forge();
  try {
    const decoy = join(f.dir, "decoy");
    mkdirSync(decoy);
    gitOk(["init", "-q", decoy]);
    const r = await f.hg(["clone", "org/proj", "work"], f.dir, { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(gitOk(["remote"], decoy), "", "the decoy must not get any remote");
    const w = join(f.dir, "work");
    assert.equal(gitOk(["remote", "get-url", "fork"], w), `${f.base}/bot/proj.git`);
    assert.ok(existsSync(join(w, ".git", "hooks", "pre-push")), "the hook goes into the clone");
  } finally { f.close(); }
});

test("a rewrite scoped to the clone (includeIf gitdir / hasconfig) is caught inside the clone", async () => {
  const f = await forge();
  try {
    const org = join(f.repos, "org", "proj.git");
    const rules = join(f.dir, "scoped-rules");
    writeFileSync(rules, `[url "file://${f.repos}/org/proj.git"]\n\tinsteadOf = ${f.base}/bot/proj.git\n`);
    const cases = [
      ["work-g", `gitdir:${f.dir}/work-g/`],
      ["work-c", `hasconfig:remote.*.url:${f.base}/org/proj.git`],
    ];
    for (const [dest, cond] of cases) {
      // global config, where a user (or anything that edits ~/.gitconfig) would put it
      writeFileSync(join(f.dir, "gitconfig"), `[includeIf "${cond}"]\n\tpath = ${rules}\n`);
      const r = await f.hg(["clone", "org/proj", dest]);
      assert.notEqual(r.status, 0, `${cond}: clone must be refused`);
      assert.match(r.stderr, /push URL of .*bot\/proj\.git to .*org\/proj\.git/, cond);
      assert.match(r.stderr, /has no fork remote/, cond);
      const w = join(f.dir, dest);
      assert.doesNotMatch(gitOk(["remote"], w, { env: f.gitEnv }), /^fork$/m, `${cond}: no fork remote may remain`);
      // and a push by name has nowhere to go
      gitOk(["switch", "-q", "-c", "feat"], w, { env: f.gitEnv });
      writeFileSync(join(w, "x.txt"), "x\n");
      gitOk(["add", "."], w, { env: f.gitEnv });
      gitOk(["commit", "-q", "-m", "x"], w, { env: f.gitEnv });
      assert.notEqual(run("git", ["push", "fork", `feat:refs/heads/${dest}`], { cwd: w, env: f.gitEnv }).status, 0);
      assert.equal(run("git", ["rev-parse", "--verify", `refs/heads/${dest}`], { cwd: org }).status === 0, false, `${cond}: landed in the org repo`);
    }
    // without the scoped rule the same clone works
    writeFileSync(join(f.dir, "gitconfig"), "");
    assert.equal((await f.hg(["clone", "org/proj", "work-ok"])).status, 0);
  } finally { f.close(); }
});

test("pr refuses a branch that is not on the fork; clone refuses a same-named repo that is not a fork", async () => {
  const f = await forge();
  try {
    assert.equal((await f.hg(["clone", "org/proj", "work"])).status, 0);
    const w = join(f.dir, "work");
    gitOk(["switch", "-q", "-c", "unpushed"], w, { env: f.gitEnv });
    const pr = await f.hg(["pr", "--title", "t"], w);
    assert.notEqual(pr.status, 0);
    assert.match(pr.stderr, /not on your fork yet: git push fork unpushed/);
    assert.deepEqual(f.state.pulls, []);
    f.state.notFork = true;
    const c = await f.hg(["clone", "org/proj", "work3"]);
    assert.notEqual(c.status, 0);
    assert.match(c.stderr, /exists but is not a fork of org\/proj/);
  } finally { f.close(); }
});

// ---- git_roles and read-only clones

test("git_roles is validated: needs git_url, an object, bound roles, read|fork only", () => {
  const bad = (svc, re) => assert.throws(() => loadIntegrations(writeIntegrations(svc)), re);
  bad({ ...HTTP, git_roles: { "code-agent": "fork" } }, /git_roles needs git_url/);
  const G = { ...HTTP, git_url: "https://git.example" };
  bad({ ...G, git_roles: ["code-agent"] }, /git_roles must be an object/);
  bad({ ...G, git_roles: "fork" }, /git_roles must be an object/);
  bad({ ...G, git_roles: { "Not A Role": "read" } }, /not a role of a loaded agent pack/);
  bad({ ...G, git_roles: { "review-agent": "read" } }, /not in the service's roles/);
  bad({ ...G, git_roles: { "code-agent": "write" } }, /must be "read" or "fork"/);
  bad({ ...G, git_roles: { "code-agent": true } }, /must be "read" or "fork"/);
  assert.deepEqual({ ...loadIntegrations(writeIntegrations({ ...G, git_roles: { "code-agent": "read" } })).services.forgejo.gitRoles }, { "code-agent": "read" });
});

test("a read role gets only VBCDX_FORGEJO_GIT_TOKEN, the read-only helper and note; an unlisted bound role gets nothing", () => {
  const svc = { ...HTTP, roles: ["code-agent", "review-agent"], git_url: "https://git.example", git_roles: { "review-agent": "read" } };
  const integrations = loadIntegrations(writeIntegrations(svc));
  const r = files(renderHermes(getRole("review-agent"), { integrations }));
  // the read token, plus the scope declaration hermes-git requires before it clones
  assert.deepEqual(parsePy(r["config.yaml"].content).terminal, { env_passthrough: ["VBCDX_FORGEJO_GIT_TOKEN", "VBCDX_FORGEJO_GIT_TOKEN_SCOPE"] });
  // the profile's forgejo MCP binding is the read role's only other credential: the same read key
  assert.deepEqual(parsePy(r["config.yaml"].content).mcp_servers.forgejo.headers, { Authorization: "Bearer ${VBCDX_FORGEJO_GIT_TOKEN}" });
  for (const f of Object.values(r)) assert.equal(f.content.includes("VBCDX_FORGEJO_TOKEN"), false, `${f.name} names the write credential`);
  assert.match(r["bin/hermes-git"].content, /^GIT_MODE = "read"$/m);
  assert.match(r["bin/hermes-git"].content, /^TOKEN_ENV = "VBCDX_FORGEJO_GIT_TOKEN"$/m);
  assert.match(r["bin/hermes-git"].content, /^SCOPE_ENV = "VBCDX_FORGEJO_GIT_TOKEN_SCOPE"$/m);
  assert.match(r["bin/hermes-git"].content, new RegExp(`^READ_SCOPE = ${JSON.stringify(HERMES_GIT_READ_SCOPE)}$`, "m"));
  // The value comes from the renderer's constant, not a second literal in the asset.
  assert.match(readFileSync(new URL("../assets/hermes/hermes-git.py", import.meta.url), "utf8"), /^READ_SCOPE = "@@READ_SCOPE@@"$/m);
  assert.doesNotMatch(r["bin/hermes-git"].content, /@@/);
  assert.match(r["SOUL.md"].content, /## Git: read-only clones/);
  assert.match(r["SOUL.md"].content, /clone --read-only/);
  // code-agent is bound to forgejo but not listed in git_roles
  const c = files(renderHermes(getRole("code-agent"), { integrations }));
  assert.equal(parsePy(c["config.yaml"].content).terminal, undefined);
  assert.deepEqual(parsePy(c["config.yaml"].content).mcp_servers.forgejo.headers, { Authorization: "Bearer ${VBCDX_FORGEJO_TOKEN}" });
  assert.equal(c["bin/hermes-git"], undefined);
  assert.doesNotMatch(c["SOUL.md"].content, /hermes-git/);
  assert.throws(() => renderHermesGit("https://git.example", "write"), /mode must be/);
  // No default mode — the write-capable helper is never what an omitted argument gets
  assert.throws(() => renderHermesGit("https://git.example"), /mode must be/);
});

test("every role rendered as a read git role names no write-capable credential, in any file", () => {
  // All sixteen roles are bound to forgejo and mapped "read", so the renderer sees every role-name
  // shape the mapping can produce. The invariant is asserted over the rendered BYTES of every file -
  // the way the security pass read them (od/grep) - not over a parsed key.
  const svc = { ...HTTP, roles: [...FIXTURE_IDS], git_url: "https://git.example",
    git_roles: Object.fromEntries(FIXTURE_IDS.map((id) => [id, "read"])) };
  const integrations = loadIntegrations(writeIntegrations(svc));
  for (const id of FIXTURE_IDS) {
    for (const f of renderHermes(getRole(id), { integrations }).files) {
      assert.equal(Buffer.from(f.content, "utf8").includes(Buffer.from("VBCDX_FORGEJO_TOKEN")), false,
        `${id}: ${f.name} names the write-capable credential`);
    }
  }
  // and the binding this fix is about: a read role's bearer header resolves to the read key
  const cfg = parsePy(files(renderHermes(getRole("review-agent"), { integrations }))["config.yaml"].content);
  assert.deepEqual(cfg.mcp_servers.forgejo.headers, { Authorization: "Bearer ${VBCDX_FORGEJO_GIT_TOKEN}" });
  assert.deepEqual(cfg.terminal, { env_passthrough: ["VBCDX_FORGEJO_GIT_TOKEN", "VBCDX_FORGEJO_GIT_TOKEN_SCOPE"] });
});

test("the role-name shapes of git_roles: exact read, exact fork, absent, and the rejected variants", () => {
  const G = { ...HTTP, git_url: "https://git.example" };
  // exact match, "read": narrowed in both places (above). Absent from the map: no git at all, and the
  // role keeps its own binding token - no shape silently resolves to another mode.
  const absent = files(renderHermes(getRole("code-agent"),
    { integrations: loadIntegrations(writeIntegrations({ ...G, roles: ["code-agent", "review-agent"], git_roles: { "review-agent": "read" } })) }));
  assert.equal(parsePy(absent["config.yaml"].content).terminal, undefined);
  assert.equal(absent["bin/hermes-git"], undefined);
  assert.deepEqual(parsePy(absent["config.yaml"].content).mcp_servers.forgejo.headers, { Authorization: "Bearer ${VBCDX_FORGEJO_TOKEN}" });
  // exact match, "fork": the role's own token in both places, deliberately
  const fork = files(renderHermes(getRole("review-agent"),
    { integrations: loadIntegrations(writeIntegrations({ ...G, roles: ["review-agent"], git_roles: { "review-agent": "fork" } })) }));
  assert.deepEqual(parsePy(fork["config.yaml"].content).terminal, { env_passthrough: ["VBCDX_FORGEJO_TOKEN"] });
  assert.deepEqual(parsePy(fork["config.yaml"].content).mcp_servers.forgejo.headers, { Authorization: "Bearer ${VBCDX_FORGEJO_TOKEN}" });
  // case, whitespace, underscore and mode variants are refused at load: never silently resolved
  const bad = (map, re) => assert.throws(() => loadIntegrations(writeIntegrations({ ...G, roles: ["review-agent"], git_roles: map })), re);
  bad({ "Review-Agent": "read" }, /not a role of a loaded agent pack/);
  bad({ " review-agent": "read" }, /not a role of a loaded agent pack/);
  bad({ "review-agent ": "read" }, /not a role of a loaded agent pack/);
  bad({ review_agent: "read" }, /not a role of a loaded agent pack/);
  bad({ "review-agent": " read" }, /must be "read" or "fork"/);
  bad({ "review-agent": "READ" }, /must be "read" or "fork"/);
  bad({ "review-agent": true }, /must be "read" or "fork"/);
});

test("clone --read-only makes no fork, keeps no push path, and refuses pr and pushes", async () => {
  const f = await forge({ mode: "read" });
  try {
    const r = await f.hg(["clone", "--read-only", "org/proj", "ro"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state.forks, 0, "a read-only clone never forks");
    // Forgejo refused the token a push before the clone: Basic auth, as git sends it; then the
    // same request with a deliberately invalid token showed that 403 was the scope check's.
    assert.equal(f.state.pushChecks.length, 2);
    assert.equal(f.state.pushChecks[0], `Basic ${Buffer.from("hermes-git-read:tok-123").toString("base64")}`);
    assert.match(Buffer.from(f.state.pushChecks[1].replace(/^Basic /, ""), "base64").toString(), /^hermes-git-read:invalid-[0-9a-f]{40}$/);
    const w = join(f.dir, "ro");
    assert.equal(gitOk(["remote", "get-url", "--push", "origin"], w, { env: f.gitEnv }), "PUSH-DISABLED--push-to-the-fork-remote-and-open-a-pr");
    assert.doesNotMatch(gitOk(["remote"], w, { env: f.gitEnv }), /^fork$/m);
    gitOk(["switch", "-q", "-c", "feat"], w, { env: f.gitEnv });
    writeFileSync(join(w, "x.txt"), "x\n");
    gitOk(["add", "."], w, { env: f.gitEnv });
    gitOk(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], w, { env: f.gitEnv });
    const p = run("git", ["push", `${f.base}/org/proj.git`, "feat"], { cwd: w, env: f.gitEnv });
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /read-only clone/);
    assert.equal(run("git", ["rev-parse", "--verify", "refs/heads/feat"], { cwd: join(f.repos, "org", "proj.git") }).status === 0, false);
    const pr = await f.hg(["pr", "--title", "x"], w);
    assert.notEqual(pr.status, 0);
    assert.match(pr.stderr, /read-only clone/);
    assert.deepEqual(f.state.pulls, []);
  } finally { f.close(); }
});

test("a read role cannot fork-clone, and its helper uses only the read token (fails closed without it)", async () => {
  const f = await forge({ mode: "read" });
  try {
    const r = await f.hg(["clone", "org/proj", "w"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /clones read-only/);
    assert.equal(f.state.forks, 0);
    // the credential helper answers with VBCDX_FORGEJO_GIT_TOKEN and needs no account lookup
    const u = new URL(f.base);
    const cred = await f.hg(["credential", "get"], f.dir, {}, `protocol=${u.protocol.slice(0, -1)}\nhost=${u.host}\n\n`);
    assert.equal(cred.status, 0, cred.stderr);
    assert.match(cred.stdout, /^username=hermes-git-read$/m);
    assert.match(cred.stdout, /^password=tok-123$/m);
    assert.doesNotMatch(cred.stdout, /tok-WRITE/);
    // missing read token: a clear error naming the key
    const none = await f.hg(["clone", "--read-only", "org/proj", "w2"], f.dir, { VBCDX_FORGEJO_GIT_TOKEN: "" });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /VBCDX_FORGEJO_GIT_TOKEN is not set.*scoped read:repository only/s);
  } finally { f.close(); }
});

test("a read-only clone fails closed with a token that is not read-scoped", async () => {
  const f = await forge({ mode: "read", overScoped: true });
  try {
    // here the read token CAN read the account (the stub answers 200 to /user), so it is broader than
    // read:repository-only: the clone must refuse instead of running git with an over-scoped token
    const r = await f.hg(["clone", "--read-only", "org/proj", "ro"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /VBCDX_FORGEJO_GIT_TOKEN is not scoped read:repository only/);
    assert.equal(existsSync(join(f.dir, "ro")), false, "nothing may be cloned with an over-scoped token");
    assert.equal(f.state.forks, 0);
  } finally { f.close(); }
});

// A token whose scope set is write:repository but has no user-group scope answers 403 to /user,
// exactly like a read:repository token. The declaration says read:repository too. Only the push check
// against the repository tells them apart, and it must stop the helper before git clones anything.
test("a token that /user answers 403 for but that can push is refused before the clone", async () => {
  const f = await forge({ mode: "read", canPush: true });
  try {
    const r = await f.hg(["clone", "--read-only", "org/proj", "ro"]);
    assert.notEqual(r.status, 0, "a push-capable read token must be refused");
    assert.match(r.stderr, /VBCDX_FORGEJO_GIT_TOKEN can push to org\/proj/);
    assert.doesNotMatch(r.stderr, /Traceback/);
    assert.equal(f.state.pushChecks.length, 1, "Forgejo was asked once");
    assert.equal(existsSync(join(f.dir, "ro")), false, "the helper never reached the clone");
    assert.equal(f.state.forks, 0);
  } finally { f.close(); }
});

test("the read SOUL note states the git-only boundary and the read scope", () => {
  const svc = { ...HTTP, roles: ["review-agent"], git_url: "https://git.example", git_roles: { "review-agent": "read" } };
  const r = files(renderHermes(getRole("review-agent"), { integrations: loadIntegrations(writeIntegrations(svc)) }));
  const soul = r["SOUL.md"].content;
  assert.match(soul, /VBCDX_FORGEJO_GIT_TOKEN/);
  assert.match(soul, /read:repository/);
  assert.match(soul, /branch protection/i);
  // the read note must not tell the role that git uses the MCP token
  assert.doesNotMatch(soul, /VBCDX_FORGEJO_TOKEN/);
});

test("the read-mode help names the read token and marks the fork-only commands", async () => {
  const f = await forge({ mode: "read" });
  try {
    const h = await f.hg([]);
    assert.equal(h.status, 2); // no command: the module docstring is the help
    assert.match(h.stdout, /token comes from VBCDX_FORGEJO_GIT_TOKEN in the environment/);
    assert.doesNotMatch(h.stdout, /VBCDX_FORGEJO_TOKEN/);
    assert.match(h.stdout, /"fork" roles only/);
  } finally { f.close(); }
});

test("the read-scope probe never forwards the token across a redirect", async () => {
  const received = [];
  const other = createServer((req, res) => {
    received.push(req.headers.authorization);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ login: "bot" }));
  });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const f = await forge({ mode: "read", userRedirect: `http://127.0.0.1:${other.address().port}/api/v1/user` });
  try {
    const r = await f.hg(["clone", "--read-only", "org/proj", "ro"]);
    assert.notEqual(r.status, 0, "a redirect must be refused, not followed");
    assert.match(r.stderr, /redirect would send VBCDX_FORGEJO_GIT_TOKEN to another host/);
    assert.doesNotMatch(r.stderr, /Traceback/);
    assert.equal(existsSync(join(f.dir, "ro")), false, "nothing may be cloned");
    assert.deepEqual(received, [], "the redirect target must receive nothing, let alone the token");
    assert.deepEqual(f.state.auth, ["token tok-123"], "only the Forgejo host saw the token");
  } finally { f.close(); other.close(); }
});

test("the read-scope probe refuses by name on a server error, on a dead API and on a truncated body (2900 B1/F2)", async () => {
  // a 500 cannot establish anything: refuse, by name, before git runs
  const f = await forge({ mode: "read", userStatus: 500, userBody: JSON.stringify({ message: "boom" }) });
  try {
    const r = await f.hg(["clone", "--read-only", "org/proj", "ro"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /GET \/user: HTTP 500: cannot establish that VBCDX_FORGEJO_GIT_TOKEN is scoped read:repository only/);
    assert.doesNotMatch(r.stderr, /Traceback/);
    assert.equal(existsSync(join(f.dir, "ro")), false, "nothing may be cloned");
  } finally { f.close(); }
  // the API is unreachable (server closed): refused, by name, not a traceback
  const g = await forge({ mode: "read" });
  g.close();
  const dead = await g.hg(["clone", "--read-only", "org/proj", "ro"]);
  assert.notEqual(dead.status, 0);
  assert.match(dead.stderr, /GET \/user: .*(Connection refused|Errno 111)/);
  assert.doesNotMatch(dead.stderr, /Traceback/);
  assert.equal(existsSync(join(g.dir, "ro")), false, "nothing may be cloned");
  // a response that ends early is a named refusal too (OSError / http.client.HTTPException)
  const t = await forge({ mode: "read", userTruncate: true });
  try {
    const truncated = await t.hg(["clone", "--read-only", "org/proj", "ro"]);
    assert.notEqual(truncated.status, 0);
    assert.match(truncated.stderr, /GET \/user: /);
    assert.doesNotMatch(truncated.stderr, /Traceback/);
    assert.equal(existsSync(join(t.dir, "ro")), false, "nothing may be cloned");
  } finally { t.close(); }
});

// ---- the read-scope probe: the whole answer table, one row per outcome
//
// Every row drives the REAL rendered read helper through its pre-clone checks and fixes the verdict:
// refuse, or proceed. A row the helper gets wrong breaks exactly that row's assertion.
test("the read-scope checks answer the whole table: refuse, or proceed", async () => {
  const rows = [
    { name: "403 to /user and 403 to the push check, declared read:repository -> proceed", opts: {}, verdict: "proceed" },
    { name: "403 to /user but the token can push -> refuse", opts: { canPush: true }, verdict: "refuse",
      matches: /VBCDX_FORGEJO_GIT_TOKEN can push to org\/proj: Forgejo accepted it for git-receive-pack/ },
    { name: "a 403 whatever the credential (a proxy in front) -> refuse: the 403 proves nothing",
      opts: { blanket403: true }, verdict: "refuse",
      matches: /push check: HTTP 403 for VBCDX_FORGEJO_GIT_TOKEN, and HTTP 403 for a deliberately invalid token: something in front of .* answers 403 whatever the credential/ },
    { name: "an invalid token that gets 500 -> refuse: the 403 is not shown to be the scope check's",
      opts: { controlStatus: 500 }, verdict: "refuse", matches: /and HTTP 500 for a deliberately invalid token/ },
    { name: "an invalid token that gets 200 -> refuse", opts: { controlStatus: 200 }, verdict: "refuse",
      matches: /and HTTP 200 for a deliberately invalid token/ },
    { name: "an invalid token that gets 404 -> proceed: a Forgejo that hides the repository",
      opts: { controlStatus: 404 }, verdict: "proceed" },
    { name: "push check 401 -> refuse by name", opts: { pushStatus: 401 }, verdict: "refuse",
      matches: /push check: HTTP 401: .*rejected VBCDX_FORGEJO_GIT_TOKEN/ },
    { name: "push check 404 -> refuse by name", opts: { pushStatus: 404 }, verdict: "refuse",
      matches: /push check: HTTP 404: cannot establish that VBCDX_FORGEJO_GIT_TOKEN is unable to push to org\/proj/ },
    { name: "push check 500 -> refuse by name", opts: { pushStatus: 500 }, verdict: "refuse",
      matches: /push check: HTTP 500: cannot establish/ },
    { name: "push check redirect -> refuse before git runs", opts: { pushRedirect: "https://evil.example/x" }, verdict: "refuse",
      matches: /push check: HTTP 302: a redirect would send VBCDX_FORGEJO_GIT_TOKEN to another host/ },
    { name: "push check 200 that is not an advertisement -> refuse, and do not blame the token",
      opts: { pushStatus: 200, pushType: "text/html" }, verdict: "refuse",
      matches: /answered 200 with something that is not a receive-pack advertisement/, notMatches: /can push to/ },
    { name: "push check connection dropped -> refuse by name, no traceback", opts: { pushDrop: true }, verdict: "refuse",
      matches: /push check: .*cannot establish/, notMatches: /Traceback/ },
    { name: "an archived repository -> refuse: its 403 proves nothing", opts: { repoFlags: { archived: true } }, verdict: "refuse",
      matches: /org\/proj is archived: Forgejo refuses every push to it whatever the token/ },
    { name: "a mirror -> refuse: its 403 proves nothing", opts: { repoFlags: { mirror: true } }, verdict: "refuse",
      matches: /org\/proj is a mirror: Forgejo refuses every push to it whatever the token/ },
    { name: "403 without the declaration -> refuse", opts: {},
      env: { VBCDX_FORGEJO_GIT_TOKEN_SCOPE: "" }, verdict: "refuse",
      matches: /VBCDX_FORGEJO_GIT_TOKEN_SCOPE is not set: a read-only clone proceeds only for a token declared scoped read:repository only/ },
    { name: "403 with a declaration that is not read:repository -> refuse", opts: {},
      env: { VBCDX_FORGEJO_GIT_TOKEN_SCOPE: "read:user" }, verdict: "refuse",
      matches: /VBCDX_FORGEJO_GIT_TOKEN_SCOPE is 'read:user'/ },
    { name: "401 (the host rejected the token) -> refuse by name", opts: { userStatus: 401 }, verdict: "refuse",
      matches: /GET \/user: HTTP 401: .*rejected VBCDX_FORGEJO_GIT_TOKEN/ },
    { name: "500 -> refuse by name", opts: { userStatus: 500 }, verdict: "refuse",
      matches: /GET \/user: HTTP 500: cannot establish that VBCDX_FORGEJO_GIT_TOKEN is scoped read:repository only/ },
    { name: "a 200 user object (the token can read the account) -> refuse", opts: { overScoped: true }, verdict: "refuse",
      matches: /VBCDX_FORGEJO_GIT_TOKEN is not scoped read:repository only: it can read the account/ },
    { name: "a non-JSON 200 -> refuse, and do not blame the token",
      opts: { userStatus: 200, userBody: "<html><body>sign in</body></html>" }, verdict: "refuse",
      matches: /answered 200 with something that is not this API's user object/, notMatches: /is not scoped read:repository only/ },
    { name: "an empty 200 -> refuse, and do not blame the token",
      opts: { userStatus: 200, userBody: "" }, verdict: "refuse",
      matches: /answered 200 with something that is not this API's user object/, notMatches: /is not scoped read:repository only/ },
    { name: "a redirect -> refuse before git runs", opts: { userRedirect: "https://evil.example/api/v1/user" }, verdict: "refuse",
      matches: /redirect would send VBCDX_FORGEJO_GIT_TOKEN to another host/ },
    { name: "a truncated body -> refuse by name, no traceback", opts: { userTruncate: true }, verdict: "refuse",
      matches: /GET \/user: /, notMatches: /Traceback/ },
    { name: "a dead API -> refuse by name, no traceback", deadApi: true, verdict: "refuse",
      matches: /GET \/user: .*(Connection refused|Errno 111)/, notMatches: /Traceback/ },
  ];
  for (const row of rows) {
    const f = await forge({ mode: "read", ...(row.opts || {}) });
    if (row.deadApi) f.close();
    try {
      const r = await f.hg(["clone", "--read-only", "org/proj", "ro"], f.dir, row.env || {});
      assert.doesNotMatch(r.stdout + r.stderr, /Traceback/, `${row.name}: a traceback escaped the refusal`);
      if (row.verdict === "proceed") {
        assert.equal(r.status, 0, `${row.name}: expected the clone to proceed: ${r.stderr}`);
        // The token's request, then the control with a deliberately invalid token.
        assert.equal(f.state.pushChecks.length, 2, `${row.name}: the push check and its control did not both run`);
        const tokenCred = `Basic ${Buffer.from("hermes-git-read:tok-123").toString("base64")}`;
        assert.equal(f.state.pushChecks[0], tokenCred, `${row.name}: the first request carries the token`);
        assert.notEqual(f.state.pushChecks[1], tokenCred, `${row.name}: the control never carries the token`);
        assert.doesNotMatch(Buffer.from(f.state.pushChecks[1].replace(/^Basic /, ""), "base64").toString(), /tok-123/);
        assert.ok(existsSync(join(f.dir, "ro")), `${row.name}: the clone was not made`);
        assert.equal(f.state.forks, 0, `${row.name}: a read-only clone never forks`);
      } else {
        assert.notEqual(r.status, 0, `${row.name}: expected a refusal, got exit 0`);
        assert.equal(existsSync(join(f.dir, "ro")), false, `${row.name}: nothing may be cloned`);
        assert.match(r.stderr, row.matches, `${row.name}: wrong refusal message`);
        if (row.notMatches) assert.doesNotMatch(r.stderr, row.notMatches, `${row.name}: the message blamed the token`);
      }
    } finally {
      try { f.close(); } catch { /* the dead-API row closed it already */ }
    }
  }
  // The one answer the HTTP stub cannot make without a 60 s wait: a read that never returns. The
  // driver runs the real helper and injects the exact exception a hung socket read raises.
  const helper = writeTmpNamed(renderHermesGit("https://git.example", "read"), "hermes-git-hung.py");
  const driver = writeTmpNamed(HUNG_READ_DRIVER, "hung-read-driver.py");
  const hung = run("python3", [driver, helper], { env: { ...process.env,
    VBCDX_FORGEJO_GIT_TOKEN: "tok-123", VBCDX_FORGEJO_GIT_TOKEN_SCOPE: "read:repository" } });
  assert.equal(hung.status, 0, hung.stderr);
  const out = JSON.parse(hung.stdout.trim());
  assert.equal(out.code, 1, "a hung read must refuse");
  assert.match(out.stderr, /GET \/user: timed out after 60s: cannot establish that VBCDX_FORGEJO_GIT_TOKEN is scoped read:repository only/);
  assert.doesNotMatch(out.stderr, /Traceback/);
  // and the push check's
  const pushDriver = writeTmpNamed(HUNG_PUSH_DRIVER, "hung-push-driver.py");
  const hungPush = run("python3", [pushDriver, helper], { env: { ...process.env, VBCDX_FORGEJO_GIT_TOKEN: "tok-123" } });
  assert.equal(hungPush.status, 0, hungPush.stderr);
  const outPush = JSON.parse(hungPush.stdout.trim());
  assert.equal(outPush.code, 1, "a hung push check must refuse");
  assert.match(outPush.stderr, /push check: timed out after 60s: cannot establish that VBCDX_FORGEJO_GIT_TOKEN is unable to push to org\/proj/);
  assert.doesNotMatch(outPush.stderr, /Traceback/);
});

test("a 200 the read token answers is never blamed on the token when it is not this API's user object", async () => {
  const f = await forge({ mode: "read", userStatus: 200, userBody: "" });
  try {
    const r = await f.hg(["clone", "--read-only", "org/proj", "ro"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /answered 200 with something that is not this API's user object/);
    assert.doesNotMatch(r.stderr, /is not scoped read:repository only/, "an empty 200 is a proxy answer, not proof of scope");
    assert.equal(existsSync(join(f.dir, "ro")), false, "nothing may be cloned");
  } finally { f.close(); }
});

test("whoami is refused in read mode instead of dying on a raw 403", async () => {
  const f = await forge({ mode: "read" });
  try {
    const r = await f.hg(["whoami"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /whoami is for "fork" roles/);
    assert.doesNotMatch(r.stderr, /HTTP 403/);
  } finally { f.close(); }
});

test("git runs without the tracing environment, so the credential cannot reach a log", () => {
  const helper = writeTmp(renderHermesGit("https://git.example", "read"));
  const probe = "import runpy,sys,json; g=runpy.run_path(sys.argv[1], run_name='not_main'); print(json.dumps(sorted(k for k in g['GIT_ENV'] if k.startswith('GIT_TRACE') or k == 'GIT_CURL_VERBOSE')))";
  const r = run("python3", ["-c", probe, helper], { env: { ...process.env, GIT_TRACE: "1", GIT_TRACE_CURL: "1", GIT_TRACE2_EVENT: "/dev/null", GIT_TRACE_PACKET: "1", GIT_CURL_VERBOSE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), [], "no GIT_TRACE*/GIT_CURL_VERBOSE may reach git");
});

test("removing a role from git_roles drops its passthrough and its helper", () => {
  const e = env();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=code-agent"]);
  assert.ok(existsSync(join(e.prof, "bin", "hermes-git")));
  // same git_url, but code-agent no longer listed
  const noRole = env({ git: false });
  const integ = join(noRole.root, "integrations.json");
  writeFileSync(integ, readFileSync(integ, "utf8").replace('"roles":["code-agent"]', '"roles":["code-agent"],"git_url":"https://git.example","git_roles":{}'));
  writeFileSync(e.cfg, readFileSync(e.cfg, "utf8").replace(/VBCDX_AGENTS_INTEGRATIONS_FILE=.*/, `VBCDX_AGENTS_INTEGRATIONS_FILE=${integ}`));
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=code-agent"]);
  assert.equal(Object.hasOwn(parsePy(readFileSync(join(e.prof, "config.yaml"), "utf8")), "terminal"), false);
  // The helper the render no longer produces is removed, so no stale copy keeps the old mode.
  assert.equal(existsSync(join(e.prof, "bin", "hermes-git")), false);
});

test("credential helper answers only for the Forgejo origin, and needs the token", async () => {
  const f = await forge();
  try {
    const u = new URL(f.base);
    const ours = await f.hg(["credential", "get"], f.dir, {}, `protocol=http\nhost=${u.host}\n\n`);
    assert.equal(ours.status, 0, ours.stderr);
    assert.equal(ours.stdout, "username=bot\npassword=tok-123\n");
    const other = await f.hg(["credential", "get"], f.dir, {}, "protocol=https\nhost=github.com\n\n");
    assert.equal(other.stdout, "");
    const none = await f.hg(["whoami"], f.dir, { VBCDX_FORGEJO_TOKEN: "" });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /VBCDX_FORGEJO_TOKEN is not set.*terminal\.env_passthrough/);
  } finally { f.close(); }
});
