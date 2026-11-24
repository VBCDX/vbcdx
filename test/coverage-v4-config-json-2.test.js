// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseStrictJson } from "../src/config/json.js";
import "./helpers/fixture-pack.js";

describe("src/config/json.js coverage, part 2", () => {
  // src/config/json.js 94
  test("consumes a leading minus sign before the integer digits", () => {
    assert.equal(parseStrictJson("42"), 42);
    assert.equal(parseStrictJson("-5"), -5);
    assert.equal(parseStrictJson("-42"), -42);
    assert.deepEqual(parseStrictJson('{"a": -7}'), { a: -7 });
  });

  // src/config/json.js 96
  test("consumes a fractional part after the dot", () => {
    assert.equal(parseStrictJson("1.5"), 1.5);
    assert.equal(parseStrictJson("-0.25"), -0.25);
    assert.equal(parseStrictJson("3.0"), 3);
    assert.deepEqual(parseStrictJson('{"ratio": -1.75}'), { ratio: -1.75 });
  });

  // src/config/json.js 97-101
  test("consumes an exponent, with an optional sign and digits", () => {
    assert.equal(parseStrictJson("1e3"), 1000);
    assert.equal(parseStrictJson("2E2"), 200);
    assert.equal(parseStrictJson("1e+2"), 100);
    assert.equal(parseStrictJson("1e-2"), 0.01);
    assert.equal(parseStrictJson("-1.5e-3"), -0.0015);
    assert.deepEqual(parseStrictJson("[1.5, -2e1]"), [1.5, -20]);
    assert.deepEqual(parseStrictJson('{"n": 1.25e2}'), { n: 125 });
  });

  // src/config/json.js 104
  test("rejects a numeric token whose value is not finite", () => {
    assert.throws(
      () => parseStrictJson("1e999", "test.json"),
      /Invalid JSON in test\.json: invalid number at offset 5\./,
    );
    assert.throws(
      () => parseStrictJson("-1e309", "test.json"),
      /Invalid JSON in test\.json: invalid number at offset 6\./,
    );
    assert.throws(
      () => parseStrictJson("1e", "test.json"),
      /Invalid JSON in test\.json: invalid number at offset 2\./,
    );
  });
});
