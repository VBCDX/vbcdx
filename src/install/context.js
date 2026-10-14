// Run context for the `vbcdx` front door.
//
// `--env` stays the way to pin every directory, exactly as for `init`. Without
// it, `vbcdx` uses the places the harness itself reads: the harness's own
// configuration variable when set (CLAUDE_CONFIG_DIR, CODEX_HOME,
// OPENCODE_CONFIG_DIR, HERMES_HOME), otherwise its documented default
// under the home directory, and keeps its own state (the install manifest and
// credential files) under ~/.vbcdx. Either way the result goes through the same
// loadConfig validation as `init`, so every path is absolute and checked.
//
// The documented default is used only when it is there: an install that would write
// to a user-scope default home that does not exist refuses rather than assume the
// harness is installed (requireHome). Project scope writes into the worktree, and
// list, doctor and remove act only on what the manifest recorded, so they need no check.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseEnvFile } from "../config/env-parser.js";
import { loadConfig } from "../config/config.js";
import { findWorktreeRoot } from "../planner.js";
import { configError } from "../errors.js";

const HARNESS_ROOT_KEY = {
  claude: "VBCDX_AGENTS_CLAUDE_CONFIG_DIR",
  codex: "VBCDX_AGENTS_CODEX_HOME",
  opencode: "VBCDX_AGENTS_OPENCODE_CONFIG_DIR",
  hermes: "VBCDX_AGENTS_HERMES_HOME",
};

// The harness's own variable and its documented default root.
//   claude:   CLAUDE_CONFIG_DIR, ~/.claude          (code.claude.com/docs/en/settings)
//   codex:    CODEX_HOME, ~/.codex                  (learn.chatgpt.com/docs/config-file/config-advanced)
//   opencode: OPENCODE_CONFIG_DIR, ~/.config/opencode (opencode.ai/docs/config)
//   hermes:   HERMES_HOME, ~/.hermes                (hermes-agent docs, user-guide/features/mcp)
// Claude keeps user-scope MCP servers in ~/.claude.json beside ~/.claude, so either one
// shows it is installed (`also`).
export const HARNESS_DEFAULT_ROOT = Object.freeze({
  claude: { env: "CLAUDE_CONFIG_DIR", rel: ".claude", also: ".claude.json" },
  codex: { env: "CODEX_HOME", rel: ".codex" },
  opencode: { env: "OPENCODE_CONFIG_DIR", rel: join(".config", "opencode") },
  hermes: { env: "HERMES_HOME", rel: ".hermes" },
});

/**
 * Resolve the directories for one run.
 * @param {object} o
 * @param {string} o.harness
 * @param {"user"|"project"} o.scope
 * @param {string|null} o.envPath absolute --env file, or null for defaults
 * @param {string} [o.cwd]
 * @param {string} [o.home]
 * @param {object} [o.env] the process environment (only the harness root variable is read)
 * @param {boolean} [o.requireHome] refuse a user-scope default home that does not exist (install)
 */
export function resolveContext({ harness, scope, envPath, cwd = process.cwd(), home = homedir(), env = process.env, requireHome = false }) {
  let entries;
  let rootExplicit;
  const rootKey = HARNESS_ROOT_KEY[harness];
  if (envPath) {
    entries = parseEnvFile(envPath);
    rootExplicit = entries.has(rootKey);
  } else {
    if (!home || !isAbsolute(home)) throw configError("Cannot find the home directory; pass --env=<absolute config file>.");
    const def = HARNESS_DEFAULT_ROOT[harness];
    const fromEnv = env[def.env];
    if (fromEnv !== undefined && fromEnv !== "" && !isAbsolute(fromEnv)) {
      throw configError(`${def.env} must be an absolute path when set.`);
    }
    rootExplicit = Boolean(fromEnv);
    const root = fromEnv || join(home, def.rel);
    if (requireHome && !fromEnv && scope !== "project" && !existsSync(root) && !(def.also && existsSync(join(home, def.also)))) {
      throw configError(`No ${harness} configuration found at ${root}: ${harness} may not be installed, or it keeps its configuration elsewhere. Set ${def.env} or pass --env=<absolute config file>; vbcdx does not guess where it is.`);
    }
    entries = new Map([
      ["VBCDX_AGENTS_BASE_DIR", join(home, ".vbcdx")],
      ["VBCDX_AGENTS_CREDENTIALS_DIR", join(home, ".vbcdx", "credentials")],
      [rootKey, root],
    ]);
  }
  const config = loadConfig(entries, { harness, scope });
  let worktreeRoot = null;
  if (scope === "project") {
    worktreeRoot = findWorktreeRoot(cwd);
    if (!worktreeRoot) throw configError("Project scope requires running inside a Git worktree; none was found.");
  }
  return {
    harness, scope, entries, config, worktreeRoot, home, cwd, rootExplicit,
    envPath: envPath || null,
    manifestPath: join(config.baseDir, "manifests", "installation.json"),
  };
}
