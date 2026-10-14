// Role-id helpers and the supported harnesses.
//
// A role's credential suffix is exactly its id upper-cased with hyphens replaced by
// underscores; normalizing a suffix (lowercase, underscores -> hyphens) recovers the
// id. Which ids exist is up to the loaded agent packs (src/roles/index.js).

export const HARNESSES = Object.freeze(["claude", "codex", "opencode", "hermes"]);

/** Convert a role id to its credential suffix. */
export function idToSuffix(id) {
  return id.toUpperCase().replace(/-/g, "_");
}

/**
 * Normalize a credential suffix to a role-style id: lowercase and replace
 * underscores with hyphens. The caller decides whether it names a loaded role.
 */
export function normalizeSuffix(suffix) {
  return String(suffix).toLowerCase().replace(/_/g, "-");
}

// A safe identifier for use as a filename / path component: lowercase, digits and
// single hyphens, no leading/trailing/double hyphen, no separators or traversal.
// Used for role ids and unknown-role credential filenames alike.
const SAFE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSafeId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && SAFE_ID_RE.test(id);
}
