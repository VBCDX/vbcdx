// Translation from the abstract capability model in each role.json to real
// native harness controls and registered tool identifiers (spec sections 2,
// 6.1, 7). This is the single place capabilities become native controls, so a
// role's local file/shell/web/delegation flags and its reviewed remote tool
// allowlist map deterministically and identically for every harness — there is
// no per-harness hand-maintained tool list to drift.

// ── Claude ──────────────────────────────────────────────────────────────────
// Built-in Claude tool names (verified against code.claude.com/docs sub-agents).
export function claudeLocalTools(cap) {
  const tools = ["Read", "Grep", "Glob", "TodoWrite"];
  if (cap.filesystem === "read-write") tools.push("Write", "Edit");
  if (cap.shell) tools.push("Bash");
  if (cap.web) tools.push("WebFetch", "WebSearch");
  if (cap.delegation) tools.push("Agent");
  return tools;
}

// ── OpenCode ──────────────────────────────────────────────────────────────
// permission map: allow|ask|deny per built-in capability key (verified against
// opencode.ai/docs). Reads/search/todo are always allowed; edit/bash/web/task
// follow the capability flags.
export function opencodePermission(cap) {
  const allowDeny = (on) => (on ? "allow" : "deny");
  return {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    todowrite: "allow",
    edit: allowDeny(cap.filesystem === "read-write"),
    bash: allowDeny(cap.shell),
    webfetch: allowDeny(cap.web),
    websearch: allowDeny(cap.web),
    task: allowDeny(cap.delegation),
  };
}

// ── Codex ─────────────────────────────────────────────────────────────────
// Codex has no per-agent tool allowlist field; its enforceable native control
// is sandbox_mode. Delegation uses Codex's native agent type and needs no
// invented field.
export function codexSandboxMode(cap) {
  return cap.filesystem === "read-write" ? "workspace-write" : "read-only";
}

// ── Hermes ─────────────────────────────────────────────────────────────────
// Hermes toolsets (hermes-agent reference/toolsets-reference.md). `file` bundles
// read_file/write_file/patch/search_files — there is no read-only file toolset,
// so filesystem: read-only stays advisory (as for Codex). Shell, web and
// delegation map to their own toolsets.
export function hermesToolsets(cap) {
  const toolsets = ["file", "todo", "clarify"];
  if (cap.shell) toolsets.push("terminal");
  if (cap.web) toolsets.push("web");
  if (cap.delegation) toolsets.push("delegation");
  return toolsets;
}

// The Hermes release these lists are pinned to. Rendered profiles are for this
// release only: the deny rules differ between releases (see HERMES_TOOLSET_OVERLAPS).
export const HERMES_TARGET = Object.freeze({ version: "0.21.5", tag: "v2026.9.24" });

// Every configurable toolset of Hermes v0.21.5 (hermes_cli/tools_config.py
// CONFIGURABLE_TOOLSETS at tag v2026.9.24, including the Discord-gateway-only
// discord / discord_admin). test/fixtures/hermes-v0.21.5-toolsets.json is that
// upstream list and the tests fail if this one drifts from it; regenerate the
// fixture when upgrading Hermes. Since v0.15.1: stt, kanban and connections
// (manage_connections) are new; moa and messaging are gone.
export const HERMES_KNOWN_TOOLSETS = Object.freeze([
  "web", "browser", "terminal", "file", "code_execution", "vision", "video", "image_gen",
  "video_gen", "x_search", "tts", "stt", "skills", "todo", "kanban", "memory", "context_engine",
  "session_search", "connections", "clarify", "delegation", "cronjob", "homeassistant",
  "spotify", "discord", "discord_admin", "yuanbao", "computer_use",
]);

