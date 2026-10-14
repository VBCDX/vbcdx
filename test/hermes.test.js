import { test, after } from "node:test";
import assert from "node:assert/strict";
import { parse as yamlParse } from "yaml";
import { getRole } from "../src/roles/index.js";
import { renderHermes, HERMES_KEY_ENV, HERMES_PROVIDER_NAME } from "../src/renderers/hermes.js";
import { HERMES_TARGET, hermesToolsets, hermesDisabledToolsets, HERMES_KNOWN_TOOLSETS, HERMES_PLATFORMS, HERMES_TOOLSET_OVERLAPS, HERMES_OVERLAP_LEGACY_DENY, HERMES_RECOVERED_TOOLSETS, HERMES_RUNTIME_GATED_TOOLSETS, HERMES_PLUGIN_TOOLSETS, HERMES_RETIRED_TOOLSETS } from "../src/renderers/native.js";
import { loadConfig, loadHermesRouting } from "../src/config/config.js";
import { parseInitArgs } from "../src/cli/args.js";
import { buildPlan } from "../src/planner.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { loadIntegrations } from "../src/config/integrations.js";
import { renderClaude } from "../src/renderers/claude.js";
import { renderOpencode } from "../src/renderers/opencode.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const cfg = (obj) => new Map(Object.entries(obj));
const files = (out) => Object.fromEntries(out.files.map((f) => [f.name, f.content]));
const routing = { baseUrl: "https://llm.example/v1", model: "qwen3-14b", roleModels: { "code-agent": "qwen3-coder" } };

test("Hermes renders SOUL.md, profile.yaml and config.yaml for every role", () => {
  for (const id of FIXTURE_IDS) {
    const role = getRole(id);
    const f = files(renderHermes(role));
    assert.deepEqual(Object.keys(f).sort(), ["SOUL.md", "config.yaml", "profile.yaml"]);
    assert.ok(f["SOUL.md"].startsWith(role.prompt.trimEnd().slice(0, 40)));
    const profile = yamlParse(f["profile.yaml"]);
    assert.equal(profile.description, role.descriptor.description);
    assert.equal(profile.description_auto, false);
    const conf = yamlParse(f["config.yaml"]);
    assert.deepEqual(conf.platform_toolsets.cli, hermesToolsets(role.descriptor.local_capabilities));
    assert.equal(conf.toolsets, undefined, "top-level toolsets does not restrict Hermes; must not be emitted");
    assert.equal(conf.mcp_servers, undefined, "no integrations -> no MCP servers");
  }
});

test("Hermes toolsets follow shell/web/delegation; read-only stays advisory", () => {
  const ts = (id) => hermesToolsets(getRole(id).descriptor.local_capabilities);
  assert.deepEqual(ts("pm-agent"), ["file", "todo", "clarify", "terminal", "delegation"]);
  assert.deepEqual(ts("code-agent"), ["file", "todo", "clarify", "terminal"]);
  assert.deepEqual(ts("adversarial-auditor"), ["file", "todo", "clarify", "terminal", "web"]);
  assert.ok(ts("all-in-one-dev-agent").includes("delegation") && ts("all-in-one-dev-agent").includes("web"));
});

// Upstream Hermes v0.21.5, generated from the installed package (sources in the file's _source):
// configurable toolsets and their tools, every gateway platform key, what an unpinned platform
// falls back to, the toolsets the resolver adds back after an explicit list, the legacy names.
const UPSTREAM = JSON.parse(readFileSync(new URL("./fixtures/hermes-v0.21.5-toolsets.json", import.meta.url), "utf8"));
const toolsOf = (toolsets) => new Set(toolsets.flatMap((t) => UPSTREAM.toolset_tools[t] || UPSTREAM.legacy_toolsets[t] || []));
const RUNTIME_GATED = toolsOf(HERMES_RUNTIME_GATED_TOOLSETS);

