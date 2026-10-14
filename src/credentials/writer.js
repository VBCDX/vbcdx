// Optional credential triples and private credential-file semantics
// (spec section 5).
//
// The installer reads USER/TOKEN/PASSWORD triples from the literal config file,
// groups the three fields of one triple together (they are not collisions), and,
// only for the requested selection, validates completeness. A triple belongs to a
// role and, optionally, to one service:
//
//   VBCDX_AGENTS_<FIELD>_<ROLE>             -> <credentials-dir>/<role>.env
//   VBCDX_AGENTS_<FIELD>_<ROLE>__<SERVICE>  -> <credentials-dir>/<role>/<service>.env
//
// so a role bound to two tools holds two tokens, one per service. A role suffix
// never holds two underscores in a row (role ids have single hyphens), so the
// first `__` splits role from service unambiguously. Each file is written at mode
// 0600 inside 0700 directories, serialized so the companion service reader
// round-trips the values losslessly; the keys inside are the same for every
// service (VBCDX_AGENTS_ROLE/USER/TOKEN/PASSWORD), so a tool reads whichever file
// it is handed. It never invents a placeholder file, never borrows one role's or
// one service's credentials for another, and never lets a secret value reach a
// log, an error message, a manifest, or a command argument.

import { readFileSync } from "node:fs";
import { normalizeSuffix, isSafeId } from "../roles/registry.js";
import { isKnownRole } from "../roles/index.js";
import { parseEnvText } from "../config/env-parser.js";
import { FORGEJO_CONTRACT, isServiceName } from "../config/integrations.js";
import {
  atomicWrite, validateExistingFile, assertNoSymlinkComponents,
} from "../fs/safe-writer.js";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { configError, credentialError } from "../errors.js";

const FIELD_RE = /^VBCDX_AGENTS_(USER|TOKEN|PASSWORD)_(.+)$/;
const FIELDS = ["USER", "TOKEN", "PASSWORD"];

/** The config-file suffix of a role, or of a role and service: CODE_AGENT, CODE_AGENT__FORGEJO. */
const toSuffix = (id) => id.toUpperCase().replace(/-/g, "_");
export const credentialSuffix = (role, service = null) => (service ? `${toSuffix(role)}__${toSuffix(service)}` : toSuffix(role));

/** The config-file key for one field of a triple, e.g. VBCDX_AGENTS_TOKEN_CODE_AGENT__FORGEJO. */
export const credentialConfigKey = (field, role, service = null) => `VBCDX_AGENTS_${field}_${credentialSuffix(role, service)}`;

/** Where a triple's file lives: <dir>/<role>.env, or <dir>/<role>/<service>.env for one service. */
export function credentialPath(credentialsDir, role, service = null) {
  return service ? join(credentialsDir, role, `${service}.env`) : join(credentialsDir, `${role}.env`);
}

/** The map key collectCredentialTriples files a triple under. */
export const tripleKey = (role, service = null) => (service ? `${role}/${service}` : role);

/**
 * Collect credential triples from parsed config entries.
 *
 * @param {Map<string,string>} entries
 * @returns {Map<string,{role:string,service:string|null,known:boolean,user:string,token:string,password:string}>}
 *   keyed by tripleKey(role, service)
 * Throws configError (exit 2) on ambiguous suffix spellings, duplicate
 * normalized fields, or unsafe role or service identifiers.
 */
