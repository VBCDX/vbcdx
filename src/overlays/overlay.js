// Overlays: a team's rules layered onto the roles of the agent packs it
// names, without forking them.
//
// An overlay is a directory with a vbcdx-overlay.json at its root (schema/vbcdx-overlay.schema.json)
// and, optionally:
//   all.md                    appended to every role of the overlay's packs
//   roles/<id>.md             appended to that role
//   slots/<name>.md           replaces the body of slot <name> in every role that has it
//   slots/<role>/<name>.md    replaces it in that role only (wins over slots/<name>.md)
// A pack's prompt marks a replaceable section as
//   <!-- vbcdx:slot <name> -->neutral default<!-- /vbcdx:slot -->
// and uses its declared variables (vbcdx-pack.json vars) as {{vars.<name>}}.
//
// One role's prompt is composed in this order: the core prompt with its slots filled, then
// each overlay's all.md and roles/<id>.md in overlay order; variables are expanded over the
// whole result in one pass, so a value is never expanded again. The renderers then add the
// credential-binding note and the git note as before. With no overlay a prompt with no slot
// and no variable is returned unchanged, so a pack that uses neither renders exactly as it
// did. Every rule is checked up front: an unknown pack, role, slot or variable, a malformed
// declaration or an empty file fails by name before anything is written.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "../config/json.js";
import { configError } from "../errors.js";

export const OVERLAY_DECLARATION_FILE = "vbcdx-overlay.json";
export const OVERLAY_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema", "vbcdx-overlay.schema.json");
const SCHEMA = JSON.parse(readFileSync(OVERLAY_SCHEMA_PATH, "utf8"));
const P = SCHEMA.properties;
const re = (node) => new RegExp(node.pattern);
const RE = {
  $schema: re(P.$schema), name: re(P.name), version: re(P.version), line: re(P.description),
  pack: re(P.packs.items), varName: re(P.vars.propertyNames), varValue: re(P.vars.additionalProperties),
  roleId: re(P.rename.additionalProperties),
};
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // a role id or slot name: a file or directory name
const SLOT_RE = /<!-- vbcdx:slot ([a-z0-9]+(?:-[a-z0-9]+)*) -->([\s\S]*?)<!-- \/vbcdx:slot -->/g;
const VAR_RE = /\{\{vars\.([^{}\s]*)\}\}/g;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate a parsed vbcdx-overlay.json (per-field rules). */
export function validateOverlayDeclaration(decl) {
  const errors = [];
  if (!isObject(decl)) return { ok: false, errors: [`${OVERLAY_DECLARATION_FILE} must be a JSON object.`] };
  for (const k of Object.keys(decl)) if (!(k in P)) errors.push(`unknown field ${JSON.stringify(k)}.`);
  for (const k of SCHEMA.required) if (!(k in decl)) errors.push(`missing required field ${k}.`);
  if ("$schema" in decl && (typeof decl.$schema !== "string" || decl.$schema.length > P.$schema.maxLength || !RE.$schema.test(decl.$schema))) {
    errors.push("$schema must be a relative path ending in vbcdx-overlay.schema.json (no URL).");
  }
  if ("schema_version" in decl && decl.schema_version !== P.schema_version.const) errors.push(`schema_version must be ${P.schema_version.const}.`);
  if ("name" in decl && (typeof decl.name !== "string" || !RE.name.test(decl.name))) errors.push("name must be 2-64 lowercase letters, digits and hyphens.");
  if ("version" in decl && (typeof decl.version !== "string" || !RE.version.test(decl.version))) errors.push("version must be one short version token.");
  if ("description" in decl && (typeof decl.description !== "string" || decl.description.length > P.description.maxLength || !RE.line.test(decl.description))) {
    errors.push("description must be one non-empty line of printable text.");
  }
  if ("packs" in decl) {
    const p = decl.packs;
    if (!Array.isArray(p) || p.length < P.packs.minItems || p.length > P.packs.maxItems) errors.push(`packs must list 1-${P.packs.maxItems} pack names.`);
    else if (!p.every((x) => typeof x === "string" && RE.pack.test(x)) || new Set(p).size !== p.length) errors.push("packs must list distinct pack names.");
  }
  if ("vars" in decl) {
    const v = decl.vars;
    if (!isObject(v)) errors.push("vars must be an object.");
    else {
      if (Object.keys(v).length > P.vars.maxProperties) errors.push(`vars has more than ${P.vars.maxProperties} values.`);
      for (const [k, val] of Object.entries(v)) {
        if (!RE.varName.test(k)) errors.push(`vars: ${JSON.stringify(k)} is not a variable name.`);
        else if (typeof val !== "string" || val.length === 0 || val.length > P.vars.additionalProperties.maxLength || !RE.varValue.test(val)) {
          errors.push(`vars.${k} must be one non-empty line of printable text of at most ${P.vars.additionalProperties.maxLength} characters.`);
        }
      }
    }
  }
  if ("rename" in decl) {
    const m = decl.rename;
    if (!isObject(m)) errors.push("rename must be an object.");
    else {
      if (Object.keys(m).length > P.rename.maxProperties) errors.push(`rename has more than ${P.rename.maxProperties} roles.`);
      const to = new Set();
      for (const [from, id] of Object.entries(m)) {
        if (!RE.roleId.test(from) || from.length > 64) errors.push(`rename: ${JSON.stringify(from)} is not a role id.`);
        else if (typeof id !== "string" || !RE.roleId.test(id) || id.length > 64) errors.push(`rename.${from} must be a role id (lowercase hyphenated words).`);
        else if (id === from) errors.push(`rename.${from} renames the role to itself.`);
        else if (to.has(id)) errors.push(`rename gives two roles the id ${id}.`);
        else to.add(id);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** A regular, non-empty UTF-8 text file inside the overlay directory (no symlink out of it). */
function readText(root, rel, label) {
  const abs = join(root, rel);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    throw configError(`${label}: ${rel} cannot be read.`);
  }
  const r = relative(root, real);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) throw configError(`${label}: ${rel} leads outside the overlay.`);
  if (!lstatSync(real).isFile()) throw configError(`${label}: ${rel} is not a regular file.`);
  const text = readFileSync(real, "utf8");
  if (text.trim() === "") throw configError(`${label}: ${rel} is empty.`);
  return text;
}

/** The *.md files directly in `rel` (a directory of the overlay), as { name: text }. */
function readMdDir(root, rel, label) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return {};
  const out = {};
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (!NAME_RE.test(name)) throw configError(`${label}: ${rel}/${entry} is not named <lowercase-hyphenated-name>.md.`);
    out[name] = readText(root, `${rel}/${entry}`, label);
  }
  return out;
}