// Every platform_toolsets key a Hermes v0.21.5 gateway can resolve: tools_config.PLATFORMS,
// the gateway.config.Platform enum (sms, msgraph_webhook; LOCAL maps to "cli") and the
// bundled plugin platforms of hermes_cli/platforms.py get_all_platforms(). Each gets the
// role's allow-list, so no gateway falls back to its default composite (which includes
// browser, code_execution, terminal, connections and, on some platforms, kanban). A
// third-party plugin platform is not covered: it gets its default composite minus
// agent.disabled_toolsets, which denies every known toolset the role is not allowed, so
// only tools outside HERMES_KNOWN_TOOLSETS (such as that plugin's own) can remain.
// v0.21.5 adds a2a, buzz, photon, raft, relay and whatsapp_cloud (35 in all); unpinned,
// they fell back to composites with the a2a_* tools, manage_connections and the
// browser vault tools.
export const HERMES_PLATFORMS = Object.freeze([
  "a2a", "api_server", "bluebubbles", "buzz", "cli", "cron", "dingtalk", "discord", "email",
  "feishu", "google_chat", "homeassistant", "irc", "line", "matrix", "mattermost",
  "msgraph_webhook", "ntfy", "photon", "qqbot", "raft", "relay", "signal", "simplex", "slack",
  "sms", "teams", "telegram", "webhook", "wecom", "wecom_callback", "weixin", "whatsapp",
  "whatsapp_cloud", "yuanbao",
]);

// Non-configurable toolsets that _get_platform_tools adds back after reading an explicit
// platform list (tools_config.py "recover non-configurable platform toolsets"). No role is
// allowed them, so every role denies them (Feishu doc/drive, incl. comment writes).
// In v0.15.1 kanban was recovered too and left undenied (runtime-gated to dispatcher
// workers); in v0.21.5 it is an ordinary configurable toolset, so no role is allowed it
// and it is denied like any other.
export const HERMES_RECOVERED_TOOLSETS = Object.freeze(["feishu_doc", "feishu_drive"]);
export const HERMES_RUNTIME_GATED_TOOLSETS = Object.freeze([]);

// Toolset names v0.21.5 no longer has: v0.15.1's messaging (send_message) and moa.
// Denying them keeps a render that reaches the old image from granting send_message on
// an unpinned gateway. v0.21.5 skips an unknown disabled name (model_tools.py
// _apply_toolset_selection: a warning only when not quiet_mode; agent runs are quiet).
export const HERMES_RETIRED_TOOLSETS = Object.freeze(["messaging", "moa"]);

// Toolsets that bundled plugins register, outside CONFIGURABLE_TOOLSETS: every
// register_tool(toolset=...) under plugins/ at v2026.9.24 is a2a, google_meet or spotify,
// and spotify is already a known toolset. A plugin toolset is enabled on every platform,
// pinned ones included, unless upstream keeps it default-off: a2a is off only through
// _DEFAULT_OFF_TOOLSETS, and google_meet (a standalone plugin, opt-in via plugins.enabled)
// is not default-off at all. A third-party tool plugin's toolset cannot be listed here;
// the README says so.
export const HERMES_PLUGIN_TOOLSETS = Object.freeze(["a2a", "google_meet"]);

// agent.disabled_toolsets subtracts a disabled toolset's *tools* by name after
// the enabled ones are added (model_tools.py). A disabled toolset that shares a
// tool with an allowed one would strip that tool, so such a toolset is left off the
// deny-list (the per-platform allow-lists keep it disabled) and its legacy name, if
// any, is denied instead. In v0.15.1 browser bundled web_search, so web roles
// denied browser_tools rather than browser. In v0.21.5 no configurable toolset shares
// a tool with an allowable one (the tests derive this from the fixture): browser is
// denied outright, which also covers browser_exec and the browser_vault_* tools that
// the legacy browser_tools name no longer includes.
export const HERMES_TOOLSET_OVERLAPS = Object.freeze({});
export const HERMES_OVERLAP_LEGACY_DENY = Object.freeze({});

