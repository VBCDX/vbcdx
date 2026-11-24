// A2A Agent Card builders.
//
// Deterministically derives an A2A 1.0 Agent Card from a role descriptor of a
// loaded agent pack — the same single-source-of-truth rule the renderers follow.
// There are no hand-authored card files; every card is a pure function of the
// pack's role.json, so a card can never drift from its role.
//
// Schema verified against specification/a2a.proto in a2aproject/A2A (the spec's
// "single authoritative normative definition"). AgentCard REQUIRED fields:
// name, description, supportedInterfaces, version, capabilities,
// defaultInputModes, defaultOutputModes, skills. AgentInterface REQUIRED:
// url, protocolBinding, protocolVersion. AgentSkill REQUIRED: id, name,
// description, tags. JSON keys are camelCase (the protobuf canonical JSON
// mapping); the media type for a card is application/a2a+json.
//
// Design decision: these agents
// are role and prompt DEFINITIONS, not live A2A message endpoints — this server
// publishes their cards for discovery, it does not run the agents. A2A 1.0 has
// no descriptive-only card mode and REQUIRES a non-empty supportedInterfaces, so
// each card advertises exactly one interface whose url is the card's own
// resolvable HTTPS location with an HTTP+JSON binding. A client that POSTs an
// A2A message to that url gets a 405, not a task — the documented residual gap;
// a fully callable per-agent endpoint (spec `tenant` routing) is separate scope.
//
// So a consumer that fetches a single card learns this too, each card
// discloses the discovery-only nature both in prose (a trailing sentence on the
// description) and structurally (a non-required AgentExtension in capabilities).
// capabilities still carries NO real-behaviour flag — no streaming,
// pushNotifications, or extendedAgentCard is implemented, so none is advertised.

import { allRoles, getRole, roleIds } from "../roles/index.js";
import { trimTrailingSlash } from "../skills/catalogue.js";

// A2A protocol version negotiated on Major.Minor only ("Patch version numbers
// SHOULD NOT be used in Agent Cards").
export const A2A_PROTOCOL_VERSION = "1.0";

// Media type for an A2A JSON document.
export const A2A_MEDIA_TYPE = "application/a2a+json";

// The organization that authors these cards. Matches package.json "author".
const PROVIDER_ORGANIZATION = "VBCDX";

// Modes the agents work in. They consume and produce natural-language text.
const DEFAULT_INPUT_MODES = Object.freeze(["text/plain"]);
const DEFAULT_OUTPUT_MODES = Object.freeze(["text/plain"]);

// Discovery-only disclosure. A consumer that fetches only a single
// per-agent card — the documented, primary way to consume this — must be able to
// tell, from that response alone, that the advertised interface is for discovery
// and not a live A2A message endpoint (a POST to that url returns 405). We
// surface this two ways so neither audience is left guessing:
//   - a trailing sentence appended to each card's human-readable description, and
//   - a non-required AgentExtension in capabilities, so a machine consumer can
//     detect it structurally instead of parsing prose.
const DISCOVERY_ONLY_NOTE = "Discovery card only; not a live A2A message endpoint.";

// Stable identifier for the discovery-only extension. Deliberately a URN, not a
// resolvable URL: the whole point of this card is to avoid advertising URLs that
// do not behave the way a URL implies, so the extension is identified by name,
// not by a locator. Kept generic and host-neutral — this package is public.
const DISCOVERY_ONLY_EXTENSION_URI = "urn:a2a:extension:discovery-only";

// The AgentExtension declaring the card is discovery-only. This is a truthful
// statement ABOUT the card, not a claim to implement a protocol feature, so
// adding it does not compromise the "advertise no capability we do not
// implement" property — streaming/pushNotifications/extendedAgentCard stay unset.
// required:false — a consumer need NOT understand this extension to read the card.
function discoveryOnlyExtension() {
  return {
    uri: DISCOVERY_ONLY_EXTENSION_URI,
    description:
      "This interface is discovery-only: the card describes an agent role and " +
      "prompt definition, it is not a live A2A message endpoint. Sending an A2A " +
      "message to the advertised url returns 405 Method Not Allowed.",
    required: false,
  };
}

// Append the discovery-only note to the role description. Trailing whitespace is
// trimmed first so the sentence joins cleanly regardless of the source text.
function cardDescription(descriptor) {
  return `${descriptor.description.trimEnd()} ${DISCOVERY_ONLY_NOTE}`;
}

// A remote capability is shown as a GENERIC, vendor-neutral tag, never the vendor
// or service name, so a card carries no internal infra detail. The tag is the one
// the role's own pack declares for that capability's contract (vbcdx-pack.json
// `contract_tags`, a closed list of neutral words). A capability keyed by server
// name, as packs were before contracts, is mapped to its contract through the
// role's `dependencies`. A contract with no declared tag adds none: it is dropped
// rather than leaked, so a new backend can never publish its name on a card.
const CONTRACT_KEY = /^[a-z0-9][a-z0-9.-]{0,62}\/[1-9][0-9]{0,3}$/;

