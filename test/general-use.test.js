// The general-use group (run alone with `npm run test:general-use`).
//
// Every documented extension point is driven by an entry that is not first-party: an agent
// pack, a tool package (vbcdx.json), an overlay, a custom source and the integrations file.
// The first-party entries are then put through the same calls, and the results must be the
// same once the entry's own names are blanked: a name switch for a first-party server or
// contract, anywhere on these paths, makes its result differ from the third party's and fails.
//
// No first-party rule is left on purpose: every first-party entry must take the third party's path.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIXTURE_PACK_DIR } from "./helpers/fixture-pack.js";
import { readPack, PACK_DECLARATION_FILE } from "../src/packs/load.js";
import { buildCatalog } from "../src/packs/catalog.js";
import { readOverlay } from "../src/overlays/overlay.js";
import { loadIntegrations, COOLIFY_CONTRACT } from "../src/config/integrations.js";
import { validateToolDeclaration, assertToolDeclaration } from "../src/install/tool-declaration.js";
import { installedToolBindings } from "../src/install/commands.js";
import { boundServiceTools } from "../src/renderers/native.js";
import { renderClaude, renderCodex, renderOpencode, renderHermes } from "../src/renderers/index.js";
import { buildAgentCard } from "../src/a2a/card.js";
import { validateSources, SHORTHANDS } from "../src/sources/config.js";

process.umask(0o022);

const roots = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "vbcdx-general-use-")); roots.push(d); return d; };
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// The code host's contract has no constant in src/ (nothing there may key on it); the bundled
// declarations carry it as text.
const FORGEJO_CONTRACT = "vbcdx.forgejo/1";
// The third-party entry comes first: it is the reference every other entry is compared with.
const THIRD_PARTY = { label: "a third party's server and contract", server: "ledger", contract: "example.board/1" };
const ENTRIES = [
  THIRD_PARTY,
  { label: "the first-party code host", server: "forgejo", contract: FORGEJO_CONTRACT },
  { label: "the first-party deployer", server: "coolify", contract: COOLIFY_CONTRACT },
  { label: "a first-party server name on a third-party contract", server: "forgejo", contract: "example.board/1" },
  { label: "a third-party server name on a first-party contract", server: "ledger", contract: FORGEJO_CONTRACT },
];
const TOOLS = ["get_item", "list_items"];
const ROLE_ID = "solo-agent";
const HARNESSES = ["claude", "codex", "opencode", "hermes"];

test("the entries are what the group claims: one third party, and both first-party contracts", () => {
  assert.equal(SHORTHANDS[THIRD_PARTY.server], undefined, "the reference entry is no built-in source");
  assert.notEqual(THIRD_PARTY.contract, FORGEJO_CONTRACT);
  assert.notEqual(THIRD_PARTY.contract, COOLIFY_CONTRACT);
  assert.deepEqual(ENTRIES.filter((e) => e.contract !== THIRD_PARTY.contract).map((e) => e.contract).sort(), [COOLIFY_CONTRACT, FORGEJO_CONTRACT, FORGEJO_CONTRACT].sort());
});

/** A value as text with the entry's own names (and a scratch directory) blanked. */
function blank(value, e, dir) {
  let s = JSON.stringify(value, null, 1);
  if (dir) s = s.split(dir).join("<dir>");
  s = s.split(e.contract).join("<contract>");
  s = s.split(e.server).join("<server>").split(e.server.toUpperCase()).join("<SERVER>");
  // The blanking must have had something to blank, or the comparison proves nothing.
  assert.ok(s.includes("<contract>") || s.includes("<server>") || s.includes("<SERVER>"), "the result names the entry");
  return s;
}

/** Runs `fn` for every entry and requires every result to equal the third party's. */
function sameForAll(fn) {
  const results = ENTRIES.map((e) => fn(e));
  for (let i = 1; i < ENTRIES.length; i++) assert.equal(results[i], results[0], ENTRIES[i].label);
  return results[0];
}

// ── agent packs ─────────────────────────────────────────────────────────────────────────

const ROLE = readJson(join(FIXTURE_PACK_DIR, "assets", "roles", "code-agent", "role.json"));