export function collectCredentialTriples(entries) {
  const byKey = new Map();
  // Track, per (triple, field), which raw suffix spelling set it — to detect
  // two spellings that normalize to the same triple/field.
  const seen = new Map(); // `${tripleKey}:${field}` -> rawSuffix

  for (const [key, value] of entries) {
    const m = FIELD_RE.exec(key);
    if (!m) continue;
    const field = m[1].toLowerCase(); // user|token|password
    const rawSuffix = m[2];
    const split = rawSuffix.indexOf("__");
    const role = normalizeSuffix(split === -1 ? rawSuffix : rawSuffix.slice(0, split));
    if (!isSafeId(role)) {
      throw configError(`Credential key ${key} has an invalid role suffix; expected a role id.`);
    }
    let service = null;
    if (split !== -1) {
      service = normalizeSuffix(rawSuffix.slice(split + 2));
      if (!isServiceName(service)) {
        throw configError(`Credential key ${key} has an invalid service suffix; expected <ROLE>__<SERVICE>, the service name upper-cased with hyphens as underscores.`);
      }
      // A role suffix never holds two underscores in a row, so an unknown role before the
      // first one is far likelier a mistyped role (CODE__AGENT for CODE_AGENT) than a role
      // of a pack that is not loaded: refuse it rather than drop it.
      if (!isKnownRole(role)) {
        throw configError(`Credential key ${key}: ${role} is not a role of a loaded agent pack. A role suffix uses single underscores (CODE_AGENT); two separate the role from a service (CODE_AGENT__FORGEJO).`);
      }
    }
    const tk = tripleKey(role, service);
    const sk = `${tk}:${field}`;
    if (seen.has(sk) && seen.get(sk) !== rawSuffix) {
      throw configError(
        `Ambiguous credential keys for ${service ? `role ${role} on ${service}` : `role ${role}`}: suffixes ${seen.get(sk)} and ${rawSuffix} normalize to the same field ${field}.`,
      );
    }
    if (byKey.get(tk)?.[field] !== undefined && seen.get(sk) === rawSuffix) {
      // Same raw key twice would already be a duplicate rejected by the parser;
      // this guards a normalized duplicate from a different spelling.
      throw configError(`Duplicate credential field ${field} for role ${role}${service ? ` on ${service}` : ""}.`);
    }
    seen.set(sk, rawSuffix);
    if (!byKey.has(tk)) {
      byKey.set(tk, { role, service, known: isKnownRole(role), user: "", token: "", password: "" });
    }
    byKey.get(tk)[field] = value;
  }
  return byKey;
}

const has = (v) => typeof v === "string" && v.trim() !== "";

/**
 * The fields a triple (or a file's values) still needs, as groups of alternatives:
 * [["USER"], ["TOKEN", "PASSWORD"]] means USER, and TOKEN or PASSWORD. Empty when complete.
 *
 * A role-wide file (no service) keeps its rule: USER plus TOKEN or PASSWORD. A
 * service's file follows the service's contract, the same rule the planner applies
 * to an externally provisioned file: the Forgejo contract needs USER plus TOKEN or
 * PASSWORD, any other contract needs TOKEN. A service no binding names yet has no
 * known contract, so it needs TOKEN, or USER and PASSWORD.
 *
 * @param {{user?:string, token?:string, password?:string}} values
 * @param {{service?:string|null, contract?:string|null}} [target]
 * @returns {string[][]}
 */
export function missingCredentialFields(values, { service = null, contract = null } = {}) {
  const user = has(values.user);
  const token = has(values.token);
  const password = has(values.password);
  const missing = [];
  if (!service || contract === FORGEJO_CONTRACT) {
    if (!user) missing.push(["USER"]);
    if (!token && !password) missing.push(["TOKEN", "PASSWORD"]);
  } else if (contract) {
    if (!token) missing.push(["TOKEN"]);
  } else if (!token && !(user && password)) {
    missing.push(user ? ["TOKEN", "PASSWORD"] : password ? ["TOKEN", "USER"] : ["TOKEN"]);
  }
  return missing;
}

/** "VBCDX_AGENTS_USER and VBCDX_AGENTS_TOKEN or VBCDX_AGENTS_PASSWORD" for missingCredentialFields groups. */
export function describeFields(groups, keyOf = (f) => `VBCDX_AGENTS_${f}`) {
  return groups.map((g) => g.map(keyOf).join(" or ")).join(" and ");
}

/** What a complete file for this target must contain, in words. */
export function requiredFieldsText(target) {
  return describeFields(missingCredentialFields({}, target));
}

/** @returns {"disabled"|"complete"|"incomplete"} */
export function classifyTriple(triple, target = { service: triple.service || null, contract: null }) {
  const anySet = FIELDS.some((f) => has(triple[f.toLowerCase()]));
  if (!anySet) return "disabled";
  return missingCredentialFields(triple, target).length === 0 ? "complete" : "incomplete";
}

/**
 * Serialize a credential file body. Values are JSON-quoted so the companion
 * reader's double-quoted (JSON-escaped) grammar decodes them back byte for
 * byte. ROLE is written first; USER, then whichever of TOKEN/PASSWORD are
 * nonblank. No blank field is emitted.
 */
