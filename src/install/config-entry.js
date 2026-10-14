// One owned entry in a harness configuration file.
//
// `vbcdx install tool` registers an MCP server by writing ONE keyed entry into a
// file the harness and the user also edit: Claude's .mcp.json / .claude.json,
// Codex's config.toml, OpenCode's opencode.json, Hermes' config.yaml. The
// installer owns that entry only. It is recorded in the manifest by the digest of
// its value, so a re-run is a no-op, a hand edit of the entry is a conflict
// without --force, and removal deletes the entry only when it is still what was
// written. Every other key in the file is kept: a JSON file is re-serialised with
// its key order, a YAML file is edited in place with its comments (as for the
// Hermes profile config, src/fs/hermes-config.js), and a TOML file is edited as
// text, replacing or appending only the entry's own table so comments elsewhere
// survive. Every edit is re-parsed and checked to have changed nothing but the
// entry before it is written; anything that cannot be edited that way is refused.

import { readFileSync } from "node:fs";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { isMap, isScalar, visit } from "yaml";
import { parsePy, parsePyDocument, PYYAML } from "../fs/pyyaml.js";
import { sha256 } from "../fs/safe-writer.js";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

// JSON with keys sorted at every level, so key order never changes a digest.
export function canonical(v) {
  if (typeof v === "bigint") return `#int:${v}`;
  if (v instanceof Date) return `#date:${v.toISOString()}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export const entryDigest = (value) => sha256(Buffer.from(canonical(value)));

function lookup(doc, path) {
  let cur = doc;
  for (const key of path) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, key)) return { present: false };
    cur = cur[key];
  }
  return { present: true, value: cur };
}

/** A deep copy of `doc` without the entry at `path`, dropping containers left empty. */
function without(doc, path) {
  const copy = structuredClone(doc);
  const parents = [copy];
  let cur = copy;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(cur[key])) return copy;
    cur = cur[key];
    parents.push(cur);
  }
  delete cur[path[path.length - 1]];
  for (let i = path.length - 2; i >= 0; i--) {
    const child = parents[i + 1];
    if (Object.keys(child).length) break;
    delete parents[i][path[i]];
  }
  return copy;
}

// ── formats ─────────────────────────────────────────────────────────────────
// parse(text) -> plain object; set(text|null, path, value) -> new text;
// remove(text, path) -> new text.

const json = {
  parse(text) {
    const v = text.trim() === "" ? {} : JSON.parse(text);
    if (!isPlainObject(v)) throw new Error("is not a JSON object");
    return v;
  },
  set(text, path, value) {
    const doc = text === null ? {} : json.parse(text);
    let cur = doc;
    for (const key of path.slice(0, -1)) {
      if (cur[key] === undefined) cur[key] = {};
      if (!isPlainObject(cur[key])) throw new Error(`${key} is not an object`);
      cur = cur[key];
    }
    cur[path[path.length - 1]] = value;
    return JSON.stringify(doc, null, 2) + "\n";
  },
  remove(text, path) {
    return JSON.stringify(without(json.parse(text), path), null, 2) + "\n";
  },
};

const yaml = {
  parse(text) {
    const v = parsePy(text);
    if (v == null) return {};
    if (!isPlainObject(v)) throw new Error("is not a YAML mapping");
    return v;
  },
  doc(text) {
    const doc = parsePyDocument(text ?? "");
    // A `<<` merge key supplies keys this document does not hold; editing next to one
    // could silently replace a merged value (as in src/fs/hermes-config.js).
    visit(doc, { Pair(_, pair) { if (isScalar(pair.key) && typeof pair.key.value === "symbol") throw new Error("contains a << merge key"); } });
    if (doc.contents == null) doc.contents = doc.createNode({});
    if (!isMap(doc.contents)) throw new Error("is not a YAML mapping");
    return doc;
  },
  set(text, path, value) {
    const doc = yaml.doc(text);
    let cur = doc.contents;
    for (const key of path.slice(0, -1)) {
      let next = cur.get(key, true);
      if (next == null) {
        next = doc.createNode({});
        cur.set(key, next);
      }
      if (!isMap(next)) throw new Error(`${key} is not a mapping`);
      cur = next;
    }
    cur.set(path[path.length - 1], doc.createNode(value));
    return doc.toString(PYYAML);
  },
  remove(text, path) {
    const doc = yaml.doc(text);
    const parents = [doc.contents];
    for (const key of path.slice(0, -1)) {
      const next = parents[parents.length - 1].get(key, true);
      if (!isMap(next)) return doc.toString(PYYAML);
      parents.push(next);
    }
    parents[parents.length - 1].delete(path[path.length - 1]);
    for (let i = parents.length - 1; i > 0; i--) {
      if (parents[i].items.length) break;
      parents[i - 1].delete(path[i - 1]);
    }
    return doc.toString(PYYAML);
  },
};

// TOML: the entry is the table [a.b] (with no sub-tables). It is located by its
// header line and replaced or appended as text; a table defined any other way
// (dotted keys, an inline table) is refused by the round-trip check.
const TOML_HEADER_RE = /^\s*\[/; // a [table] or an [[array of tables]] ends the block

function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function tomlBlockRange(lines, path) {
  const header = `[${path.map(tomlKey).join(".")}]`;
  const start = lines.findIndex((l) => l.replace(/#.*$/, "").trim() === header);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !TOML_HEADER_RE.test(lines[end])) end++;
  // Keep trailing blank lines and comments with what follows.
  while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
  return { start, end };
}

function tomlRender(path, value) {
  let doc = value;
  for (let i = path.length - 1; i >= 0; i--) doc = { [path[i]]: doc };
  const text = tomlStringify(doc);
  // smol-toml emits the intermediate header too when the leaf is a table; keep the leaf's.
  const lines = text.split("\n");
  const range = tomlBlockRange(lines, path);
  if (!range) throw new Error("rendered TOML has no table header for the entry");
  return lines.slice(range.start, range.end).join("\n");
}

const toml = {
  parse(text) {
    return tomlParse(text);
  },
  set(text, path, value) {
    const block = tomlRender(path, value);
    if (text === null || text.trim() === "") return block + "\n";
    const lines = text.split("\n");
    const range = tomlBlockRange(lines, path);
    if (range) {
      lines.splice(range.start, range.end - range.start, ...block.split("\n"));
      return lines.join("\n");
    }
    return text.replace(/\n*$/, "\n\n") + block + "\n";
  },
  remove(text, path) {
    const lines = text.split("\n");
    const range = tomlBlockRange(lines, path);
    if (!range) return text;
    let { start, end } = range;
    while (end < lines.length && lines[end].trim() === "") end++; // its trailing blank lines
    lines.splice(start, end - start);
    return lines.join("\n");
  },
};

export const FORMATS = Object.freeze({ json, yaml, toml });

// ── read / plan ──────────────────────────────────────────────────────────────

/** Read a config file: {exists, text, doc} or {exists, why} when it cannot be read as its format. */
export function readConfig(absPath, format) {
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { exists: false, text: null, doc: {} };
    return { exists: true, text: null, doc: null, why: `cannot be read (${err && err.code ? err.code : err})` };
  }
  try {
    return { exists: true, text, doc: FORMATS[format].parse(text) };
  } catch (err) {
    return { exists: true, text, doc: null, why: `cannot be read as ${format}: ${err && err.message ? err.message : err}` };
  }
}

/** Apply `edit` and prove it changed nothing but the entry at `path`. */
export function checkedEdit(format, onDisk, path, edit, expectPresent, expectValue) {
  const fmt = FORMATS[format];
  const next = edit();
  const after = fmt.parse(next);
  const at = lookup(after, path);
  if (expectPresent && (!at.present || canonical(at.value) !== canonical(expectValue))) {
    throw new Error("the edited file does not hold the entry as rendered");
  }
  if (!expectPresent && at.present) throw new Error("the entry is still present after removal");
  if (canonical(without(after, path)) !== canonical(without(onDisk.doc, path))) {
    throw new Error("the edit would change keys outside the entry");
  }
  return next;
}

/**
 * Classify writing `value` at `path` in a config file. Read-only.
 * @param {object|null} recorded the manifest record for this entry, if any
 * @returns {{cls: "install"|"repair"|"noop"|"update"|"conflict", content: string|null,
 *   createsFile: boolean, digest: string, note?: string}}
 */
export function planEntryWrite({ absPath, format, path, value, recorded }) {
  const digest = entryDigest(value);
  const onDisk = readConfig(absPath, format);
  const fmt = FORMATS[format];
  if (!onDisk.exists) {
    return { cls: recorded ? "repair" : "install", content: fmt.set(null, path, value), createsFile: true, digest };
  }
  if (onDisk.doc === null) {
    return { cls: "conflict", content: null, createsFile: false, digest, note: `${onDisk.why}; it is never rewritten whole, so fix or move it first` };
  }
  let content;
  try {
    content = checkedEdit(format, onDisk, path, () => fmt.set(onDisk.text, path, value), true, value);
  } catch (err) {
    return { cls: "conflict", content: null, createsFile: false, digest, note: `cannot be edited in place (${err.message}); it is never rewritten whole` };
  }
  const at = lookup(onDisk.doc, path);
  if (!at.present) return { cls: recorded ? "repair" : "install", content, createsFile: false, digest };
  const current = entryDigest(at.value);
  if (current === digest) return { cls: "noop", content: onDisk.text, createsFile: false, digest };
  if (recorded && current === recorded.digest) return { cls: "update", content, createsFile: false, digest };
  return {
    cls: "conflict", content, createsFile: false, digest,
    note: recorded ? "the entry was edited since the installer wrote it; --force replaces the entry and keeps the rest of the file"
      : "an entry with this name already exists and was not written by the installer; --force replaces the entry and keeps the rest of the file",
  };
}

/**
 * Classify removing the recorded entry. Read-only.
 * @returns {{cls: "remove"|"delete-file"|"absent"|"conflict", content: string|null, note?: string}}
 *   delete-file: the installer created the file and nothing else is left in it
 */
export function planEntryRemove({ absPath, format, path, recorded }) {
  const onDisk = readConfig(absPath, format);
  if (!onDisk.exists) return { cls: "absent", content: null };
  if (onDisk.doc === null) return { cls: "conflict", content: null, note: `${onDisk.why}; left untouched` };
  const at = lookup(onDisk.doc, path);
  if (!at.present) return { cls: "absent", content: null };
  const edited = entryDigest(at.value) !== recorded.digest;
  let content;
  try {
    content = checkedEdit(format, onDisk, path, () => FORMATS[format].remove(onDisk.text, path), false);
  } catch (err) {
    return { cls: "conflict", content: null, note: `cannot be edited in place (${err.message}); left untouched` };
  }
  const empty = Object.keys(FORMATS[format].parse(content)).length === 0;
  const cls = recorded.created_file && empty ? "delete-file" : "remove";
  if (edited) return { cls: "conflict", content, removeAs: cls, note: "the entry was edited since the installer wrote it; --force removes it anyway" };
  return { cls, content };
}
