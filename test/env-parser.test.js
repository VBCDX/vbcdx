import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvText } from "../src/config/env-parser.js";

test("blank lines and comments are ignored", () => {
  const m = parseEnvText("\n  \n# a comment\n   # indented comment\nVBCDX_AGENTS_BASE_DIR=/x\n");
  assert.equal(m.size, 1);
  assert.equal(m.get("VBCDX_AGENTS_BASE_DIR"), "/x");
});

test("splits at the first equals and trims key/value", () => {
  const m = parseEnvText("  KEY  =  a=b=c  \n");
  assert.equal(m.get("KEY"), "a=b=c");
});

test("unquoted interior spaces, hash, equals, and dollars are literal", () => {
  const m = parseEnvText("K=a b # c = $HOME\n");
  assert.equal(m.get("K"), "a b # c = $HOME");
});

test("leading hash after equals is a literal value, not a comment", () => {
  const m = parseEnvText("K=#notacomment\n");
  assert.equal(m.get("K"), "#notacomment");
});

test("single-quoted values are literal", () => {
  const m = parseEnvText("K='  $x \\n literal  '\n");
  assert.equal(m.get("K"), "  $x \\n literal  ");
});

test("double-quoted values use JSON escaping", () => {
  const m = parseEnvText('K="a\\tb\\"c"\n');
  assert.equal(m.get("K"), 'a\tb"c');
});

test("a double-quoted numeric value decodes to the string, never a number", () => {
  // The double-quoted grammar is JSON string escaping, so "123" is the string "123". A decode
  // that turned a numeric-looking quoted value into a number would break every consumer that
  // expects a string, and would only fail later, at env-parser.js:116 (`value.includes`), as a
  // TypeError instead of a configuration error.
  const m = parseEnvText('FOO="123"\nBAR="1e3"\n');
  assert.equal(typeof m.get("FOO"), "string");
  assert.equal(m.get("FOO"), "123");
  assert.equal(m.get("BAR"), "1e3");
});

test("a decode that yields a non-string is refused as a malformed value", (t) => {
  // env-parser.js:45-47 guards decodeDoubleQuoted's return. With the shipped decode it cannot
  // fire: `raw` starts with `"` (line 110), so JSON.parse either returns a string or throws.
  // It stays because a decode change (a lenient parse, a JSON reviver, a switch off JSON.parse)
  // can make it live, and without it a number would reach line 116 and throw a TypeError.
  // Hold the parse for one call so the decode returns a number and assert the guard's own error.
  t.mock.method(JSON, "parse", () => 123);
  try {
    try {
      parseEnvText('FOO="123"\n');
      assert.fail("a non-string decode must be refused");
    } catch (err) {
      assert.equal(err.name, "InstallerError", `expected a configuration error, got ${err.name}: ${err.message}`);
      assert.equal(err.code, 2);
      assert.match(err.message, /Malformed value for FOO at line 1: expected a quoted string\./);
      assert.doesNotMatch(err.message, /123/, "the error never carries the value");
    }
  } finally {
    t.mock.restoreAll();
  }
});

test("rejects decoded line breaks in a double-quoted value", () => {
  assert.throws(() => parseEnvText('K="a\\nb"\n'), /line break/);
});

test("rejects trailing data after a quoted value", () => {
  assert.throws(() => parseEnvText('K="a"b\n'), /Malformed double-quoted/);
});

test("rejects an unterminated single quote", () => {
  assert.throws(() => parseEnvText("K='abc\n"), /Unterminated single-quoted/);
});

test("rejects case-equivalent duplicate keys", () => {
  assert.throws(() => parseEnvText("FOO=1\nfoo=2\n"), /Duplicate configuration key/);
});

test("rejects duplicate identical keys", () => {
  assert.throws(() => parseEnvText("FOO=1\nFOO=2\n"), /Duplicate configuration key/);
});

test("rejects a NUL byte", () => {
  assert.throws(() => parseEnvText("K=a\0b\n"), /NUL byte/);
});

test("rejects an invalid key", () => {
  assert.throws(() => parseEnvText("1BAD=x\n"), /Invalid configuration key/);
});

test("rejects a line with no equals", () => {
  assert.throws(() => parseEnvText("NOEQUALS\n"), /expected KEY=VALUE/);
});

test("does not expand ambient variables or tildes", () => {
  const m = parseEnvText("K=$HOME/~/x\n");
  assert.equal(m.get("K"), "$HOME/~/x");
});

test("error messages never include the value", () => {
  try {
    parseEnvText('SECRET="unterminated\n');
    assert.fail("should throw");
  } catch (err) {
    assert.match(err.message, /SECRET/);
    assert.doesNotMatch(err.message, /unterminated/);
  }
});
