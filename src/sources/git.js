// Git access for `vbcdx fetch`. Build time only: nothing here runs
// during an install.
//
// A private repository's token reaches git the way a CI image build commonly passes it: an `http.<origin>/.extraheader` of `Authorization: token <value>` in the
// child's environment (GIT_CONFIG_COUNT/KEY/VALUE), scoped to that origin. It is never in
// argv, a URL, a config file or the store, and git's output is scrubbed of it before any
// message is built. A ref is resolved to a commit with `git ls-remote`, and the commit is
// fetched alone at depth 1, checked out, verified and stripped of `.git`.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { configError } from "../errors.js";
import { FULL_SHA_RE } from "./config.js";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

// Inherited variables git must not see: config (which could add headers), askpass helpers,
// and tracing, which writes request headers (the token among them) to a file or stderr.
const DROPPED_GIT_ENV = /^(?:GIT_CONFIG_.*|GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_ASKPASS|SSH_ASKPASS)$/;

/**
 * The child environment for one source: the caller's environment without those, no
 * terminal prompt, and the token header when there is a token and the URL is https.
 */
export function gitEnv(url, token, baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (!DROPPED_GIT_ENV.test(k)) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  if (token) {
    const u = new URL(url);
    if (u.protocol !== "https:") throw configError("A token is only sent to an https:// source.");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${u.origin}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: token ${token}`;
  }
  return env;
}

/**
 * Read a token from the named variable: a pasted trailing newline is dropped (a git
 * header cannot carry one); any other control character is refused.
 */
export function readToken(name, env = process.env) {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") throw configError(`${name} is not set; it holds the token for this source.`);
  const token = raw.replace(/[\r\n]+$/, "");
  if (/[\u0000-\u001f\u007f]/.test(token)) throw configError(`${name} holds a control character; it must be the token alone.`);
  return token;
}

function scrub(text, secret) {
  let out = String(text || "");
  if (secret) out = out.split(secret).join("<token>");
  return out.trim().split("\n").slice(-3).join(" | ");
}

function git(args, { env, cwd, secret, label }) {
  const res = spawnSync("git", args, { env, cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw configError(`${label}: git could not run (${res.error.code || res.error.message}).`);
  if (res.status !== 0) throw configError(`${label}: git ${args[0]} failed: ${scrub(res.stderr, secret) || `exit ${res.status}`}`);
  return res.stdout;
}

/**
 * Resolve a ref to a commit SHA. A full SHA is returned as is; a branch or tag is looked
 * up with ls-remote (an annotated tag is peeled). A name that is both is refused.
 */
export function resolveRef(url, ref, { env, secret, label }) {
  if (FULL_SHA_RE.test(ref)) return ref;
  const out = git(["ls-remote", "--", url, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], { env, secret, label });
  const refs = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (m) refs.set(m[2], m[1]);
  }
  const branch = refs.get(`refs/heads/${ref}`);
  const tag = refs.get(`refs/tags/${ref}^{}`) || refs.get(`refs/tags/${ref}`);
  if (branch && tag) throw configError(`${label}: ref ${ref} is both a branch and a tag; pin the commit by its full SHA, or rename one of them.`);
  if (!branch && !tag) throw configError(`${label}: no branch or tag named ${ref}.`);
  return branch || tag;
}

/** Fetch exactly `sha` into the new directory `dir`, check it out and remove `.git`. */
export function fetchCommit(url, sha, dir, { env, secret, label }) {
  git(["init", "-q", dir], { env, secret, label });
  git(["-C", dir, "fetch", "-q", "--depth=1", "--no-tags", "--", url, sha], { env, secret, label });
  git(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", "FETCH_HEAD"], { env, secret, label });
  const got = git(["-C", dir, "rev-parse", "HEAD"], { env, secret, label }).trim();
  if (got !== sha) throw configError(`${label}: checked out ${got}, expected ${sha}.`);
  rmSync(join(dir, ".git"), { recursive: true, force: true });
}