// Hermes v0.21.5 semantics for one rendered config on one platform:
//   _get_platform_tools: the platform's explicit list plus the recovered toolsets, or, when
//   the platform has no entry, its default composite (platform_default_tools);
//   model_tools.py: minus every disabled toolset's (or legacy name's) tools.
// No toolset is runtime-gated on v0.21.5 (HERMES_RUNTIME_GATED_TOOLSETS is empty): kanban
// is denied like any other, which also strips the kanban tools Hermes appends for
// dispatcher-spawned workers.
function effectiveTools(conf, platform) {
  const list = conf.platform_toolsets[platform];
  const enabled = Array.isArray(list)
    ? toolsOf([...list, ...(UPSTREAM.recovered_toolsets[platform] || [])])
    : new Set(UPSTREAM.platform_default_tools[platform]);
  const denied = toolsOf(conf.agent.disabled_toolsets);
  return [...enabled].filter((t) => !denied.has(t) && !RUNTIME_GATED.has(t)).sort();
}

test("the pinned toolset, platform and recovery lists cover upstream Hermes v0.21.5", () => {
  assert.equal(HERMES_TARGET.version, "0.21.5");
  assert.match(UPSTREAM._source, /hermes-agent v0\.21\.5 \(tag v2026\.9\.24/);
  assert.deepEqual([...HERMES_KNOWN_TOOLSETS].sort(), [...UPSTREAM.configurable_toolsets].sort());
  assert.deepEqual([...HERMES_PLATFORMS].sort(), [...UPSTREAM.platforms].sort());
  const recovered = new Set(Object.values(UPSTREAM.recovered_toolsets).flat());
  assert.deepEqual([...HERMES_RECOVERED_TOOLSETS, ...HERMES_RUNTIME_GATED_TOOLSETS].sort(), [...recovered].sort());
  // the overlap map is exactly the upstream toolsets that share a tool with one a role can be allowed
  const allowable = hermesToolsets({ shell: true, web: true, delegation: true });
  for (const a of UPSTREAM.configurable_toolsets) {
    for (const b of allowable) {
      if (a !== b && UPSTREAM.toolset_tools[a].some((t) => UPSTREAM.toolset_tools[b].includes(t))) {
        assert.ok((HERMES_TOOLSET_OVERLAPS[a] || []).includes(b), `${a} shares a tool with ${b}; add it to HERMES_TOOLSET_OVERLAPS`);
      }
    }
  }
  // an overlap's legacy deny must not strip the shared tool, and stays inside the toolset
  for (const [ts, legacy] of Object.entries(HERMES_OVERLAP_LEGACY_DENY)) {
    const shared = HERMES_TOOLSET_OVERLAPS[ts].flatMap((o) => UPSTREAM.toolset_tools[o]);
    assert.ok(UPSTREAM.legacy_toolsets[legacy], `${legacy} is an upstream legacy name`);
    assert.ok(UPSTREAM.legacy_toolsets[legacy].every((t) => UPSTREAM.toolset_tools[ts].includes(t) && !shared.includes(t)), legacy);
  }
});

test("every role gets exactly its toolsets' tools on every gateway platform (Hermes semantics)", () => {
  for (const id of FIXTURE_IDS) {
    const cap = getRole(id).descriptor.local_capabilities;
    const conf = yamlParse(files(renderHermes(getRole(id)))["config.yaml"]);
    const want = [...toolsOf(hermesToolsets(cap))].sort();
    // every upstream gateway platform, including any the renderer did not pin (-> default composite)
    for (const platform of UPSTREAM.platforms) {
      assert.deepEqual(effectiveTools(conf, platform), want, `${id} on ${platform}`);
    }
  }
  const ivan = yamlParse(files(renderHermes(getRole("adversarial-auditor")))["config.yaml"]);
  assert.ok(effectiveTools(ivan, "cli").includes("web_search"));
  assert.ok(!effectiveTools(ivan, "sms").some((t) => t.startsWith("browser_")));
  assert.ok(!effectiveTools(ivan, "feishu").some((t) => t.startsWith("feishu_")));
});

test("nothing outside the allow-list is reachable: denied, or absent from every platform list", () => {
  for (const id of FIXTURE_IDS) {
    const cap = getRole(id).descriptor.local_capabilities;
    const conf = yamlParse(files(renderHermes(getRole(id)))["config.yaml"]);
    const allowed = hermesToolsets(cap), disabled = conf.agent.disabled_toolsets;
    assert.equal(allowed.filter((t) => disabled.includes(t)).length, 0, id);
    for (const t of HERMES_KNOWN_TOOLSETS.filter((x) => !allowed.includes(x))) {
      const listed = Object.values(conf.platform_toolsets).some((l) => l.includes(t));
      assert.ok(disabled.includes(t) || !listed, `${id}: ${t} is neither denied nor kept off the platform lists`);
      if (!disabled.includes(t)) {
        assert.ok((HERMES_TOOLSET_OVERLAPS[t] || []).some((o) => allowed.includes(o)), `${id}: ${t} undenied without an overlap`);
        if (HERMES_OVERLAP_LEGACY_DENY[t]) assert.ok(disabled.includes(HERMES_OVERLAP_LEGACY_DENY[t]), `${id}: legacy deny for ${t}`);
      }
    }
    for (const r of HERMES_RECOVERED_TOOLSETS) assert.ok(disabled.includes(r), `${id} must disable recovered ${r}`);
    for (const risky of ["code_execution", "computer_use", "cronjob", "discord", "discord_admin", "connections", "kanban", "browser"]) {
      assert.ok(disabled.includes(risky), `${id} must disable ${risky}`);
    }
    // v0.21.5: browser no longer bundles web_search, so it is denied for every role,
    // web roles included (in v0.15.1 they denied the legacy browser_tools instead)
    assert.ok(disabled.includes("browser"), id);
    assert.ok(!disabled.includes("browser_tools"), id);
  }
  // an unknown (third-party) platform keeps no browser tool for a web role, including
  // browser_exec and the browser_vault_* tools new in v0.21.5
  const ivan = yamlParse(files(renderHermes(getRole("adversarial-auditor")))["config.yaml"]);
  const denied = toolsOf(ivan.agent.disabled_toolsets);
  assert.deepEqual(UPSTREAM.toolset_tools.browser.filter((t) => !denied.has(t)), []);
  assert.ok(UPSTREAM.toolset_tools.browser.includes("browser_vault_fill") && !UPSTREAM.toolset_tools.browser.includes("web_search"));
  // one array per platform: no YAML anchors/aliases in the rendered file
  assert.doesNotMatch(files(renderHermes(getRole("adversarial-auditor")))["config.yaml"], /[&*]a\d/);
});

test("model routing renders a named custom provider with key_env and never a key", () => {
  const conf = yamlParse(files(renderHermes(getRole("pm-agent"), { hermes: routing }))["config.yaml"]);
  assert.deepEqual(conf.model, { provider: `custom:${HERMES_PROVIDER_NAME}`, base_url: routing.baseUrl, default: "qwen3-14b" });
  assert.deepEqual(conf.custom_providers, [{ name: HERMES_PROVIDER_NAME, base_url: routing.baseUrl, key_env: HERMES_KEY_ENV, model: "qwen3-14b" }]);
  assert.doesNotMatch(files(renderHermes(getRole("pm-agent"), { hermes: routing }))["config.yaml"], /api_key|sk-/);
  // per-role override
  assert.equal(yamlParse(files(renderHermes(getRole("code-agent"), { hermes: routing }))["config.yaml"]).model.default, "qwen3-coder");
  // no routing -> no model section
  const bare = yamlParse(files(renderHermes(getRole("pm-agent")))["config.yaml"]);
  assert.equal(bare.model, undefined);
  assert.equal(bare.custom_providers, undefined);
});

test("bound service credentials land in SOUL.md, only for mapped roles", () => {
  const integrations = { services: { forgejo: { serverName: "forgejo", tools: ["whoami", "create_comment", "merge_pull_request"], credentials: { "code-agent": "/abs/creds/code-agent.env" } } } };
  const soul = files(renderHermes(getRole("code-agent"), { integrations }))["SOUL.md"];
  assert.match(soul, /credential_file="\/abs\/creds\/code-agent.env"/);
  assert.match(soul, /whoami/);
  assert.doesNotMatch(soul, /merge_pull_request/); // not in code-agent's allowlist
  assert.doesNotMatch(files(renderHermes(getRole("pm-agent"), { integrations }))["SOUL.md"], /Bound service credentials/);
});

test("bound roles get a companion MCP entry whose include list is exactly the bound tools", () => {
  const integrations = { services: {
    forgejo: { serverName: "forgejo", contract: "vbcdx.forgejo/1", tools: ["whoami", "create_comment", "merge_pull_request"], credentials: { "code-agent": "/abs/creds/code-agent.env" } },
    coolify: { serverName: "coolify", contract: "vbcdx.coolify/1", tools: ["health", "deploy"], credentials: { "devops-agent": "/abs/creds/devops-agent.env" } },
  } };
  const code = yamlParse(files(renderHermes(getRole("code-agent"), { integrations }))["config.yaml"]);
  assert.deepEqual(Object.keys(code.mcp_servers), ["forgejo"]); // code-agent has no coolify allowlist
  assert.deepEqual(code.mcp_servers.forgejo, {
    command: "vbcdx-forgejo", args: ["mcp"],
    env: { VBCDX_FORGEJO_URL: "${VBCDX_FORGEJO_URL}", VBCDX_FORGEJO_WRITES: "${VBCDX_FORGEJO_WRITES}" },
    tools: { include: ["create_comment", "whoami"], prompts: false, resources: false },
  });
  const devops = yamlParse(files(renderHermes(getRole("devops-agent"), { integrations }))["config.yaml"]);
  assert.deepEqual(devops.mcp_servers.coolify.tools.include, ["deploy", "health"]);
  assert.equal(devops.mcp_servers.forgejo, undefined); // no forgejo credential mapping for devops-agent
  const pm = yamlParse(files(renderHermes(getRole("pm-agent"), { integrations }))["config.yaml"]);
  assert.equal(pm.mcp_servers, undefined); // unmapped role: nothing bound, nothing rendered
  const raw = files(renderHermes(getRole("code-agent"), { integrations }))["config.yaml"];
  assert.doesNotMatch(raw, /credential_file|\/abs\/creds/); // the credential path lives in SOUL.md only
});

test("Hermes routing config validation", () => {
  assert.equal(loadHermesRouting(cfg({})), null);
  assert.deepEqual(loadHermesRouting(cfg({ VBCDX_AGENTS_HERMES_BASE_URL: "https://x/v1", VBCDX_AGENTS_HERMES_MODEL: "m1", VBCDX_AGENTS_HERMES_MODEL_CODE_AGENT: "m2" })),
    { baseUrl: "https://x/v1", model: "m1", roleModels: { "code-agent": "m2" } });
  assert.throws(() => loadHermesRouting(cfg({ VBCDX_AGENTS_HERMES_MODEL: "m1" })), /requires VBCDX_AGENTS_HERMES_BASE_URL/);
  assert.throws(() => loadHermesRouting(cfg({ VBCDX_AGENTS_HERMES_BASE_URL: "https://x/v1" })), /requires VBCDX_AGENTS_HERMES_MODEL/);
  assert.throws(() => loadHermesRouting(cfg({ VBCDX_AGENTS_HERMES_BASE_URL: "https://u:p@x/v1", VBCDX_AGENTS_HERMES_MODEL: "m" })), /embed credentials/);
  assert.throws(() => loadHermesRouting(cfg({ VBCDX_AGENTS_HERMES_BASE_URL: "https://x/v1", VBCDX_AGENTS_HERMES_MODEL: "bad model" })), /valid model name/);
  assert.throws(() => loadHermesRouting(cfg({ VBCDX_AGENTS_HERMES_BASE_URL: "https://x/v1", VBCDX_AGENTS_HERMES_MODEL_NOT_A_ROLE: "m" })), /role of a loaded agent pack/);
});

test("Hermes config requires HERMES_HOME and translates it for launch", () => {
  const base = { VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c" };
  assert.throws(() => loadConfig(cfg(base), { harness: "hermes", scope: "user" }), /VBCDX_AGENTS_HERMES_HOME is required/);
  const c = loadConfig(cfg({ ...base, VBCDX_AGENTS_HERMES_HOME: "/h" }), { harness: "hermes", scope: "user" });
  assert.deepEqual(c.launchEnv, { HERMES_HOME: "/h" });
  assert.equal(c.hermes, null);
  assert.throws(() => loadConfig(cfg({ ...base, VBCDX_AGENTS_HERMES_HOME: "h" }), { harness: "hermes", scope: "user" }), /absolute/);
});

test("Hermes rejects --scope, defaults to user scope", () => {
  assert.equal(parseInitArgs(["--harness=hermes", "--env=/c"]).scope, "user");
  assert.throws(() => parseInitArgs(["--harness=hermes", "--env=/c", "--scope=project"]), /does not accept --scope/);
});

test("planner writes one profile directory per role under HERMES_HOME/profiles", () => {
  const args = parseInitArgs(["--harness=hermes", "--env=/c", "--agents=pm-agent,adversarial-auditor", "--dry-run"]);
  const entries = cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c", VBCDX_AGENTS_HERMES_HOME: "/h" });
  const plan = buildPlan(args, entries, { cwd: "/" });
  assert.deepEqual(plan.generated.map((g) => g.destination), [
    "/h/profiles/pm-agent/SOUL.md", "/h/profiles/pm-agent/profile.yaml", "/h/profiles/pm-agent/config.yaml",
    "/h/profiles/adversarial-auditor/SOUL.md", "/h/profiles/adversarial-auditor/profile.yaml", "/h/profiles/adversarial-auditor/config.yaml",
  ]);
  assert.ok(plan.warnings.some((w) => /No Hermes model routing/.test(w)));
});

// ── transport "http" (companion network mode, e.g. through an MCP gateway) ─────

const tmpDirs = [];
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function writeIntegrations(service) {
  const dir = mkdtempSync(pjoin(tmpdir(), "hermes-http-"));
  tmpDirs.push(dir);
  const tool = (name, effect) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect, required_permissions: [] });
  const manifest = { schema_version: 1, service: "forgejo", contract: "vbcdx.forgejo/1", package_version: "0.1.0",
    tools: [tool("create_comment", "write"), tool("merge_pull_request", "destructive"), tool("whoami", "read")] };
  writeFileSync(pjoin(dir, "forgejo.json"), JSON.stringify(manifest));
  const file = pjoin(dir, "integrations.json");
  writeFileSync(file, JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: pjoin(dir, "forgejo.json"), ...service } } }));
  return file;
}

