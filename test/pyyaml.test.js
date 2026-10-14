// Hermes (PyYAML) YAML semantics. The fixture is a config.yaml as Hermes
// Web UI saves it, with what PyYAML 6.0.3 reads from it (SafeLoader and libyaml's
// CSafeLoader agree): scripts/pyyaml-check/fixture.py. The full check against a live
// PyYAML is scripts/pyyaml-check/run.sh (needs python3 + PyYAML, not run in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq } from "yaml";
import { PyTimestamp, parsePy, parsePyDocument, stringifyPy } from "../src/fs/pyyaml.js";
import { mergeConfig } from "../src/fs/hermes-config.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const saved = readFileSync(join(FIX, "hermes-webui-save.yaml"), "utf8");
const expected = JSON.parse(readFileSync(join(FIX, "hermes-webui-save.json"), "utf8")).loaded;

// The fixture's typing, from the document nodes: a float read from a file keeps
// format FLOAT (so 1.0 stays a float), an int is a number or a bigint.
function typed(node) {
  if (isMap(node)) return Object.fromEntries(node.items.map((p) => [String(p.key.value), typed(p.value)]));
  if (isSeq(node)) return node.items.map(typed);
  if (node == null) return ["null"];
  assert.ok(isScalar(node), "only maps, sequences and scalars");
  const v = node.value;
  if (v === null) return ["null"];
  if (typeof v === "boolean") return ["bool", v];
  if (typeof v === "string") return ["str", v];
  if (typeof v === "bigint") return ["int", v.toString()];
  if (v instanceof PyTimestamp) return ["timestamp"];
  if (typeof v === "number" && node.format === "FLOAT") {
    return ["float", Number.isNaN(v) ? "nan" : v === Infinity ? "inf" : v === -Infinity ? "-inf" : v];
  }
  if (typeof v === "number") return ["int", String(v)];
  throw new Error(`unexpected scalar ${String(v)}`);
}
const typedText = (text) => typed(parsePyDocument(text).contents);

test("a Hermes Web UI save is read exactly as PyYAML reads it", () => {
  assert.deepEqual(typedText(saved), expected);
});

test("an in-place edit keeps every other key with PyYAML's value and type", () => {
  const rendered = { platform_toolsets: { cli: ["file"] }, agent: { disabled_toolsets: ["terminal"] }, model: { default: "new" } };
  const previous = [["platform_toolsets"], ["agent", "disabled_toolsets"], ["model"]];
  const merged = mergeConfig(saved, rendered, previous);
  const got = typedText(merged);
  const want = structuredClone(expected);
  want.platform_toolsets = { cli: [["str", "file"]] };
  want.agent.disabled_toolsets = [["str", "terminal"]];
  want.model = { default: ["str", "new"] };
  assert.deepEqual(got, want);
  // untouched scalars keep their source form
  assert.match(merged, /^ {2}temperature: 1\.0$/m);
  assert.match(merged, /^ {2}coding_context: 'off'$/m);
  assert.match(merged, /^ {2}theme: y$/m);
});

test("strings PyYAML reads as something else are quoted; its line breaks and non-printables are escaped", () => {
  const BS = String.fromCharCode(0x5c);
  const quoted = (t) => t.startsWith("- '") || t.startsWith('- "');
  const cases = [
    // [value, quoted?, escape the output must contain]
    ["=", true], // PyYAML resolves a bare = to !!value, which safe_load cannot construct
    ["on", true],
    ["tab\there", true], // PyYAML's plain scanner rejects a tab
    ["x" + String.fromCharCode(0x85) + "y", true, BS + "x85"], // YAML 1.1 line breaks
    ["a" + String.fromCharCode(0x2028) + "b", true, BS + "u2028"],
    [String.fromCharCode(0x7f), true, BS + "x7F"], // PyYAML's Reader rejects it raw
    [" \n", true, BS + "n"], // not a block scalar holding only spaces
    ["y", false], // strings in PyYAML, so they stay plain
    ["1e3", false], // (PyYAML's floats need a dot)
  ];
  for (const [value, mustQuote, escape] of cases) {
    const text = stringifyPy([value]);
    assert.equal(quoted(text), mustQuote, `${JSON.stringify(value)} -> ${text}`);
    if (escape) assert.ok(text.includes(escape), `${JSON.stringify(value)} -> ${text}`);
    for (const c of [0x85, 0x2028, 0x7f, 0x09]) assert.ok(!text.includes(String.fromCharCode(c)), `raw U+${c.toString(16)} in ${text}`);
    assert.deepEqual(parsePy(text), [value]);
  }
  // A quoted '<<' key is a string, not a merge key.
  assert.match(stringifyPy({ "<<": 1 }), /^["']<<["']: 1$/m);
  // 1e21 is a float to PyYAML (and "1e+21" would be a string); 1.5e-7 needs its dot.
  assert.equal(stringifyPy([1e21, 1.5e-7, 12, 0.5]), "- 1.0e+21\n- 1.5e-7\n- 12\n- 0.5\n");
});

test("a file PyYAML and the yaml package read differently is refused, not rewritten", () => {
  const rendered = { platform_toolsets: { cli: ["file"] } };
  // YAML 1.1 reads a raw LINE SEPARATOR as a line break, YAML 1.2 as text
  assert.throws(() => mergeConfig(`a: "x${String.fromCharCode(0x2028)}y"\n`, rendered), /U\+2028/);
  // a << merge key supplies keys this document does not hold
  assert.throws(() => mergeConfig("base: &b {agent: {reasoning_effort: high}}\n<<: *b\n", rendered), /merge key/);
  // an alias elsewhere into an owned value that the edit replaces would dangle
  assert.throws(() => mergeConfig("platform_toolsets: &t {cli: [file]}\nmirror: *t\n", rendered), /Unresolved alias/);
});

test("comments and untouched formatting survive an edit", () => {
  const text = "# operator notes\nagent:\n  reasoning_effort: high  # keep\n  disabled_toolsets: [x]\nmask: 0x1F\nnothing: ~\nflag: yes\n";
  const merged = mergeConfig(text, { agent: { disabled_toolsets: ["y"] } }, [["agent", "disabled_toolsets"]]);
  for (const s of ["# operator notes", "reasoning_effort: high # keep", "mask: 0x1F", "nothing: ~", "flag: yes"]) {
    assert.ok(merged.includes(s), `${s} in:\n${merged}`);
  }
  assert.deepEqual(parsePy(merged).agent, { reasoning_effort: "high", disabled_toolsets: ["y"] });
});
