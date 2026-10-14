// Hermes profile config.yaml: merged, not owned.
//
// Hermes Web UI saves a profile setting by rewriting that profile's whole
// config.yaml (for example agent.reasoning_effort). When the installer owned the
// file by digest, its next run refused the profile as "modified outside the
// installer" and the only way on was --force, which dropped the setting.
//
// So the installer owns only the keys it renders — platform_toolsets,
// agent.disabled_toolsets, model, custom_providers, its own
// mcp_servers.<name> entries, terminal.env_passthrough and, for a web-search role,
// plugins.enabled and web.search_backend/extract_backend — replaces those, and keeps every other key.
// Ownership is checked on the values of those keys (a canonical digest), not on
// the file: a hand edit of an owned key still conflicts without --force, while
// a Web UI change to any other key, or a re-serialisation of the whole file,
// does not.
//
// The file is edited in place: only the owned keys are replaced, and every
// other node is written back as it was read, with the value and type PyYAML (which
// Hermes loads it with) gives it, and its comments. Values are read the way PyYAML
// reads them (src/fs/pyyaml.js); a file that cannot be read that way is refused.

import { readFileSync } from "node:fs";
import { isMap, isScalar, visit } from "yaml";
import { PYYAML, PyTimestamp, parsePy, parsePyDocument } from "./pyyaml.js";
import { sha256 } from "./safe-writer.js";

/** The paths the installer owns in a rendered config document. */
export function ownedPaths(rendered) {
  const paths = [];
  for (const k of ["platform_toolsets", "model", "custom_providers"]) {
    if (Object.hasOwn(rendered, k)) paths.push([k]);
  }
  if (isPlainObject(rendered.agent) && Object.hasOwn(rendered.agent, "disabled_toolsets")) {
    paths.push(["agent", "disabled_toolsets"]);
  }
  if (isPlainObject(rendered.mcp_servers)) {
    for (const name of Object.keys(rendered.mcp_servers)) paths.push(["mcp_servers", name]);
  }
  // Hermes git: only the passthrough list; other terminal.* settings stay the operator's.
  if (isPlainObject(rendered.terminal) && Object.hasOwn(rendered.terminal, "env_passthrough")) {
    paths.push(["terminal", "env_passthrough"]);
  }
  // Web search: the plugin list and the two backend keys; other web.* settings stay the operator's.
  if (isPlainObject(rendered.plugins) && Object.hasOwn(rendered.plugins, "enabled")) {
    paths.push(["plugins", "enabled"]);
  }
  if (isPlainObject(rendered.web)) {
    for (const k of ["search_backend", "extract_backend"]) {
      if (Object.hasOwn(rendered.web, k)) paths.push(["web", k]);
    }
  }
  return paths;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function lookup(doc, path) {
  let cur = doc;
  for (const key of path) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, key)) return { present: false };
    cur = cur[key];
  }
  return { present: true, value: cur };
}

