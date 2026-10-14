// Hermes Agent renderer.
//
// One Hermes profile per role, under <HERMES_HOME>/profiles/<id>/:
//   SOUL.md       the canonical prompt plus the shared credential-binding note
//   profile.yaml  the role description (what Hermes' kanban orchestrator routes on; the roles
//                 themselves are denied the kanban toolset, so a dispatched worker has no
//                 kanban handoff tools)
//   config.yaml   the role's toolsets and, when configured, nonsecret model routing.
//                 Toolsets are enforced two ways (the renders target Hermes v0.21.5 only, see
//                 HERMES_TARGET in native.js): an explicit allow-list in
//                 platform_toolsets.<platform> for every pinned platform, and
//                 agent.disabled_toolsets = every other known toolset (plus the bundled
//                 plugin toolsets and the retired names), which Hermes removes on every
//                 platform. Profiles do not support Hermes kanban. A top-level
//                 `toolsets:` key does not restrict what `hermes tools list` enables.
//
// It emits no secret: when model routing is configured the provider's key is
// referenced by name (key_env) and read by Hermes from the profile's own
// operator-owned .env, which this installer never writes.
//
// MCP servers — the one deliberate exception to "the installer never writes
// harness MCP configuration". Hermes loads MCP servers only from the profile's
// config.yaml and enforces a per-server tool allow-list there (tools.include), so
// for a role the integrations file BINDS, the profile gets an entry for the
// companion's fixed stdio binary with tools.include = exactly the bound tools.
// Unbound roles get none. The companion's own settings are not rendered: Hermes
// gives stdio servers a filtered environment, so they are passed as ${VAR}
// references that Hermes resolves from the profile's .env at load time.
//
// Web search: a role whose descriptor declares web_search gets the web-litellm-search
// plugin under plugins/, plugins.enabled naming it, web.search_backend/extract_backend
// selecting it and the web toolset, all only when the installer config names a LiteLLM
// gateway and search tool (VBCDX_AGENTS_HERMES_WEB_SEARCH_URL/_TOOL). There is no default
// gateway: without one the role is rendered exactly as before.

import { readFileSync } from "node:fs";
import { stringifyPy } from "../fs/pyyaml.js";
import { hermesDisabledToolsets, boundServiceTools, credentialBindingNote, hermesPlatformToolsets } from "./native.js";
import { FORGEJO_CONTRACT, COOLIFY_CONTRACT } from "../config/integrations.js";

export const HERMES_PROVIDER_NAME = "vbcdx";
export const HERMES_KEY_ENV = "HERMES_PROVIDER_API_KEY";

// Companion stdio binaries of the bundled contracts and the settings each reads (their
// READMEs): the fallback launch for an integrations-file stdio service when no tool of that
// name and contract was installed with `vbcdx install tool`. An installed tool starts the
// way its own vbcdx.json declares, with only its stdio-mode settings.
export const HERMES_COMPANION = Object.freeze({
  [FORGEJO_CONTRACT]: { command: "vbcdx-forgejo", env: ["VBCDX_FORGEJO_URL", "VBCDX_FORGEJO_WRITES"] },
  [COOLIFY_CONTRACT]: { command: "vbcdx-coolify", env: ["VBCDX_COOLIFY_URL", "VBCDX_COOLIFY_WRITES"] },
});

// For a transport "http" service the profile connects to the service url and
// presents its own identity in a header, resolved by Hermes from the profile's
// .env: VBCDX_FORGEJO_TOKEN / VBCDX_COOLIFY_TOKEN (a token for that role's own
// account). Nothing secret is rendered.
// The key is derived from the server name, VBCDX_<SERVER>_TOKEN, so any http tool gets one.
// loadIntegrations refuses the names whose key is already taken (RESERVED_SERVICE_NAMES).
export const hermesHttpTokenEnv = (server) => `VBCDX_${String(server).toUpperCase().replace(/-/g, "_")}_TOKEN`;
// A "read" git role is read-only for its whole profile, not only for git: every credential
// the profile names is this token, which must be scoped `read:repository` only. Both the terminal
// passthrough and the forgejo MCP binding's bearer header resolve to it, so no write-capable
// credential is rendered into a read profile and its .env never needs one. A role that must write
// through forgejo (posting reviews or comments needs write:repository) cannot be a "read" role: map
// it "fork", whose profile keeps the role's own MCP token.
export const HERMES_GIT_READ_TOKEN_ENV = "VBCDX_FORGEJO_GIT_TOKEN";
// Read mode's first gate: the read profile DECLARES its token's scope in this key, the installer
// forwards it through terminal.env_passthrough, and hermes-git refuses to clone without it. The second
// gate asks Forgejo whether the token may push to the repository. The key names no credential, so it
// does not weaken the "one credential key" rule above.
export const HERMES_GIT_SCOPE_ENV = "VBCDX_FORGEJO_GIT_TOKEN_SCOPE";
export const HERMES_GIT_READ_SCOPE = "read:repository";

