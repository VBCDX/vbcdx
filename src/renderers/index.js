// Renderer dispatch and native destination resolution (spec section 7).

import { join } from "node:path";
import { renderClaude } from "./claude.js";
import { renderCodex } from "./codex.js";
import { renderOpencode } from "./opencode.js";
import { renderHermes } from "./hermes.js";
import { configError } from "../errors.js";

// Native per-harness/scope destination directory for the flat-file harnesses.
const PROJECT_SUBDIR = { claude: ".claude/agents", codex: ".codex/agents", opencode: ".opencode/agents" };
const USER_SUBDIR = { claude: "agents", codex: "agents", opencode: "agents" };

export function resolveHarnessDir(harness, scope, { harnessRoot, worktreeRoot }) {
  if (scope === "project") {
    if (!worktreeRoot) throw configError("Project scope requires a containing Git worktree.");
    return join(worktreeRoot, PROJECT_SUBDIR[harness]);
  }
  if (!harnessRoot) throw configError(`User scope requires the ${harness} configuration root.`);
  return join(harnessRoot, USER_SUBDIR[harness]);
}

/** Render one role for a flat-file harness (claude|codex|opencode). */
export function renderFlat(harness, role, ctx) {
  if (harness === "claude") return renderClaude(role, ctx);
  if (harness === "codex") return renderCodex(role, ctx);
  if (harness === "opencode") return renderOpencode(role, ctx);
  throw configError(`Unknown flat-file harness: ${harness}`);
}

/** Hermes profile directory for a role: <HERMES_HOME>/profiles/<id>. */
export function resolveHermesProfileDir(hermesHome, roleId) {
  if (!hermesHome) throw configError("Hermes requires the HERMES_HOME configuration root.");
  return join(hermesHome, "profiles", roleId);
}

export { renderClaude, renderCodex, renderOpencode, renderHermes };
