// YAML as Hermes reads it: PyYAML safe_load.
//
// Hermes loads its config.yaml and profile.yaml with PyYAML, whose implicit
// resolvers are neither YAML 1.2 nor the `yaml` package's YAML 1.1 schema. In
// PyYAML `y`/`n` and `1e3` are strings, `=` is the unconstructable `!!value` tag
// (safe_load raises on it), and `1.0` is a float. Reading or writing a file
// Hermes parses with any other schema changes the operator's values, or leaves a
// file Hermes cannot load. So these files are parsed and written with a schema
// that copies PyYAML's resolvers (yaml/resolver.py, PyYAML 6.0.3) and
// constructors (yaml/constructor.py, SafeConstructor): a string that PyYAML
// would read as anything else is quoted, and a scalar keeps its source form
// when its value is unchanged.

import { Schema, parseDocument, stringify } from "yaml";

const BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const FLOAT = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const INT = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const NULL = /^(?:~|null|Null|NULL|)$/;
const TIMESTAMP = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;
const VALUE = /^=$/;

// SafeConstructor.construct_yaml_int
function pyInt(src) {
  let s = src.replace(/_/g, "");
  const sign = s[0] === "-" ? -1n : 1n;
  if ("+-".includes(s[0])) s = s.slice(1);
  let n;
  if (s === "0") n = 0n;
  else if (s.startsWith("0b")) n = BigInt("0b" + s.slice(2));
  else if (s.startsWith("0x")) n = BigInt("0x" + s.slice(2));
  else if (s[0] === "0") n = BigInt("0o" + s.slice(1));
  else if (s.includes(":")) n = s.split(":").reduce((acc, part) => acc * 60n + BigInt(part), 0n);
  else n = BigInt(s);
  n *= sign;
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

// SafeConstructor.construct_yaml_float
function pyFloat(src) {
  let s = src.replace(/_/g, "").toLowerCase();
  const sign = s[0] === "-" ? -1 : 1;
  if ("+-".includes(s[0])) s = s.slice(1);
  if (s === ".inf") return sign * Infinity;
  if (s === ".nan") return NaN;
  if (s.includes(":")) return sign * s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  return sign * Number(s);
}

// A float PyYAML reads back as a float: it needs a "." (and a signed exponent).
function formatFloat(v) {
  if (Number.isNaN(v)) return ".nan";
  if (v === Infinity) return ".inf";
  if (v === -Infinity) return "-.inf";
  const s = String(v);
  if (s.includes(".")) return s;
  return s.includes("e") ? s.replace("e", ".0e") : s + ".0";
}

const sameNumber = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
// A scalar whose value is unchanged is written as it was read (0x1F, 1_000, ~, yes).
const keepSource = (test, construct) => (item, fallback) =>
  typeof item.source === "string" && test.test(item.source) && sameNumber(construct(item.source), item.value)
    ? item.source
    : fallback;

/** A PyYAML timestamp (a date or datetime in Python), kept as its source text. */
export class PyTimestamp {
  constructor(source) { this.source = source; }
  toJSON() { return { timestamp: this.source }; }
}

// PyYAML's Reader refuses a raw character outside this set (yaml/reader.py
// NON_PRINTABLE), and reads a raw CR, NEL, LINE SEPARATOR or PARAGRAPH SEPARATOR as a
// line break. A string containing one is written double-quoted with that character
// escaped, which PyYAML reads back exactly. So is any multi-line string: the yaml
// package writes some as block scalars PyYAML reads differently (a line of only
// spaces: "|+" without an indentation indicator), and PyYAML's own safe_dump never
// writes block scalars either.
const pyPrintable = (c) => c === 0x09 || c === 0x0a || (c >= 0x20 && c <= 0x7e) ||
  (c >= 0xa0 && c <= 0xd7ff && c !== 0x2028 && c !== 0x2029) || (c >= 0xe000 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0x10ffff);
const BACKSLASH = String.fromCharCode(0x5c);
const hex = (c, n) => c.toString(16).toUpperCase().padStart(n, "0");

function escapedString(value) {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (ch === '"' || ch === BACKSLASH) out += BACKSLASH + ch;
    else if (c === 0x0a) out += BACKSLASH + "n";
    else if (c === 0x09) out += BACKSLASH + "t";
    else if (pyPrintable(c)) out += ch;
    else out += BACKSLASH + (c <= 0xff ? "x" + hex(c, 2) : c <= 0xffff ? "u" + hex(c, 4) : "U" + hex(c, 8));
  }
  return out + '"';
}