/**
 * The env key a bound http service's bearer token (and a git role's terminal passthrough) comes from.
 * The git mode decides it for forgejo: a "read" role gets the read-scoped key, every other binding
 * its service's own key. One function, so the header and the passthrough can never disagree.
 */
export function hermesServiceTokenEnv(binding) {
  if (binding.contract === FORGEJO_CONTRACT && binding.gitMode === "read") return HERMES_GIT_READ_TOKEN_ENV;
  return hermesHttpTokenEnv(binding.server);
}

export function renderHermesMcpServers(bindings) {
  const servers = {};
  for (const b of bindings) {
    // Names exactly as the server lists them (a gateway may prefix them).
    const tools = { include: b.tools.map((t) => (b.toolPrefix || "") + t), prompts: false, resources: false };
    if (b.transport === "http") {
      const tokenEnv = hermesServiceTokenEnv(b);
      if (!tokenEnv) continue;
      servers[b.server] = { url: b.url, headers: { Authorization: "Bearer ${" + tokenEnv + "}" }, tools };
      continue;
    }
    // A tool installed with `vbcdx install tool` carries its declared launch.
    if (b.stdio) {
      servers[b.server] = { command: b.stdio.command, args: [...b.stdio.args], env: { ...b.stdio.env }, tools };
      continue;
    }
    const companion = HERMES_COMPANION[b.contract];
    if (!companion) continue; // only services with a known companion binary
    servers[b.server] = {
      command: companion.command,
      args: ["mcp"],
      env: Object.fromEntries(companion.env.map((k) => [k, "${" + k + "}"])),
      tools,
    };
  }
  return servers;
}

export function renderHermesConfig(role, routing, bindings = [], webSearch = null) {
  // A web-search role gets the web toolset even when its descriptor leaves local web off
  // (pm-agent): the plugin is the web backend it is given, and nothing else is.
  const cap = webSearch ? { ...role.descriptor.local_capabilities, web: true } : role.descriptor.local_capabilities;
  const doc = {
    platform_toolsets: hermesPlatformToolsets(cap),
    agent: { disabled_toolsets: hermesDisabledToolsets(cap) },
  };
  const model = routing ? routing.roleModels[role.id] || routing.model : null;
  if (routing && model) {
    doc.model = { provider: `custom:${HERMES_PROVIDER_NAME}`, base_url: routing.baseUrl, default: model };
    doc.custom_providers = [
      { name: HERMES_PROVIDER_NAME, base_url: routing.baseUrl, key_env: HERMES_KEY_ENV, model },
    ];
  }
  const mcp = renderHermesMcpServers(bindings);
  if (Object.keys(mcp).length) doc.mcp_servers = mcp;
  // Hermes git: terminal children strip secrets unless the profile lists them; this
  // forwards the mode's Forgejo token (from the profile's .env) to hermes-git. For a "read" role
  // that is the same read-scoped key its forgejo MCP binding uses, so the profile names no
  // write-capable credential anywhere; the read role's declared scope key is forwarded with it
  //, so hermes-git can require the declaration before it clones.
  const git = hermesGit(bindings);
  if (git) doc.terminal = { env_passthrough: git.scopeEnv ? [git.tokenEnv, git.scopeEnv] : [git.tokenEnv] };
  if (webSearch) {
    doc.plugins = { enabled: [HERMES_WEB_SEARCH_PLUGIN] };
    doc.web = { search_backend: HERMES_WEB_SEARCH_BACKEND, extract_backend: HERMES_WEB_SEARCH_BACKEND };
  }
  // Written the way Hermes (PyYAML) reads it.
  return stringifyPy(doc);
}