/** A one-role pack of a third party whose role uses the entry's contract. */
function packFor(e) {
  const dir = join(scratch(), "pack");
  writeJson(join(dir, "package.json"), { name: "@acme/agents", version: "0.1.0" });
  writeJson(join(dir, PACK_DECLARATION_FILE), {
    schema_version: 1, name: "acme-agents", roles_dir: "roles", roles: [ROLE_ID],
    contracts: [e.contract], contract_tags: { [e.contract]: "code-host" },
  });
  writeJson(join(dir, "roles", ROLE_ID, "role.json"), {
    ...ROLE, id: ROLE_ID, credential_suffix: "SOLO_AGENT", name: "Solo Agent", dependencies: {}, remote_capabilities: { [e.contract]: TOOLS },
  });
  writeFileSync(join(dir, "roles", ROLE_ID, "prompt.md"), "You work alone.\n\n<!-- vbcdx:slot team-rules -->No team rules.<!-- /vbcdx:slot -->\n");
  return { dir, pack: readPack(dir) };
}
const roleFor = (e) => packFor(e).pack.roles[0];

test("agent pack: a third party's pack loads, and a pack on a first-party contract loads the same", () => {
  const text = sameForAll((e) => {
    const { dir, pack } = packFor(e);
    assert.deepEqual(pack.roles.map((r) => r.id), [ROLE_ID]);
    assert.deepEqual([...pack.contracts], [e.contract]);
    return blank({ name: pack.name, contracts: pack.contracts, tags: pack.contractTags, role: pack.roles[0] }, e, dir);
  });
  assert.match(text, /"<contract>": "code-host"/);
});

// ── tool packages (vbcdx.json) ──────────────────────────────────────────────────────────

const declFor = (e) => ({ schema_version: 1, server_name: e.server, contract: e.contract, stdio: { bin: "acme-tool", args: ["serve"] }, env: [], manifest: { args: ["manifest"] } });

test("tool package: a third party's vbcdx.json is valid, and a first-party one is judged the same", () => {
  sameForAll((e) => {
    const r = validateToolDeclaration(declFor(e));
    assert.deepEqual(r, { ok: true, errors: [] }, e.label);
    assertToolDeclaration(declFor(e));
    // A broken declaration earns the same errors whoever it names.
    const bad = validateToolDeclaration({ ...declFor(e), contract: `${e.contract}.x`, stdio: { bin: "../x", args: [] } });
    assert.equal(bad.ok, false);
    return blank({ decl: declFor(e), errors: bad.errors }, e);
  });
});

/** What `vbcdx install tool` records for the entry, read back as the role's bindings. */
function installedFor(e, harness) {
  const ctx = { harness, scope: "user", config: { harnessRoot: "/h" } };
  const record = { server_name: e.server, contract: e.contract, tools: [...TOOLS], launch: { command: "acme-tool", args: ["serve"] }, env: [] };
  return installedToolBindings(ctx, { tools: { [`${harness}:user:/h:${e.server}`]: record } }, [ROLE_ID]);
}

for (const harness of HARNESSES) {
  test(`tool package: an installed third-party tool binds to the role and renders for ${harness}; a first-party one takes the same path`, () => {
    const render = { claude: renderClaude, codex: renderCodex, opencode: renderOpencode, hermes: renderHermes }[harness];
    const text = sameForAll((e) => {
      const role = roleFor(e);
      const integrations = installedFor(e, harness);
      const bindings = boundServiceTools(role.descriptor, integrations);
      assert.equal(bindings.length, 1, e.label);
      assert.deepEqual(bindings[0].tools, TOOLS);
      // No entry, first-party or not, gets a git carrier: the binding has no git field at all.
      assert.equal(Object.hasOwn(bindings[0], "gitUrl"), false);
      assert.equal(Object.hasOwn(bindings[0], "gitMode"), false);
      return blank({ bindings, rendered: render(role, { integrations }), unbound: render(role, {}) }, e);
    });
    assert.match(text, /get_item/, "the rendered role names the bound tools");
  });
}

test("tool package: a role that lists another contract gets no binding, whichever side is first-party", () => {
  for (const e of ENTRIES) {
    for (const other of ENTRIES.filter((o) => o.contract !== e.contract && o.server !== e.server)) {
      assert.deepEqual(boundServiceTools(roleFor(other).descriptor, installedFor(e, "claude")), [], `${e.label} / ${other.label}`);
    }
  }
});