const STR = new Schema({ schema: "failsafe" }).tags.find((t) => t.tag === "tag:yaml.org,2002:str");
const str = {
  ...STR,
  stringify: (item, ctx, onComment, onChompKeep) =>
    String(item.value).includes("\n") || [...String(item.value)].some((ch) => !pyPrintable(ch.codePointAt(0)))
      ? escapedString(String(item.value))
      : STR.stringify(item, ctx, onComment, onChompKeep),
};

const MERGE = new Schema({ schema: "yaml-1.1" }).tags.find((t) => t.tag === "tag:yaml.org,2002:merge");

const tags = [
  {
    tag: "tag:yaml.org,2002:null", default: true, test: NULL,
    identify: (v) => v == null,
    resolve: () => null,
    stringify: (item) => (typeof item.source === "string" && NULL.test(item.source) ? item.source : "null"),
  },
  {
    tag: "tag:yaml.org,2002:bool", default: true, test: BOOL,
    identify: (v) => typeof v === "boolean",
    resolve: (s) => /^(?:yes|true|on)$/i.test(s),
    stringify: (item) => keepSource(BOOL, (s) => /^(?:yes|true|on)$/i.test(s))(item, item.value ? "true" : "false"),
  },
  {
    tag: "tag:yaml.org,2002:int", default: true, test: INT,
    // 1e21 is an integer to JS but a float to PyYAML, and String() writes it "1e+21",
    // which PyYAML reads as a string: only a safe integer is written as an int.
    identify: (v) => typeof v === "bigint" || Number.isSafeInteger(v),
    resolve: pyInt,
    stringify: (item) => keepSource(INT, pyInt)(item, String(item.value)),
  },
  // A float read from a file carries format "FLOAT", so 1.0 is written back as a
  // float, not as the int 1; a number created by the installer uses the second tag.
  ...["FLOAT", undefined].map((format) => ({
    tag: "tag:yaml.org,2002:float", default: true, test: FLOAT, format,
    identify: format ? (v) => typeof v === "number" : (v) => typeof v === "number" && !Number.isSafeInteger(v),
    resolve: pyFloat,
    stringify: (item) => keepSource(FLOAT, pyFloat)(item, formatFloat(item.value)),
  })),
  {
    tag: "tag:yaml.org,2002:timestamp", default: true, test: TIMESTAMP,
    identify: (v) => v instanceof PyTimestamp,
    resolve: (s) => new PyTimestamp(s),
    stringify: (item) => item.value.source,
  },
  // PyYAML resolves a plain `=` to !!value, which safe_load cannot construct: a
  // string "=" must be quoted. Parsed, it stays the string (the file was not
  // loadable by Hermes anyway).
  {
    tag: "tag:yaml.org,2002:value", default: true, test: VALUE,
    identify: () => false,
    resolve: (s) => s,
  },
  // PyYAML's plain-scalar scanner stops at a tab ("cannot start any token"), so a
  // string with a tab is always quoted. PyYAML never writes such a plain scalar, so
  // this tag never resolves anything a file from Hermes contains.
  {
    tag: "tag:vbcdx.dev-agents,2026:pyyaml-tab", default: true, test: /\t/, // never emitted
    identify: () => false,
    resolve: (s) => s,
  },
  // `<<` merge keys, which PyYAML's SafeLoader also applies. The yaml package's merge
  // tag also claims the *string* "<<", so a quoted '<<' key would be written bare
  // and become a merge key; here only a parsed merge key (a Symbol) is one.
  { ...MERGE, identify: (v) => typeof v === "symbol" && v.description === "<<" },
];

/** Options for every read and write of a file Hermes parses. */
export const PYYAML = Object.freeze({
  schema: "failsafe",
  customTags: (base) => [...base.map((t) => (t.tag === STR.tag ? str : t)), ...tags],
  lineWidth: 0, // never fold a long scalar across lines
});

// YAML 1.1 (PyYAML) reads a raw NEL, LINE SEPARATOR or PARAGRAPH SEPARATOR as a line
// break; the yaml package (YAML 1.2) reads it as text. Measured on 14,196 PyYAML dumps
// (scripts/pyyaml-check): the yaml package read 503 differently and failed on 10, every
// one of them with a raw NEL or LS, and none without. So such a file is refused rather
// than guessed at.
const YAML11_BREAK = new RegExp("[" + String.fromCharCode(0x85, 0x2028, 0x2029) + "]");

/** A yaml Document (for editing in place); throws on any parse error. */
export function parsePyDocument(text) {
  if (YAML11_BREAK.test(text)) {
    throw new Error("contains a raw U+0085, U+2028 or U+2029, which PyYAML reads as a line break");
  }
  const doc = parseDocument(text, PYYAML);
  if (doc.errors.length) throw doc.errors[0];
  return doc;
}

export const parsePy = (text) => parsePyDocument(text).toJS();

export const stringifyPy = (value) => stringify(value, PYYAML);