export function hermesDisabledToolsets(cap) {
  const allowed = new Set(hermesToolsets(cap));
  const out = [];
  for (const t of HERMES_KNOWN_TOOLSETS) {
    if (allowed.has(t)) continue;
    if ((HERMES_TOOLSET_OVERLAPS[t] || []).some((o) => allowed.has(o))) {
      if (HERMES_OVERLAP_LEGACY_DENY[t]) out.push(HERMES_OVERLAP_LEGACY_DENY[t]);
      continue;
    }
    out.push(t);
  }
  return [...out, ...HERMES_RECOVERED_TOOLSETS, ...HERMES_PLUGIN_TOOLSETS, ...HERMES_RETIRED_TOOLSETS];
}

export function hermesPlatformToolsets(cap) {
  // a fresh array per platform: shared references would render as YAML aliases
  return Object.fromEntries(HERMES_PLATFORMS.map((p) => [p, hermesToolsets(cap)]));
}

// ── Remote service bindings ─────────────────────────────────────────────────
// Native MCP tool identifier per harness. Claude uses the
// mcp__<server>__<tool> form; OpenCode uses <server>_<tool>.
export function mcpToolId(harness, server, tool) {
  if (harness === "opencode") return `${server}_${tool}`;
  return `mcp__${server}__${tool}`;
}

/**
 * Compute the bound service tools for a role given the validated integrations.
 * A tool is bound only if it is in BOTH the role's reviewed remote allowlist
 * AND the service manifest, AND the role has an explicit credential mapping for
 * that service. Never widens to a wildcard to recover a missing tool.
 *
 * For a transport "http" service the explicit mapping is the service's roles
 * list and there is no credential file (identity travels per request).
 *
 * @returns {Array<{server:string, transport:string, credentialFile:string|null, url:string|null, tools:string[]}>}
 */
export function boundServiceTools(descriptor, integrations) {
  const out = [];
  if (!integrations || !integrations.services) return out;
  const remote = descriptor.remote_capabilities || {};
  for (const [server, svc] of Object.entries(integrations.services)) {
    // A role allows tools by contract. A descriptor keyed by server name,
    // as packs were before contracts, still binds that server.
    // Own keys only: a service may be called "constructor", which every object inherits.
    const own = (k) => (k && Object.hasOwn(remote, k) ? remote[k] : undefined);
    const allowlist = own(svc.contract) || own(server);
    if (!allowlist || allowlist.length === 0) continue;
    const transport = svc.transport || "stdio";
    let credentialFile = null;
    // An installed tool that takes no per-call credential file binds like http: by roles list.
    if (transport === "http" || svc.credentialFree) {
      if (!(svc.roles || []).includes(descriptor.id)) continue; // not listed -> no binding
    } else {
      credentialFile = svc.credentials ? svc.credentials[descriptor.id] : undefined;
      if (!credentialFile) continue; // no explicit mapping -> no binding for this role
    }
    const manifestSet = new Set(svc.tools);
    const tools = allowlist.filter((t) => manifestSet.has(t));
    if (tools.length === 0) continue;
    // git only for roles listed in git_roles, with that role's mode
    const gitMode = svc.gitUrl && svc.gitRoles && Object.hasOwn(svc.gitRoles, descriptor.id) ? svc.gitRoles[descriptor.id] : null;
    out.push({ server, contract: svc.contract || null, transport, credentialFile, url: svc.url || null, toolPrefix: svc.toolPrefix || "", stdio: svc.stdio || null,
      gitUrl: gitMode ? svc.gitUrl : null, gitMode, tools: [...tools].sort() });
  }
  return out;
}

/**
 * A plain-text note, appended to a rendered definition, telling the model which
 * absolute credential_file to pass for each bound service and which tools its
 * role may call. Contains the path only, never a credential value, and never
 * instructions to parse the file.
 */
export function credentialBindingNote(bindings) {
  if (!bindings.length) return "";
  const lines = ["", "## Bound service credentials", ""];
  for (const b of bindings) {
    const how = b.credentialFile
      ? `pass \`credential_file="${b.credentialFile}"\` on every ${b.server} tool call.`
      : `your identity is supplied by the connection; call ${b.server} tools without a credential_file argument.`;
    lines.push(`- \`${b.server}\`: ${how} Tools available to your role: ${b.tools.join(", ")}.`);
  }
  return lines.join("\n") + "\n";
}