// ── the integrations file ───────────────────────────────────────────────────────────────

test("integrations file: a third party's service loads, and a first-party one loads the same", () => {
  const text = sameForAll((e) => {
    const dir = scratch();
    const manifestFile = join(dir, "manifest.json");
    const tool = (name) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] });
    writeJson(manifestFile, { schema_version: 1, service: e.server, contract: e.contract, package_version: "1.0.0", tools: TOOLS.map(tool) });
    const file = join(dir, "integrations.json");
    writeJson(file, { schema_version: 1, services: { [e.server]: { server_name: e.server, manifest_file: manifestFile } } });
    const res = loadIntegrations(file);
    assert.equal(res.services[e.server].contract, e.contract);
    assert.deepEqual(res.services[e.server].tools, TOOLS);
    // The file binds no role by itself: the same answer for every entry.
    assert.deepEqual(boundServiceTools(roleFor(e).descriptor, res), []);
    return blank(res, e, dir);
  });
  assert.match(text, /"contract": "<contract>"/);
});

// ── the agent card ──────────────────────────────────────────────────────────────────────

test("agent card: a contract's tag is the one its pack declares, first-party or not, and no name is published", () => {
  const cards = ENTRIES.map((e) => {
    const card = buildAgentCard(roleFor(e), "https://agents.example");
    assert.ok(card.skills[0].tags.includes("code-host"), e.label);
    const text = JSON.stringify(card);
    assert.equal(text.includes(e.contract), false, "a card carries no contract id");
    return text;
  });
  for (let i = 1; i < cards.length; i++) assert.equal(cards[i], cards[0], ENTRIES[i].label);
});

// ── overlays ────────────────────────────────────────────────────────────────────────────

test("overlay: a team's overlay composes onto a third party's pack, and the same on a first-party contract", () => {
  const text = sameForAll((e) => {
    const { dir, pack } = packFor(e);
    const o = join(dirname(dir), "overlay");
    writeJson(join(o, "vbcdx-overlay.json"), { schema_version: 1, name: "team", version: "1.0.0", packs: ["acme-agents"] });
    writeFileSync(join(o, "all.md"), "Every change gets a second reader.\n");
    mkdirSync(join(o, "slots"));
    writeFileSync(join(o, "slots", "team-rules.md"), "Ask before you merge.\n");
    const overlay = readOverlay(o);
    const role = buildCatalog([pack], { overlays: [overlay] }).roles.get(ROLE_ID);
    assert.equal(role.prompt, "You work alone.\n\nAsk before you merge.\n\nEvery change gets a second reader.\n");
    assert.deepEqual(role.overlays, [{ name: "team", version: "1.0.0", digest: overlay.digest }]);
    return blank({ prompt: role.prompt, descriptor: role.descriptor, overlays: role.overlays.map((x) => x.name) }, e, dirname(dir));
  });
  assert.match(text, /<contract>/);
});

// ── custom sources ──────────────────────────────────────────────────────────────────────

test("custom source: a third party's git source is accepted, and a source named like a first-party one is no different", () => {
  sameForAll((e) => {
    const doc = { schema_version: 1, sources: { [e.server]: { git: "https://git.example/acme/tool.git", ref: "main", auth_env: "ACME_TOKEN" }, local: { dir: "../packs" } } };
    const out = validateSources(doc, "/base");
    assert.deepEqual(out.map((s) => s.origin), ["git", "dir"]);
    return blank(out, e);
  });
});

test("custom source: a built-in shorthand is a table lookup and nothing more", () => {
  for (const [name, url] of Object.entries(SHORTHANDS)) {
    const [viaShorthand] = validateSources({ schema_version: 1, sources: { mine: { shorthand: name, ref: "main" } } }, "/base");
    const [viaUrl] = validateSources({ schema_version: 1, sources: { mine: { git: url, ref: "main" } } }, "/base");
    assert.deepEqual(viaShorthand, { ...viaUrl, shorthand: name }, name);
  }
  assert.throws(() => validateSources({ schema_version: 1, sources: { mine: { shorthand: THIRD_PARTY.server, ref: "main" } } }, "/base"), /unknown shorthand/);
});
