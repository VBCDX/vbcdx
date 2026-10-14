// Where, and in what shape, each harness reads an MCP server and a skill
//. Every format below is quoted from the vendor's documentation and,
// where the documentation is silent, from what the harness itself writes; the
// README's "Harness formats" table cites each source. Nothing here invents a key.
//
// MCP servers (stdio):
//   claude    project: <worktree>/.mcp.json, user: <config>/.claude.json
//             { "mcpServers": { <name>: { "type": "stdio", "command", "args", "env" } } }
//             env values "${VAR}" are expanded by Claude Code; "${VAR:-}" is empty when
//             unset (code.claude.com/docs/en/mcp, "Environment variable expansion").
//             Without CLAUDE_CONFIG_DIR the user file is ~/.claude.json; with it, Claude
//             Code 2.1 writes <CLAUDE_CONFIG_DIR>/.claude.json (`claude mcp add --scope user`).
//   codex     project: <worktree>/.codex/config.toml (trusted projects), user: <CODEX_HOME>/config.toml
//             [mcp_servers.<name>] command, args, env_vars (names forwarded from Codex's
//             environment) (learn.chatgpt.com/docs/extend/mcp?surface=cli)
//   opencode  project: <worktree>/opencode.json, user: <OPENCODE_CONFIG_DIR>/opencode.json
//             { "mcp": { <name>: { "type": "local", "command": [..], "enabled", "environment" } } }
//             "{env:VAR}" substitutes the variable, empty when unset
//             (opencode.ai/docs/mcp-servers, opencode.ai/docs/config)
//   hermes    <HERMES_HOME>/config.yaml  mcp_servers.<name>: command, args, env; "${VAR}" is
//             resolved from the environment and ~/.hermes/.env
//             (hermes-agent docs, user-guide/features/mcp)
//
// Skills (<dir>/<name>/SKILL.md):
//   claude    user <config>/skills, project <worktree>/.claude/skills (code.claude.com/docs/en/skills)
//   opencode  user <config>/skills, project <worktree>/.opencode/skills (opencode.ai/docs/skills)
//   codex     user $HOME/.agents/skills, project <worktree>/.agents/skills
//             (learn.chatgpt.com/docs/build-skills)
//   hermes    not supported by this installer.

import { join } from "node:path";
import { envForMode } from "./tool-declaration.js";

/** The config file, format and key path that hold a tool's MCP entry, or null (unknown harness). */
export function mcpTarget(ctx, serverName) {
  const { harness, scope, config, worktreeRoot, home, rootExplicit } = ctx;
  const root = config.harnessRoot;
  const project = scope === "project";
  switch (harness) {
    case "claude":
      return {
        file: project ? join(worktreeRoot, ".mcp.json") : rootExplicit ? join(root, ".claude.json") : join(home, ".claude.json"),
        format: "json",
        path: ["mcpServers", serverName],
        mode: project ? 0o644 : 0o600,
      };
    case "codex":
      return { file: project ? join(worktreeRoot, ".codex", "config.toml") : join(root, "config.toml"), format: "toml", path: ["mcp_servers", serverName], mode: 0o600 };
    case "opencode":
      return { file: project ? join(worktreeRoot, "opencode.json") : join(root, "opencode.json"), format: "json", path: ["mcp", serverName], mode: 0o644 };
    case "hermes":
      return { file: join(root, "config.yaml"), format: "yaml", path: ["mcp_servers", serverName], mode: 0o600 };
    default:
      return null;
  }
}

/**
 * The harness's MCP server entry for a declaration. `launch` is the absolute
 * command and arguments that start the server. Environment variables appear only
 * as references the harness resolves at start-up, never as values.
 */
export function renderMcpEntry(harness, declaration, launch) {
  const env = envForMode(declaration.env, "stdio");
  const command = launch.command;
  const args = [...launch.args];
  switch (harness) {
    case "claude": {
      const entry = { type: "stdio", command, args };
      // A required variable stays "${VAR}" so `claude mcp list` warns when it is unset.
      if (env.length) entry.env = Object.fromEntries(env.map((e) => [e.name, e.required ? `\${${e.name}}` : `\${${e.name}:-}`]));
      return entry;
    }
    case "codex": {
      const entry = { command, args };
      if (env.length) entry.env_vars = env.map((e) => e.name);
      return entry;
    }
    case "opencode": {
      const entry = { type: "local", command: [command, ...args], enabled: true };
      if (env.length) entry.environment = Object.fromEntries(env.map((e) => [e.name, `{env:${e.name}}`]));
      return entry;
    }
    case "hermes": {
      const entry = { command, args };
      if (env.length) entry.env = Object.fromEntries(env.map((e) => [e.name, `\${${e.name}}`]));
      return entry;
    }
    default:
      return null;
  }
}

/** Absolute SKILL.md destination for a skill, or null when the harness has no skill location. */
export function skillTarget(ctx, skillName) {
  const { harness, scope, config, worktreeRoot, home } = ctx;
  const project = scope === "project";
  let dir;
  if (harness === "claude") dir = project ? join(worktreeRoot, ".claude", "skills") : join(config.harnessRoot, "skills");
  else if (harness === "opencode") dir = project ? join(worktreeRoot, ".opencode", "skills") : join(config.harnessRoot, "skills");
  else if (harness === "codex") dir = project ? join(worktreeRoot, ".agents", "skills") : join(home, ".agents", "skills");
  else return null;
  return join(dir, skillName, "SKILL.md");
}