export function serializeCredentialFile(triple) {
  const q = (v) => JSON.stringify(String(v));
  const lines = [`VBCDX_AGENTS_ROLE=${q(triple.role)}`];
  if (triple.user && triple.user.trim() !== "") lines.push(`VBCDX_AGENTS_USER=${q(triple.user)}`);
  if (triple.token && triple.token.trim() !== "") lines.push(`VBCDX_AGENTS_TOKEN=${q(triple.token)}`);
  if (triple.password && triple.password.trim() !== "") lines.push(`VBCDX_AGENTS_PASSWORD=${q(triple.password)}`);
  return lines.join("\n") + "\n";
}

/**
 * Inspect an existing credential file for a role (and, for a service's file, that
 * service and its contract, which decide the required fields).
 * @returns {{state:"absent"|"empty"|"valid"|"invalid"|"unsafe", reason?:string}}
 * Never returns or logs any credential value.
 */
export function evaluateExisting(absPath, role, target = {}) {
  let st;
  try {
    assertNoSymlinkComponents(absPath);
    st = lstatSync(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return { state: "absent" };
    return { state: "unsafe", reason: err.message };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { state: "unsafe", reason: "not a regular file (symlink or special file)" };
  }
  try {
    validateExistingFile(absPath, { secret: true });
  } catch (err) {
    return { state: "unsafe", reason: err.message };
  }
  const raw = readFileSync(absPath, "utf8");
  if (raw.trim() === "") return { state: "empty" };
  let parsed;
  try {
    parsed = parseEnvText(raw, absPath);
  } catch (err) {
    return { state: "invalid", reason: "malformed credential-file syntax" };
  }
  const fileRole = parsed.get("VBCDX_AGENTS_ROLE");
  const values = {
    user: parsed.get("VBCDX_AGENTS_USER"),
    token: parsed.get("VBCDX_AGENTS_TOKEN"),
    password: parsed.get("VBCDX_AGENTS_PASSWORD"),
  };
  // Never echo the file's own ROLE value: it is file content, and may be a secret pasted on the wrong line.
  if (fileRole === undefined) return { state: "invalid", reason: `role field is absent, expected ${role}` };
  if (fileRole !== role) return { state: "invalid", reason: `role field does not match the expected role ${role}` };
  if (!has(values.user) && !has(values.token) && !has(values.password)) return { state: "empty" };
  const missing = missingCredentialFields(values, target);
  if (missing.length) return { state: "invalid", reason: `missing ${describeFields(missing)}` };
  return { state: "valid" };
}

/**
 * Decide and (unless dry-run) perform the credential file operation for a
 * complete triple. `contract` is the bound service's contract, when known; it
 * decides which fields an existing file needs. The caller creates the file's
 * private directories first. Returns an action record with no secret values.
 *
 * @returns {{action:"written"|"retained"|"replaced", path:string}}
 */
export function writeCredentialFile({ credentialsDir, triple, contract = null, force = false, dryRun = false }) {
  if (!isSafeId(triple.role)) {
    throw credentialError(`Unsafe credential role identifier: ${triple.role}.`);
  }
  const service = triple.service || null;
  if (service !== null && !isServiceName(service)) {
    throw credentialError(`Unsafe credential service identifier: ${service}.`);
  }
  const absPath = credentialPath(credentialsDir, triple.role, service);
  const existing = evaluateExisting(absPath, triple.role, { service, contract });

  if (existing.state === "unsafe") {
    throw credentialError(
      `Existing credential file at ${absPath} is unsafe (${existing.reason}); it fails even with --force. ` +
        `Remove or repair it (regular file, mode 0600, owned by you, in a 0700 directory) and rerun.`,
    );
  }
  if (existing.state === "invalid") {
    throw credentialError(
      `Existing credential file at ${absPath} is invalid (${existing.reason}); it fails even with --force. ` +
        `Fix its ROLE/fields or remove it, then rerun. No input credentials were applied.`,
    );
  }
  if (existing.state === "valid" && !force) {
    // Retain untouched; be explicit that new input was NOT applied.
    return { action: "retained", path: absPath };
  }

  const body = serializeCredentialFile(triple);
  if (dryRun) {
    return { action: existing.state === "valid" ? "replaced" : "written", path: absPath, planned: true };
  }
  atomicWrite(absPath, body, { mode: 0o600, secret: true });
  return { action: existing.state === "valid" ? "replaced" : "written", path: absPath };
}