// JSON with object keys sorted at every level, so key order (which a YAML
// re-serialisation may change) never changes the digest. Values JSON cannot tell
// apart get a tag no string, map or list can produce: an int beyond 2^53 is a
// BigInt (JSON.stringify throws on it), NaN and +-Infinity would all become null,
// and a timestamp keeps its source text.
function canonical(v) {
  if (typeof v === "bigint") return `#int:${v}`;
  if (typeof v === "number" && !Number.isFinite(v)) return `#float:${Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf"}`;
  if (v instanceof PyTimestamp) return `#ts:${JSON.stringify(v.source)}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** Digest of the values at `paths` in `doc` (absent paths count as absent). */
export function ownedDigest(doc, paths) {
  const entries = paths
    .map((p) => {
      const at = lookup(doc, p);
      return [p.join("\u0000"), at.present ? canonical(at.value) : "<absent>"];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(Buffer.from(canonical(entries)));
}

/**
 * The on-disk config text with the owned paths no longer rendered removed and the
 * rendered owned paths set, edited in place: an owned key that already exists keeps
 * its position, and every other node, and its comments, is kept as it was. Throws
 * when the text cannot be read the way PyYAML reads it.
 */
export function mergeConfig(existingText, rendered, previousPaths = []) {
  const doc = parsePyDocument(existingText);
  // A `<<` merge key supplies keys PyYAML merges in but this document does not hold:
  // setting one of them here would silently replace the whole merged value.
  visit(doc, { Pair(_, pair) { if (isScalar(pair.key) && typeof pair.key.value === "symbol") throw new Error("contains a << merge key"); } });
  if (doc.contents == null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new Error("is not a mapping");
  const current = ownedPaths(rendered);
  for (const p of previousPaths) {
    if (current.some((q) => canonical(q) === canonical(p))) continue; // set in place below
    const parent = p.length > 1 ? doc.getIn(p.slice(0, -1), true) : doc.contents;
    if (isMap(parent)) parent.delete(p[p.length - 1]);
  }
  for (const p of current) {
    let cur = doc.contents;
    for (const key of p.slice(0, -1)) {
      let next = cur.get(key, true);
      if (!isMap(next)) {
        next = doc.createNode({});
        cur.set(key, next);
      }
      cur = next;
    }
    cur.set(p[p.length - 1], doc.createNode(lookup(rendered, p).value));
  }
  // A container the installer emptied (agent, mcp_servers, terminal, plugins, web) is dropped.
  for (const k of ["agent", "mcp_servers", "terminal", "plugins", "web"]) {
    const node = doc.contents.get(k, true);
    if (isMap(node) && node.items.length === 0 && !Object.hasOwn(rendered, k)) doc.contents.delete(k);
  }
  return doc.toString(PYYAML); // throws on an alias into a value the edit replaced
}

function readDoc(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    // Only a missing file is absent. Anything else (EACCES, EISDIR, EIO) is a file
    // that exists but cannot be read: never classify it as an install.
    if (err && err.code === "ENOENT") return { exists: false };
    return { exists: true, raw: null, doc: null, why: `cannot be read (${err && err.code ? err.code : err})` };
  }
  let doc;
  try {
    doc = parsePy(raw);
  } catch (err) {
    return { exists: true, raw, doc: null, why: `cannot be read as Hermes reads it: ${err && err.message ? err.message : err}` };
  }
  return { exists: true, raw, doc: doc == null ? {} : doc };
}

// A conflict on a file the installer cannot edit in place: --force writes the render
// whole, so every key the installer does not own is lost.
const WHOLE_FILE = "--force replaces the whole file, dropping every key the installer does not own (such as Web UI settings)";

/**
 * Classify a Hermes config.yaml write against the file on disk and its manifest
 * entry. Read-only.
 *
 * @returns {{cls: "install"|"repair"|"noop"|"update"|"conflict", content: string,
 *   record: {owned_paths: string[][], owned_digest: string}, recordChanged: boolean,
 *   note?: string}} note: for a conflict, why, and what --force would do
 */
export function classifyHermesConfig(absPath, renderedContent, recordedEntry) {
  const rendered = parsePy(renderedContent) || {};
  const paths = ownedPaths(rendered);
  const record = { owned_paths: paths, owned_digest: ownedDigest(rendered, paths) };
  const onDisk = readDoc(absPath);
  const recordedPaths = Array.isArray(recordedEntry?.owned_paths) ? recordedEntry.owned_paths : null;
  const recordChanged = !recordedEntry || recordedEntry.owned_digest !== record.owned_digest ||
    canonical(recordedPaths) !== canonical(paths);

  if (!onDisk.exists) {
    return { cls: recordedEntry && recordedEntry.digest ? "repair" : "install", content: renderedContent, record, recordChanged: true };
  }
  // Unreadable, unparseable, or not a mapping: nothing to merge into, and not provably ours.
  if (!isPlainObject(onDisk.doc)) {
    return { cls: "conflict", content: renderedContent, record, recordChanged: true,
      note: `${onDisk.why || "is not a YAML mapping"}; ${WHOLE_FILE}` };
  }

  const previous = recordedPaths || [];
  const stale = previous.filter((p) => !paths.some((q) => canonical(q) === canonical(p)));
  const current = ownedDigest(onDisk.doc, paths) === record.owned_digest && stale.every((p) => !lookup(onDisk.doc, p).present);
  // A noop writes nothing, so it needs no merge.
  if (current) return { cls: "noop", content: onDisk.raw, record, recordChanged };
  let content;
  try {
    content = mergeConfig(onDisk.raw, rendered, previous);
  } catch (err) {
    // Not editable the way Hermes reads it (see mergeConfig): refuse, never guess.
    return { cls: "conflict", content: renderedContent, record, recordChanged: true,
      note: `cannot be edited in place (${err && err.message ? err.message : err}); ${WHOLE_FILE}` };
  }

  let owned;
  let note = "not recorded as written by the installer; --force replaces the owned keys and keeps the others";
  if (recordedPaths && recordedEntry.owned_digest) {
    owned = ownedDigest(onDisk.doc, recordedPaths) === recordedEntry.owned_digest;
    if (!owned) note = "a key the installer owns was edited; --force replaces the owned keys and keeps the others";
    // A path this run starts owning (e.g. a newly bound mcp_servers.<name>) that already
    // holds a different value was set by someone else: refuse, as for a foreign whole
    // file, instead of overwriting it as an update.
    const adopted = paths.filter((p) => !recordedPaths.some((q) => canonical(q) === canonical(p)));
    const taken = adopted.filter((p) => lookup(onDisk.doc, p).present && canonical(lookup(onDisk.doc, p).value) !== canonical(lookup(rendered, p).value));
    if (taken.length) {
      owned = false;
      note = `already set to a different value: ${taken.map((p) => p.join(".")).join(", ")}; --force replaces the owned keys and keeps the others`;
    }
  } else if (recordedEntry && recordedEntry.digest) {
    // A manifest entry from before key-level ownership records only the whole
    // file's digest: the file is ours only if it is byte-for-byte what we wrote.
    owned = sha256(Buffer.from(onDisk.raw)) === recordedEntry.digest;
  } else {
    owned = false;
  }
  return owned ? { cls: "update", content, record, recordChanged: true } : { cls: "conflict", content, record, recordChanged: true, note };
}