// The card version is the agent definition's version, derived from the role
// descriptor's schema_version as Major.0.0 (e.g. schema_version 1 -> "1.0.0").
function cardVersion(descriptor) {
  const major = Number.isInteger(descriptor.schema_version) ? descriptor.schema_version : 1;
  return `${major}.0.0`;
}

// Vendor-neutral capability tags for a role's single skill.
function skillTags(role) {
  const descriptor = role.descriptor;
  const declared = role.contractTags || {};
  const deps = descriptor.dependencies || {};
  const tags = [];
  if (descriptor.policy && descriptor.policy.kind) tags.push(descriptor.policy.kind);
  const local = descriptor.local_capabilities || {};
  if (local.filesystem) tags.push(`filesystem:${local.filesystem}`);
  if (local.shell) tags.push("shell");
  if (local.web) tags.push("web");
  if (local.delegation) tags.push("delegation");
  const remote = descriptor.remote_capabilities || {};
  for (const key of Object.keys(remote)) {
    const contract = CONTRACT_KEY.test(key) ? key : Object.hasOwn(deps, key) ? deps[key] : undefined;
    const tag = contract && Object.hasOwn(declared, contract) ? declared[contract] : undefined;
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

// One AgentSkill per agent, representing its role. description falls back to the
// full descriptor description if the policy has no summary.
function roleSkill(role) {
  const descriptor = role.descriptor;
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: (descriptor.policy && descriptor.policy.summary) || descriptor.description,
    tags: skillTags(role),
  };
}

/**
 * Build the A2A Agent Card for one role. Pure and deterministic: identical
 * (role, baseUrl) inputs always produce a byte-identical serialization.
 * Key insertion order is fixed here so JSON.stringify output is stable.
 */
export function buildAgentCard(role, baseUrl) {
  const descriptor = role.descriptor;
  const base = trimTrailingSlash(baseUrl);
  const cardUrl = `${base}/agents/${descriptor.id}.json`;
  return {
    name: descriptor.name,
    description: cardDescription(descriptor),
    version: cardVersion(descriptor),
    provider: { organization: PROVIDER_ORGANIZATION, url: base },
    documentationUrl: `${base}/agents/`,
    supportedInterfaces: [
      {
        url: cardUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    // Only the discovery-only extension — a truthful statement about the card.
    // No streaming/pushNotifications/extendedAgentCard: we implement none.
    capabilities: { extensions: [discoveryOnlyExtension()] },
    defaultInputModes: [...DEFAULT_INPUT_MODES],
    defaultOutputModes: [...DEFAULT_OUTPUT_MODES],
    skills: [roleSkill(role)],
  };
}

/** The card for a loaded role id, or undefined for an unknown id. */
export function getAgentCard(id, baseUrl) {
  const role = getRole(id);
  if (!role) return undefined;
  return buildAgentCard(role, baseUrl);
}

/** Every loaded role's card keyed by id, in catalogue order. */
export function allAgentCards(baseUrl) {
  const out = new Map();
  for (const [id, role] of allRoles()) out.set(id, buildAgentCard(role, baseUrl));
  return out;
}

/**
 * The index served at /agents/ — a plain JSON listing of the available cards so
 * a consumer can enumerate them without guessing ids.
 */
export function buildIndex(baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  return {
    agents: roleIds().map((id) => ({
      id,
      name: getRole(id).descriptor.name,
      url: `${base}/agents/${id}.json`,
    })),
  };
}

/**
 * The card served at /.well-known/agent-card.json — describes THIS server (a
 * directory/aggregator), keeping the deployment discoverable via the A2A
 * convention while the per-agent cards live under /agents/.
 */
export function buildServerCard(baseUrl) {
  const base = trimTrailingSlash(baseUrl);
  return {
    name: "VBCDX Agent Directory",
    description:
      "Publishes A2A agent cards for the roles of the loaded agent packs at " +
      "/agents/<id>.json. Discovery only: the cards describe agent role and " +
      "prompt definitions, not live task endpoints.",
    version: "1.0.0",
    provider: { organization: PROVIDER_ORGANIZATION, url: base },
    documentationUrl: `${base}/agents/`,
    supportedInterfaces: [
      {
        url: `${base}/agents/`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: {},
    defaultInputModes: [...DEFAULT_INPUT_MODES],
    defaultOutputModes: [A2A_MEDIA_TYPE],
    skills: [
      {
        id: "list-agent-cards",
        name: "List agent cards",
        description:
          "Enumerate and serve the A2A agent cards for the roles of the loaded agent packs.",
        tags: ["directory", "discovery"],
      },
    ],
  };
}