// Hermes git: a Forgejo binding over http with a git_url lets the role clone org repos
// and open pull requests from its own fork (hermes-git); it never pushes to org repos.
// Only roles listed in the service's git_roles get it, as "fork" or "read".
export function hermesGit(bindings) {
  const b = bindings.find((x) => x.contract === FORGEJO_CONTRACT && x.transport === "http" && x.gitUrl && x.gitMode);
  if (!b) return null;
  // A "read" role also gets the scope-declaration key, so its .env can state the token's
  // scope and hermes-git requires that statement. A "fork" role has no read token to declare.
  return { url: b.gitUrl, mode: b.gitMode, tokenEnv: hermesServiceTokenEnv(b),
           scopeEnv: b.gitMode === "read" ? HERMES_GIT_SCOPE_ENV : null };
}

export function hermesGitUrl(bindings) {
  const g = hermesGit(bindings);
  return g ? g.url : null;
}

const HERMES_GIT_SOURCE = new URL("../../assets/hermes/hermes-git.py", import.meta.url);

// The mode must be stated by the caller: the fatal direction of a wrong default is the
// write-capable "fork" helper, and the only in-tree caller always knows the binding's mode.
// forkTokenEnv is the Forgejo binding's own key (hermesGit(...).tokenEnv); the default is the
// key a service named "forgejo" gets.
export function renderHermesGit(gitUrl, mode, forkTokenEnv = hermesHttpTokenEnv("forgejo")) {
  if (mode !== "fork" && mode !== "read") throw new Error(`hermes-git mode must be "fork" or "read", not ${JSON.stringify(mode)}`);
  const tokenEnv = mode === "read" ? HERMES_GIT_READ_TOKEN_ENV : forkTokenEnv;
  // A function replacement (no $& / $' expansion) and JSON escaping inside the Python string
  // literal: the URL can never end the literal or inject code.
  return readFileSync(HERMES_GIT_SOURCE, "utf8")
    .replace("@@FORGEJO_URL@@", () => JSON.stringify(gitUrl).slice(1, -1))
    .replace("@@GIT_MODE@@", () => mode)
    // replaceAll: the key is named in the docstring, the help text and the refusals too.
    .replaceAll("@@SCOPE_ENV@@", () => HERMES_GIT_SCOPE_ENV)
    // The read scope's value is baked in from this module: the constant is the
    // single source, so it cannot drift from a second literal inside the asset.
    .replaceAll("@@READ_SCOPE@@", () => HERMES_GIT_READ_SCOPE)
    // The token env key is baked in too: a read render must not name the write-capable key
    // anywhere in the file, not even in a branch it would never take. replaceAll: the key is named
    // in the docstring, the help text and the refusal messages as well as at its definition.
    .replaceAll("@@TOKEN_ENV@@", () => tokenEnv);
}