test("integrations: http transport takes url + roles, never credentials", () => {
  const ok = loadIntegrations(writeIntegrations({ transport: "http", url: "https://gw.example/mcp/Forgejo", roles: ["code-agent"] }));
  assert.equal(ok.services.forgejo.transport, "http");
  assert.equal(ok.services.forgejo.url, "https://gw.example/mcp/Forgejo");
  assert.deepEqual(ok.services.forgejo.roles, ["code-agent"]);
  assert.deepEqual(ok.services.forgejo.credentials, {});
  const stdio = loadIntegrations(writeIntegrations({ credentials: { "code-agent": "/abs/c.env" } }));
  assert.equal(stdio.services.forgejo.transport, "stdio"); // default unchanged
  const bad = (svc, re) => assert.throws(() => loadIntegrations(writeIntegrations(svc)), re);
  bad({ transport: "http", url: "https://gw.example/mcp", roles: ["code-agent"], credentials: {} }, /roles list, not credentials/);
  bad({ transport: "http", roles: ["code-agent"] }, /requires a url/);
  bad({ transport: "http", url: "https://u:p@gw.example/mcp", roles: ["code-agent"] }, /embed credentials/);
  bad({ transport: "http", url: "https://gw.example/mcp" }, /requires a roles array/);
  bad({ transport: "http", url: "https://gw.example/mcp", roles: ["not-a-role"] }, /not a role of a loaded agent pack/);
  bad({ transport: "http", url: "https://gw.example/mcp", roles: ["code-agent", "code-agent"] }, /twice/);
  bad({ transport: "ws" }, /"stdio" or "http"/);
  bad({ url: "https://gw.example/mcp" }, /only valid with transport "http"/);
});

