// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseStrictJson } from "../src/config/json.js";
import "./helpers/fixture-pack.js";

describe("src/config/json.js coverage, part 1", () => {
  test("reports an unexpected end of input", () => {
    // src/config/json.js 27:17-27:49
    assert.throws(
      () => parseStrictJson(""),
      /Invalid JSON in <json>: unexpected end of input at offset 0\.$/,
    );
    assert.throws(
      () => parseStrictJson('{"a":', "binding.json"),
      /Invalid JSON in binding\.json: unexpected end of input at offset 5\.$/,
    );
  });

  test("reports an unexpected character", () => {
    // src/config/json.js 35:61-37:3
    assert.throws(
      () => parseStrictJson("@"),
      /Invalid JSON in <json>: unexpected character "@" at offset 0\.$/,
    );
    assert.throws(
      () => parseStrictJson("  x"),
      /Invalid JSON in <json>: unexpected character "x" at offset 2\.$/,
    );
    assert.throws(
      () => parseStrictJson("}"),
      /Invalid JSON in <json>: unexpected character "}" at offset 0\.$/,
    );
  });

  test("requires a colon after an object key", () => {
    // src/config/json.js 51:28-51:49
    assert.throws(
      () => parseStrictJson('{"a" 1}'),
      /Invalid JSON in <json>: expected ':' at offset 5\.$/,
    );
    assert.throws(
      () => parseStrictJson('{"a",}'),
      /Invalid JSON in <json>: expected ':' at offset 4\.$/,
    );
  });

  test("requires a comma or closing brace after an object member", () => {
    // src/config/json.js 56:48-58:6
    assert.throws(
      () => parseStrictJson('{"a":1 ]'),
      /Invalid JSON in <json>: expected ',' or '}' at offset 7\.$/,
    );
    assert.throws(
      () => parseStrictJson('{"a":1 "b":2}'),
      /Invalid JSON in <json>: expected ',' or '}' at offset 7\.$/,
    );
  });

  test("requires a comma or closing bracket after an array element", () => {
    // src/config/json.js 69:48-71:6
    assert.throws(
      () => parseStrictJson("[1 2]"),
      /Invalid JSON in <json>: expected ',' or ']' at offset 3\.$/,
    );
    assert.throws(
      () => parseStrictJson("[true false]"),
      /Invalid JSON in <json>: expected ',' or ']' at offset 6\.$/,
    );
  });

  test("reports a newline or carriage return inside a string", () => {
    // src/config/json.js 81:37-81:65
    assert.throws(
      () => parseStrictJson('"ab\ncd"'),
      /Invalid JSON in <json>: unterminated string at offset 3\.$/,
    );
    assert.throws(
      () => parseStrictJson('"a\rb"'),
      /Invalid JSON in <json>: unterminated string at offset 2\.$/,
    );
  });

  test("reports a string ending in an unpaired backslash", () => {
    // src/config/json.js 84:16-84:44
    assert.throws(
      () => parseStrictJson('"abc\\'),
      /Invalid JSON in <json>: unterminated string at offset 6\.$/,
    );
  });

  test("reports a malformed string token", () => {
    // src/config/json.js 88:7-90:6
    assert.throws(
      () => parseStrictJson('"a\\q"'),
      /Invalid JSON in <json>: malformed string at offset 5\.$/,
    );
    assert.throws(
      () => parseStrictJson('"'),
      /Invalid JSON in <json>: malformed string at offset 1\.$/,
    );
    assert.throws(
      () => parseStrictJson('"abc'),
      /Invalid JSON in <json>: malformed string at offset 4\.$/,
    );
  });
});
