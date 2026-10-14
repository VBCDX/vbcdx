// The role catalogue: the roles and skills of the agent packs a run has loaded.
//
// A run (the CLI, the A2A server, a programmatic init) loads its packs once, builds a
// catalogue and makes it the active one; everything that asks "is this a role?" or
// "render this role" reads the active catalogue (src/roles/index.js). Role ids and
// skill files must be unique across the packs loaded together: a clash is an error
// naming both packs, never a silent shadow.
//
// Which packs: the ones named with --pack (an npm name or a path, repeatable), else
// every installed package that ships vbcdx-pack.json, found where tool packages are
// found (src/install/locate.js).

import { configError } from "../errors.js";
import { findPackagesWith, locatePackageDir, isLocalPath } from "../install/locate.js";
import { lockedSource } from "../sources/lock.js";
import { buildSkillCatalogue } from "../skills/catalogue.js";
import { PACK_DECLARATION_FILE, readPack } from "./load.js";
import { composeRoles, overlayShipsPack, readOverlay } from "../overlays/overlay.js";
import { idToSuffix } from "../roles/registry.js";

/**
 * Build a catalogue from read packs (in the order given). Each role's prompt is composed
 * with the overlays given: its slots filled, the overlays' rules appended
 * and its variables expanded. With no overlay a prompt that uses no slot or variable is
 * unchanged.
 */
export function buildCatalog(packs, { overlays = [] } = {}) {
  const roles = new Map();
  const names = new Map();
  for (const pack of packs) {
    if (names.has(pack.name)) {
      throw configError(`Two agent packs are named ${pack.name}: ${names.get(pack.name)} and ${pack.dir}. Load only one of them.`);
    }
    names.set(pack.name, pack.dir);
    for (const role of pack.roles) {
      const other = roles.get(role.id);
      if (other) throw configError(`Role ${role.id} is in two agent packs, ${other.pack} and ${pack.name}. Load only one of them.`);
      roles.set(role.id, role);
    }
  }
  // Composed roles, keyed by the id each installs under: a role an overlay renames
  // takes its local id, in descriptor and credential suffix too.
  const composed = new Map();
  for (const [id, c] of composeRoles(packs, overlays)) {
    const base = roles.get(c.renamedFrom || id);
    const descriptor = c.renamedFrom ? Object.freeze({ ...base.descriptor, id, credential_suffix: idToSuffix(id) }) : base.descriptor;
    composed.set(id, Object.freeze({ ...base, id, descriptor, prompt: c.prompt, overlays: Object.freeze(c.overlays), renamedFrom: c.renamedFrom }));
  }
  roles.clear();
  for (const [id, r] of composed) roles.set(id, r);
  return Object.freeze({
    packs: Object.freeze([...packs]),
    overlays: Object.freeze(overlays.map((o) => Object.freeze({ name: o.name, version: o.version, digest: o.digest, dir: o.dir }))),
    ids: Object.freeze([...roles.keys()]),
    roles,
    skills: buildSkillCatalogue(packs),
  });
}

/**
 * Resolve and read packs. `specs` are --pack values (npm names or paths); with none,
 * every installed agent pack is discovered. Finding no pack is an error that says
 * how to get one, unless `allowEmpty`.
 */
export function loadCatalog(specs = [], { cwd = process.cwd(), home, packageRoot, npmGlobalRoot, allowEmpty = false, lock = null, overlays: overlaySpecs = [] } = {}) {
  // Overlays are read first: one that also ships a pack (roles of its own) adds that pack
  // to whatever else is loaded, by --pack, by the lock or by discovery. With a lock, an
  // overlay that is not a path names a lock source whose payload is vbcdx-overlay.json.
  const overlays = overlaySpecs.map((spec) =>
    readOverlay(lock && !isLocalPath(spec) ? lockedSource(lock, spec, "overlay", "overlay").absDir : spec));
  let located;
  if (lock) {
    // With a lock, packs come from it alone. A --pack names a lock source
    // (or a local path, which is never fetched); with none, every agent pack in the lock.
    located = specs.length
      ? specs.map((spec) => (isLocalPath(spec)
        ? { spec, dir: locatePackageDir(spec, { cwd, home, what: "agent pack" }) }
        : { spec: undefined, dir: lockedSource(lock, spec, "agents", "agent pack").absDir }))
      : lock.sources.filter((s) => s.kinds.includes("agents")).map((s) => ({ spec: undefined, dir: s.absDir }));
  } else if (specs.length) {
    located = specs.map((spec) => ({ spec, dir: locatePackageDir(spec, { cwd, home, packageRoot, npmGlobalRoot, what: "agent pack" }) }));
  } else {
    located = findPackagesWith(PACK_DECLARATION_FILE, { cwd, packageRoot, npmGlobalRoot }).map(({ name, dir }) => ({ spec: name, dir }));
  }
  for (const o of overlays) if (overlayShipsPack(o)) located.push({ spec: undefined, dir: o.dir });
  const seen = new Set();
  const packs = [];
  for (const { spec, dir } of located) {
    if (seen.has(dir)) continue; // the same pack named twice (by name and by path)
    seen.add(dir);
    packs.push(readPack(dir, { spec }));
  }
  if (!packs.length && !allowEmpty) {
    const lines = [
      "No agent pack found. Install one next to vbcdx, or name it with --pack:",
      "  npm install -g <agent-pack>",
      "  vbcdx install agent <id> --harness=<h> --pack=<agent-pack|path>",
    ];
    throw configError(lines.join("\n"), { lines });
  }
  return buildCatalog(packs, { overlays });
}

let active = null;

/** Make `catalog` the one every role lookup reads. Returns the previous one. */
export function setActiveCatalog(catalog) {
  const previous = active;
  active = catalog;
  return previous;
}

/** The active catalogue; fails closed when no pack has been loaded. */
export function activeCatalog() {
  if (!active) throw configError("No agent pack is loaded: load one with --pack=<agent-pack|path> (or install one next to vbcdx).");
  return active;
}

export function hasActiveCatalog() {
  return active !== null;
}
