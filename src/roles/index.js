// Role lookup. The installer ships no roles of its own: every role comes from an
// agent pack (src/packs/load.js), and these lookups read the catalogue of the packs
// this run loaded (src/packs/catalog.js). There is exactly one prompt and one
// descriptor per role, consumed by every renderer, never a per-harness copy.

import { activeCatalog } from "../packs/catalog.js";

/** Every loaded role keyed by id, in pack order then each pack's declared order. */
export function allRoles() {
  return activeCatalog().roles;
}

/** The ids of every loaded role, in order. */
export function roleIds() {
  return [...activeCatalog().ids];
}

/** A loaded role by id, or undefined. */
export function getRole(id) {
  return activeCatalog().roles.get(id);
}

/** True when `id` is a role of a loaded pack. */
export function isKnownRole(id) {
  return typeof id === "string" && activeCatalog().roles.has(id);
}
