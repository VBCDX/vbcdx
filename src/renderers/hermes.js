// Hermes Agent renderer.
//
// One Hermes profile per role, under <HERMES_HOME>/profiles/<id>/:
//   SOUL.md       the canonical prompt plus the shared bound-tools note
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
// for a role bound to an installed tool, the profile gets an entry with
// tools.include = exactly the bound tools. A stdio server starts the way it is
// declared (the service's `stdio` launch, or its installed tool's vbcdx.json); no
// contract has a launch built in. Unbound roles get none. The server's settings are
// not rendered: Hermes gives stdio servers a filtered environment, so they are
// passed as ${VAR} references that Hermes resolves from the profile's .env.
// An entry is only ever a stdio launch: no `url`, no `headers`, and so no bearer token
// read from the profile's .env. A tool that needs a key has no entry here; its key lives
// in Keyhole and reaches it through the sidecar.
//
// Web search: a role whose descriptor declares web_search gets the web-litellm-search
// plugin under plugins/, plugins.enabled naming it, web.search_backend/extract_backend
// selecting it and the web toolset, all only when the installer config names a LiteLLM
// gateway and search tool (VBCDX_AGENTS_HERMES_WEB_SEARCH_URL/_TOOL). There is no default
// gateway: without one the role is rendered exactly as before.

import { readFileSync } from "node:fs";
import { stringifyPy } from "../fs/pyyaml.js";
import { hermesDisabledToolsets, boundServiceTools, boundToolsNote, hermesPlatformToolsets } from "./native.js";
import { configError } from "../errors.js";

export const HERMES_PROVIDER_NAME = "vbcdx";
export const HERMES_KEY_ENV = "HERMES_PROVIDER_API_KEY";

export function renderHermesMcpServers(bindings) {
  const servers = {};
  for (const b of bindings) {
    const tools = { include: [...b.tools], prompts: false, resources: false };
    // A stdio service starts the way it is declared: its integrations-file `stdio`
    // launch, or the vbcdx.json of the tool installed with `vbcdx install tool`. The same
    // for every contract: none has a launch built in.
    if (!b.stdio) {
      throw configError(`Service ${b.server} is a stdio service bound to a role, but nothing says how to start it: install its tool with \`vbcdx install tool\`, or give the service a "stdio" launch in the integrations file.`);
    }
    servers[b.server] = { command: b.stdio.command, args: [...b.stdio.args], env: { ...b.stdio.env }, tools };
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
  if (webSearch) {
    doc.plugins = { enabled: [HERMES_WEB_SEARCH_PLUGIN] };
    doc.web = { search_backend: HERMES_WEB_SEARCH_BACKEND, extract_backend: HERMES_WEB_SEARCH_BACKEND };
  }
  // Written the way Hermes (PyYAML) reads it.
  return stringifyPy(doc);
}

export const HERMES_WEB_SEARCH_PLUGIN = "web-litellm-search";
export const HERMES_WEB_SEARCH_BACKEND = "litellm-search";
const HERMES_WEB_SEARCH_SOURCE = new URL(`../../assets/hermes/plugins/${HERMES_WEB_SEARCH_PLUGIN}/`, import.meta.url);

/** The web search config a role is rendered with: the installer's, if the role declares web_search. */
export function hermesWebSearch(role, webSearch) {
  return role.descriptor.web_search === true && webSearch ? webSearch : null;
}

// The gateway URL and tool name are baked into the plugin: a function
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
  const search = hermesWebSearch(role, webSearch);
  const soul = role.prompt.trimEnd() + "\n" + boundToolsNote(bindings);
  return {
    files: [
      { name: "SOUL.md", content: soul, mode: 0o644 },
      { name: "profile.yaml", content: stringifyPy({ description: role.descriptor.description, description_auto: false }), mode: 0o644 },
      // Merged into the file on disk, not owned whole: see src/fs/hermes-config.js.
      { name: "config.yaml", content: renderHermesConfig(role, hermes, bindings, search), mode: 0o644, merge: "hermes-config" },
      ...(search ? renderHermesWebSearchPlugin(search) : []),
    ],
  };
}