test("http-bound roles get url + per-profile bearer header, and a no-credential_file note", () => {
  const integrations = loadIntegrations(writeIntegrations({ transport: "http", url: "https://gw.example/mcp/Forgejo", roles: ["code-agent", "pm-agent"] }));
  const out = files(renderHermes(getRole("code-agent"), { integrations }));
  const conf = yamlParse(out["config.yaml"]);
  assert.deepEqual(conf.mcp_servers.forgejo, {
    url: "https://gw.example/mcp/Forgejo",
    headers: { Authorization: "Bearer ${VBCDX_FORGEJO_TOKEN}" },
    tools: { include: ["create_comment", "whoami"], prompts: false, resources: false },
  });
  assert.doesNotMatch(out["config.yaml"], /command:|credential_file/);
  assert.match(out["SOUL.md"], /identity is supplied by the connection; call forgejo tools without a credential_file argument/);
  assert.doesNotMatch(out["SOUL.md"], /credential_file="/);
  // pm-agent's allowlist includes merge_pull_request (destructive) -> bound, but only because it is in its reviewed allowlist
  const pm = yamlParse(files(renderHermes(getRole("pm-agent"), { integrations }))["config.yaml"]);
  assert.ok(pm.mcp_servers.forgejo.tools.include.includes("merge_pull_request"));
  // a role not listed gets nothing
  assert.equal(yamlParse(files(renderHermes(getRole("adversarial-auditor"), { integrations }))["config.yaml"]).mcp_servers, undefined);
});

test("http tool_prefix: the include list uses the gateway's names, the note keeps the plain ones", () => {
  const integrations = loadIntegrations(writeIntegrations({ transport: "http", url: "https://gw.example/mcp/Forgejo", tool_prefix: "Forgejo-", roles: ["code-agent"] }));
  const out = files(renderHermes(getRole("code-agent"), { integrations }));
  assert.deepEqual(yamlParse(out["config.yaml"]).mcp_servers.forgejo.tools.include, ["Forgejo-create_comment", "Forgejo-whoami"]);
  assert.match(out["SOUL.md"], /Tools available to your role: create_comment, whoami\./);
  assert.throws(() => loadIntegrations(writeIntegrations({ transport: "http", url: "https://gw.example/mcp", roles: ["code-agent"], tool_prefix: "bad prefix" })), /tool_prefix must be/);
  assert.throws(() => loadIntegrations(writeIntegrations({ transport: "http", url: "https://gw.example/mcp", roles: ["code-agent"], tool_prefix: "Forgejo." })), /tool_prefix must be/);
  assert.throws(() => loadIntegrations(writeIntegrations({ credentials: {}, tool_prefix: "Forgejo-" })), /only valid with transport "http"/);
});

test("tool_prefix also applies to Claude and OpenCode tool IDs (same gateway, same names)", () => {
  const integrations = loadIntegrations(writeIntegrations({ transport: "http", url: "https://gw.example/mcp/Forgejo", tool_prefix: "Forgejo-", roles: ["code-agent"] }));
  const claude = renderClaude(getRole("code-agent"), { integrations }).content;
  assert.match(claude, /mcp__forgejo__Forgejo-whoami/);
  assert.doesNotMatch(claude, /mcp__forgejo__whoami/);
  const opencode = renderOpencode(getRole("code-agent"), { integrations }).content;
  assert.match(opencode, /forgejo_Forgejo-whoami/);
  // stdio (no prefix) is unchanged
  const plain = loadIntegrations(writeIntegrations({ credentials: { "code-agent": "/abs/c.env" } }));
  assert.match(renderClaude(getRole("code-agent"), { integrations: plain }).content, /mcp__forgejo__whoami/);
});

test("plain http off-host needs allow_cleartext; init then warns", () => {
  const svc = (url, extra = {}) => ({ transport: "http", url, roles: ["code-agent"], ...extra });
  // rejected without the opt-in
  for (const url of ["http://forgejo-mcp:8080/mcp", "http://gw.example/mcp", "http://10.0.0.5/mcp", "http://127.evil.example/mcp", "http://127.0.0.1.nip.io/mcp"]) {
    assert.throws(() => loadIntegrations(writeIntegrations(svc(url))), /allow_cleartext/, url);
    assert.throws(() => loadIntegrations(writeIntegrations(svc(url, { allow_cleartext: false }))), /allow_cleartext/, url);
  }
  // https and loopback need no opt-in
  for (const url of ["https://gw.example/mcp", "http://127.0.0.1:8080/mcp", "http://127.1/mcp", "http://[::1]:8080/mcp", "http://localhost:8080/mcp"]) {
    assert.equal(loadIntegrations(writeIntegrations(svc(url))).services.forgejo.url, url);
  }
  assert.throws(() => loadIntegrations(writeIntegrations(svc("http://gw.example/mcp", { allow_cleartext: "yes" }))), /true or false/);
  assert.throws(() => loadIntegrations(writeIntegrations({ credentials: {}, allow_cleartext: true })), /only valid with transport "http"/);
  const warn = (service) => {
    const file = writeIntegrations(service);
    const args = parseInitArgs(["--harness=hermes", "--env=/c", "--agents=code-agent", "--dry-run"]);
    const entries = cfg({ VBCDX_AGENTS_BASE_DIR: "/b", VBCDX_AGENTS_CREDENTIALS_DIR: "/c", VBCDX_AGENTS_HERMES_HOME: "/h", VBCDX_AGENTS_INTEGRATIONS_FILE: file });
    return buildPlan(args, entries, { cwd: "/" }).warnings.filter((w) => /cleartext/.test(w));
  };
  // with the opt-in: accepted, and init still warns
  assert.match(warn(svc("http://forgejo-mcp:8080/mcp", { allow_cleartext: true }))[0], /cleartext to forgejo-mcp:8080/);
  assert.deepEqual(warn(svc("https://gw.example/mcp")), []);
  assert.deepEqual(warn(svc("http://127.0.0.1:8080/mcp")), []);
});

// A plugin toolset is switched on for every platform, pinned ones included, unless
// upstream keeps it default-off, so the bundled plugins' toolsets are denied by name.
// V0.15.1's retired names stay denied, so a render that reaches the old image still
// denies send_message on an unpinned gateway. Checked against v2026.9.24: an enabled
// google_meet turns an explicit cli list of [file] into [file, google_meet], and denying
// google_meet removes its meet_* tools; the retired names are skipped as unknown.
test("every role denies the bundled plugin toolsets and v0.15.1's retired names", () => {
  assert.deepEqual([...HERMES_PLUGIN_TOOLSETS].sort(), ["a2a", "google_meet"]);
  assert.deepEqual([...HERMES_RETIRED_TOOLSETS].sort(), ["messaging", "moa"]);
  // neither list is an upstream configurable toolset: the known list stays equal to upstream
  for (const t of [...HERMES_PLUGIN_TOOLSETS, ...HERMES_RETIRED_TOOLSETS]) {
    assert.ok(!UPSTREAM.configurable_toolsets.includes(t), `${t} is configurable upstream`);
    assert.ok(!HERMES_KNOWN_TOOLSETS.includes(t), t);
  }
  for (const id of FIXTURE_IDS) {
    const disabled = yamlParse(files(renderHermes(getRole(id)))["config.yaml"]).agent.disabled_toolsets;
    for (const t of [...HERMES_PLUGIN_TOOLSETS, ...HERMES_RETIRED_TOOLSETS]) assert.ok(disabled.includes(t), `${id} must disable ${t}`);
  }
});