/**
 * Read and validate an overlay directory.
 * @returns {{name, version, description, packs, vars, dir, all, roles, slots, roleSlots, digest}}
 */
export function readOverlay(overlayDir) {
  let root;
  try {
    root = realpathSync(overlayDir);
  } catch {
    throw configError(`No overlay directory at ${overlayDir}.`);
  }
  const declPath = join(root, OVERLAY_DECLARATION_FILE);
  if (!existsSync(declPath)) throw configError(`${root} has no ${OVERLAY_DECLARATION_FILE}; it is not a VBCDX overlay.`);
  const decl = parseStrictJson(readText(root, OVERLAY_DECLARATION_FILE, `Overlay ${root}`), declPath);
  const { ok, errors } = validateOverlayDeclaration(decl);
  if (!ok) {
    const lines = [`Overlay ${declPath} is invalid:`, ...errors.map((e) => `  ${e}`)];
    throw configError(lines.join("\n"), { lines });
  }
  const label = `Overlay ${decl.name}`;
  const all = existsSync(join(root, "all.md")) ? readText(root, "all.md", label) : null;
  const roles = readMdDir(root, "roles", label);
  const slots = readMdDir(root, "slots", label);
  const roleSlots = {};
  const slotsDir = join(root, "slots");
  if (existsSync(slotsDir)) {
    for (const entry of readdirSync(slotsDir).sort()) {
      if (entry.endsWith(".md")) continue;
      if (!lstatSync(join(slotsDir, entry)).isDirectory()) continue;
      if (!NAME_RE.test(entry)) throw configError(`${label}: slots/${entry} is not named after a role.`);
      roleSlots[entry] = readMdDir(root, `slots/${entry}`, label);
    }
  }
  // What shaped a render: the declaration and every text the overlay contributes.
  const h = createHash("sha256");
  h.update(JSON.stringify(decl));
  for (const [kind, map] of [["all", { all: all || "" }], ["roles", roles], ["slots", slots]]) {
    for (const k of Object.keys(map).sort()) h.update(`\0${kind}/${k}\0${map[k]}`);
  }
  for (const r of Object.keys(roleSlots).sort()) for (const k of Object.keys(roleSlots[r]).sort()) h.update(`\0slots/${r}/${k}\0${roleSlots[r][k]}`);
  return Object.freeze({
    name: decl.name, version: decl.version, description: decl.description || "", packs: [...decl.packs],
    vars: { ...(decl.vars || {}) }, rename: { ...(decl.rename || {}) }, dir: root, all, roles, slots, roleSlots, digest: `sha256:${h.digest("hex")}`,
  });
}

/** True when the overlay directory also ships an agent pack (new roles of its own). */
export const overlayShipsPack = (overlay) => existsSync(join(overlay.dir, "vbcdx-pack.json"));

/**
 * The local ids the overlays give pack roles (`rename`): pack role id -> local id. Each
 * renamed role must belong to the renaming overlay's packs, be renamed once, and get an
 * id no loaded role or other rename uses.
 */
function renames(packs, overlays) {
  const ownerPack = new Map();
  for (const p of packs) for (const r of p.roles) ownerPack.set(r.id, p.name);
  const map = new Map();
  const taken = new Set(ownerPack.keys());
  for (const o of overlays) {
    for (const [from, to] of Object.entries(o.rename)) {
      const label = `Overlay ${o.name}`;
      if (!ownerPack.has(from) || !o.packs.includes(ownerPack.get(from))) throw configError(`${label} renames ${from}, which is not a role of its packs.`);
      if (map.has(from)) throw configError(`${label} renames ${from}, which another overlay already renamed to ${map.get(from)}.`);
      if (taken.has(to)) throw configError(`${label} renames ${from} to ${to}, which is already a role id.`);
      map.set(from, to);
      taken.add(to);
    }
  }
  return map;
}

