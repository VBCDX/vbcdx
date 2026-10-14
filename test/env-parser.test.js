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