export function hermesGitNote(gitUrl, mode) {
  if (mode !== "fork" && mode !== "read") throw new Error(`hermes-git mode must be "fork" or "read", not ${JSON.stringify(mode)}`);
  if (mode === "read") {
    return [
      "",
      "## Git: read-only clones",
      "",
      `You can clone repositories on ${gitUrl} read-only, to read code and run a repository's own tests.`,
      "You cannot push and cannot open pull requests from these clones: git uses only a read-only token,",
      "`VBCDX_FORGEJO_GIT_TOKEN`. Before anything is cloned, `hermes-git` requires your profile to",
      "declare that token's scope — `VBCDX_FORGEJO_GIT_TOKEN_SCOPE=read:repository`, in your `.env` —",
      "and refuses to start if the declaration is missing or wrong, if the token can read your account,",
      "if the server answers `/user` with something that is not this API's user object, or if Forgejo",
      "would accept the token for a push to the repository.",
      "It is the only credential your profile names: your forgejo MCP",
      "binding uses the same token, so forgejo tools that write (posting reviews or comments) are",
      "refused by the server. A role that must post them needs the write-capable `fork` mode, not `read`.",
      "Organisation repositories take pull requests, not pushes: protect the org default branches in",
      "Forgejo (branch protection) and never push to an organisation's repository with any credential.",
      "",
      '- Clone: `python3 "$HERMES_HOME/bin/hermes-git" clone --read-only OWNER/REPO [DIR]` (no fork is made).',
      "- Your read token reaches git through a credential helper. Never put a token in a URL, a command line or a file.",
      "",
    ].join("\n");
  }
  return [
    "",
    "## Git: clone, and pull requests from your fork",
    "",
    `You can clone repositories on ${gitUrl} and propose changes as pull requests from your own fork.`,
    "You never push to an organisation's repository: org branches change only through merged pull requests.",
    "A local pre-push hook stops accidental pushes to them. It is a guard rail you must not work around (no `--no-verify`, no `core.hooksPath`, no plain `git clone` with your token).",
    "",
    '- Clone: `python3 "$HERMES_HOME/bin/hermes-git" clone OWNER/REPO` (forks it to your account the first time).',
    "  `origin` is the org repository (fetch only); `fork` is yours.",
    "- Work on a branch: `git switch -c <branch>`, commit, then `git push fork <branch>`.",
    '- Open the pull request: `python3 "$HERMES_HOME/bin/hermes-git" pr --title "..." --body "..."` (from the clone).',
    "- Your Forgejo token reaches git through a credential helper. Never put a token in a URL, a command line or a file.",
    "",
  ].join("\n");
}

export const HERMES_WEB_SEARCH_PLUGIN = "web-litellm-search";
export const HERMES_WEB_SEARCH_BACKEND = "litellm-search";
const HERMES_WEB_SEARCH_SOURCE = new URL(`../../assets/hermes/plugins/${HERMES_WEB_SEARCH_PLUGIN}/`, import.meta.url);

/** The web search config a role is rendered with: the installer's, if the role declares web_search. */
export function hermesWebSearch(role, webSearch) {
  return role.descriptor.web_search === true && webSearch ? webSearch : null;
}

// The gateway URL and tool name are baked into the plugin, as hermes-git's URL is: a function
// replacement and JSON escaping inside the Python string literal, so a value can never end the
// literal. Both are required: the plugin has no default host to fall back on.
export function renderHermesWebSearchPlugin({ baseUrl, tool } = {}) {
  if (!baseUrl || !tool) throw new Error("web search needs a gateway URL and a search tool name");
  const init = readFileSync(new URL("__init__.py", HERMES_WEB_SEARCH_SOURCE), "utf8")
    .replace("@@LITELLM_SEARCH_BASE@@", () => JSON.stringify(baseUrl).slice(1, -1))
    .replace("@@LITELLM_SEARCH_TOOL@@", () => JSON.stringify(tool).slice(1, -1));
  const dir = `plugins/${HERMES_WEB_SEARCH_PLUGIN}`;
  return [
    { name: `${dir}/plugin.yaml`, content: readFileSync(new URL("plugin.yaml", HERMES_WEB_SEARCH_SOURCE), "utf8"), mode: 0o644 },
    { name: `${dir}/__init__.py`, content: init, mode: 0o644 },
  ];
}

export function renderHermes(role, { integrations, hermes, webSearch } = {}) {
  const bindings = boundServiceTools(role.descriptor, integrations);
  const git = hermesGit(bindings);
  const search = hermesWebSearch(role, webSearch);
  const soul = role.prompt.trimEnd() + "\n" + credentialBindingNote(bindings) + (git ? hermesGitNote(git.url, git.mode) : "");
  return {
    files: [
      { name: "SOUL.md", content: soul.endsWith("\n") ? soul : soul + "\n", mode: 0o644 },
      { name: "profile.yaml", content: stringifyPy({ description: role.descriptor.description, description_auto: false }), mode: 0o644 },
      // Merged into the file on disk, not owned whole: see src/fs/hermes-config.js.
      { name: "config.yaml", content: renderHermesConfig(role, hermes, bindings, search), mode: 0o644, merge: "hermes-config" },
      ...(git ? [{ name: "bin/hermes-git", content: renderHermesGit(git.url, git.mode, git.tokenEnv), mode: 0o755 }] : []),
      ...(search ? renderHermesWebSearchPlugin(search) : []),
    ],
  };
}
