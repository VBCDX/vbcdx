import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentCard,
  getAgentCard,
  allAgentCards,
  buildIndex,
  buildServerCard,
  A2A_PROTOCOL_VERSION,
} from "../src/a2a/card.js";
import { allRoles, getRole } from "../src/roles/index.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const BASE = "https://agents.example";

// AgentCard REQUIRED fields per specification/a2a.proto.
const REQUIRED_CARD_FIELDS = [
  "name",
  "description",
  "supportedInterfaces",
  "version",
  "capabilities",
  "defaultInputModes",
  "defaultOutputModes",
  "skills",
];

function assertValidCard(card, label) {
  for (const f of REQUIRED_CARD_FIELDS) {
    assert.ok(card[f] !== undefined, `${label}: missing required field ${f}`);
  }
  assert.equal(typeof card.name, "string");
  assert.ok(card.name.length > 0, `${label}: empty name`);
  assert.equal(typeof card.description, "string");
  assert.ok(card.description.length > 0, `${label}: empty description`);
  assert.equal(typeof card.version, "string");

  // supportedInterfaces REQUIRED and non-empty; each interface has the three
  // REQUIRED AgentInterface fields with a real absolute HTTPS url.
  assert.ok(Array.isArray(card.supportedInterfaces), `${label}: interfaces not array`);
  assert.ok(card.supportedInterfaces.length >= 1, `${label}: empty supportedInterfaces`);
  for (const iface of card.supportedInterfaces) {
    assert.equal(typeof iface.url, "string");
    assert.match(iface.url, /^https:\/\//, `${label}: interface url must be absolute HTTPS`);
    assert.equal(typeof iface.protocolBinding, "string");
    assert.ok(iface.protocolBinding.length > 0);
    assert.equal(iface.protocolVersion, A2A_PROTOCOL_VERSION);
  }

  assert.ok(Array.isArray(card.defaultInputModes) && card.defaultInputModes.length >= 1);
  assert.ok(Array.isArray(card.defaultOutputModes) && card.defaultOutputModes.length >= 1);

  // capabilities present (object). We implement none, so no flag may be true.
  assert.equal(typeof card.capabilities, "object");
  for (const flag of ["streaming", "pushNotifications", "extendedAgentCard"]) {
    assert.notEqual(card.capabilities[flag], true, `${label}: must not advertise ${flag}`);
  }

  // skills REQUIRED and non-empty; each AgentSkill has its REQUIRED fields.
  assert.ok(Array.isArray(card.skills) && card.skills.length >= 1, `${label}: no skills`);
  for (const skill of card.skills) {
    assert.equal(typeof skill.id, "string");
    assert.ok(skill.id.length > 0);
    assert.equal(typeof skill.name, "string");
    assert.ok(skill.name.length > 0);
    assert.equal(typeof skill.description, "string");
    assert.ok(skill.description.length > 0);
    assert.ok(Array.isArray(skill.tags), `${label}: skill tags not array`);
    for (const t of skill.tags) assert.equal(typeof t, "string");
  }
}

test("every loaded role has a valid A2A card, keyed at the right url", () => {
  const cards = allAgentCards(BASE);
  assert.equal(cards.size, FIXTURE_IDS.length);
  for (const id of FIXTURE_IDS) {
    const card = cards.get(id);
    assert.ok(card, `no card for ${id}`);
    assertValidCard(card, id);
    assert.equal(card.supportedInterfaces[0].url, `${BASE}/agents/${id}.json`);
  }
});

test("getAgentCard returns a card for a known id and undefined for unknown", () => {
  assert.ok(getAgentCard("code-agent", BASE));
  assert.equal(getAgentCard("does-not-exist", BASE), undefined);
  assert.equal(getAgentCard("../../etc/passwd", BASE), undefined);
  assert.equal(getAgentCard("", BASE), undefined);
});

test("card generation is deterministic — render twice, byte-identical", () => {
  for (const id of FIXTURE_IDS) {
    const a = JSON.stringify(getAgentCard(id, BASE));
    const b = JSON.stringify(getAgentCard(id, BASE));
    assert.equal(a, b, `card for ${id} is not deterministic`);
  }
});

test("card is a pure function of role + baseUrl (no hidden state across roles)", () => {
  const role = getRole("qa-agent");
  const first = JSON.stringify(buildAgentCard(role, BASE));
  // Build several other cards in between, then rebuild qa-agent.
  for (const id of FIXTURE_IDS) buildAgentCard(getRole(id), "https://other.example");
  const second = JSON.stringify(buildAgentCard(role, BASE));
  assert.equal(first, second);
});

test("keys serialize in camelCase (protobuf canonical JSON mapping)", () => {
  const json = JSON.stringify(getAgentCard("code-agent", BASE));
  // The snake_case proto names must not leak into the JSON.
  for (const snake of [
    "supported_interfaces",
    "default_input_modes",
    "default_output_modes",
    "protocol_binding",
    "protocol_version",
    "documentation_url",
  ]) {
    assert.ok(!json.includes(`"${snake}"`), `snake_case key leaked: ${snake}`);
  }
  assert.ok(json.includes('"supportedInterfaces"'));
  assert.ok(json.includes('"protocolBinding"'));
});

test("no card contains internal hostnames, credential var names, or local paths", () => {
  // The vendor-neutrality / no-secrets tenet: cards are served unauthenticated.
  const forbidden = [
    // One operator's domain, built so this file does not name it either.
    new RegExp(["tam", "tam"].join(""), "i"),
    /coolify/i,
    /forgejo/i,
    /FORGEJO_[A-Z_]+/,
    /COOLIFY_[A-Z_]+/,
    /\/home\/[a-z]/i,
    /\/(?:usr|etc|var|root)\//,
  ];
  const docs = [buildServerCard(BASE), buildIndex(BASE), ...allAgentCards(BASE).values()];
  for (const doc of docs) {
    const text = JSON.stringify(doc);
    for (const re of forbidden) {
      assert.ok(!re.test(text), `forbidden token ${re} found in a published document`);
    }
  }
});

test("the index lists every loaded role's card with resolvable urls in catalogue order", () => {
  const index = buildIndex(BASE);
  assert.equal(index.agents.length, FIXTURE_IDS.length);
  assert.deepEqual(
    index.agents.map((a) => a.id),
    [...FIXTURE_IDS],
  );
  for (const entry of index.agents) {
    assert.ok(FIXTURE_IDS.includes(entry.id));
    assert.equal(entry.url, `${BASE}/agents/${entry.id}.json`);
    assert.equal(typeof entry.name, "string");
  }
});

test("the server card describes the directory and is itself a valid card", () => {
  const card = buildServerCard(BASE);
  assertValidCard(card, "server-card");
  assert.match(card.description, /discovery/i);
});

test("every per-agent card discloses it is discovery-only in its description", () => {
  // A consumer that fetches only /agents/<id>.json must be able to tell, from
  // that response alone, that the interface is not a live message endpoint.
  for (const [id, card] of allAgentCards(BASE)) {
    assert.match(
      card.description,
      /discovery card only; not a live a2a message endpoint\./i,
      `${id}: description does not disclose discovery-only`,
    );
    // The role's own description text is still present (note is appended, not
    // replaced): the card carries both the role summary and the disclaimer.
    const roleDescription = getRole(id).descriptor.description.trimEnd();
    assert.ok(
      card.description.startsWith(roleDescription),
      `${id}: role description was replaced instead of appended to`,
    );
  }
});

test("every per-agent card declares the discovery-only extension (required:false)", () => {
  for (const [id, card] of allAgentCards(BASE)) {
    assert.ok(Array.isArray(card.capabilities.extensions), `${id}: no extensions array`);
    const ext = card.capabilities.extensions.find(
      (e) => e.uri === "urn:a2a:extension:discovery-only",
    );
    assert.ok(ext, `${id}: discovery-only extension missing`);
    assert.equal(ext.required, false, `${id}: discovery-only extension must not be required`);
    assert.equal(typeof ext.description, "string");
    assert.ok(ext.description.length > 0, `${id}: extension has empty description`);
    // The honesty property: adding the extension must not turn on a real-behaviour
    // flag we do not implement.
    for (const flag of ["streaming", "pushNotifications", "extendedAgentCard"]) {
      assert.notEqual(card.capabilities[flag], true, `${id}: must not advertise ${flag}`);
    }
  }
});

test("skill tags are vendor-neutral (generic categories, not backend names)", () => {
  for (const [id, role] of allRoles()) {
    const card = buildAgentCard(role, BASE);
    for (const skill of card.skills) {
      for (const tag of skill.tags) {
        assert.doesNotMatch(tag, new RegExp(["forgejo", "coolify", ["tam", "tam"].join("")].join("|"), "i"), `${id}: leaky tag ${tag}`);
      }
    }
  }
});