/**
 * Check the overlays against the loaded packs, then compose every role's prompt.
 * Roles are keyed by the id they install under: a renamed role by its local id.
 * @param {Array} packs read packs (readPack), in load order
 * @param {Array} overlays read overlays (readOverlay), in apply order
 * @returns {Map<string, {prompt:string, overlays:Array, renamedFrom:string|null}>} installed id -> composed prompt, the overlays that shaped it, and its pack id when renamed
 */
export function composeRoles(packs, overlays = []) {
  const packByName = new Map(packs.map((p) => [p.name, p]));
  const renamed = renames(packs, overlays);
  const roleById = new Map();
  for (const p of packs) for (const r of p.roles) roleById.set(renamed.get(r.id) || r.id, { role: r, pack: p });

  const slotNames = new Map(); // role id -> Set of slot names in its core prompt
  for (const [id, { role }] of roleById) {
    const names = new Set();
    for (const m of role.prompt.matchAll(SLOT_RE)) {
      if (names.has(m[1])) throw configError(`Role ${id} marks slot ${m[1]} twice.`);
      if (m[2].includes("<!-- vbcdx:slot ")) throw configError(`Role ${id}: slot ${m[1]} holds another slot; slots do not nest.`);
      names.add(m[1]);
    }
    slotNames.set(id, names);
  }

  // Every overlay rule that needs the packs, checked before any prompt is composed.
  const filledBy = new Map(); // `${role}\0${slot}` -> overlay name
  for (const o of overlays) {
    const label = `Overlay ${o.name}`;
    for (const name of o.packs) if (!packByName.has(name)) throw configError(`${label} applies to pack ${name}, which is not loaded.`);
    const targetIds = [...roleById.keys()].filter((id) => o.packs.includes(roleById.get(id).pack.name));
    const declared = new Set(o.packs.flatMap((n) => Object.keys(packByName.get(n).vars)));
    for (const k of Object.keys(o.vars)) if (!declared.has(k)) throw configError(`${label} sets variable ${k}, which none of its packs (${o.packs.join(", ")}) declares.`);
    for (const id of Object.keys(o.roles)) if (!targetIds.includes(id)) throw configError(`${label}: roles/${id}.md names a role its packs do not have.`);
    for (const id of Object.keys(o.roleSlots)) if (!targetIds.includes(id)) throw configError(`${label}: slots/${id}/ names a role its packs do not have.`);
    for (const slot of Object.keys(o.slots)) {
      if (!targetIds.some((id) => slotNames.get(id).has(slot))) throw configError(`${label}: slots/${slot}.md fills a slot no role of its packs has.`);
    }
    for (const [id, map] of Object.entries(o.roleSlots)) {
      for (const slot of Object.keys(map)) if (!slotNames.get(id).has(slot)) throw configError(`${label}: slots/${id}/${slot}.md fills a slot role ${id} does not have.`);
    }
    for (const id of targetIds) {
      for (const slot of slotNames.get(id)) {
        if (!(o.slots[slot] !== undefined || (o.roleSlots[id] && o.roleSlots[id][slot] !== undefined))) continue;
        const key = `${id}\0${slot}`;
        if (filledBy.has(key)) throw configError(`Overlays ${filledBy.get(key)} and ${o.name} both fill slot ${slot} of role ${id}; only one may.`);
        filledBy.set(key, o.name);
      }
    }
  }

  const out = new Map();
  for (const [id, { role, pack }] of roleById) {
    const applying = overlays.filter((o) => o.packs.includes(pack.name));
    let text = role.prompt.replace(SLOT_RE, (_m, slot, def) => {
      for (const o of applying) {
        const own = o.roleSlots[id] && o.roleSlots[id][slot];
        if (own !== undefined) return own.replace(/\s+$/, "");
        if (o.slots[slot] !== undefined) return o.slots[slot].replace(/\s+$/, "");
      }
      return def;
    });
    for (const o of applying) {
      for (const add of [o.all, o.roles[id]]) if (add) text = `${text.replace(/\s+$/, "")}\n\n${add.replace(/\s+$/, "")}\n`;
    }
    const values = { ...pack.vars };
    for (const o of applying) Object.assign(values, o.vars);
    text = text.replace(VAR_RE, (_m, name) => {
      if (!Object.hasOwn(values, name)) {
        throw configError(`Role ${id} uses {{vars.${name}}}, which pack ${pack.name} does not declare${applying.length ? " and no overlay sets" : ""}.`);
      }
      return values[name];
    });
    out.set(id, { prompt: text, overlays: applying.map((o) => ({ name: o.name, version: o.version, digest: o.digest })), renamedFrom: id === role.id ? null : role.id });
  }
  return out;
}
