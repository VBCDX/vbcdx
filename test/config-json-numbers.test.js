// The strict JSON parser accepts exactly the number grammar of RFC 8259 and nothing else.
//
// The scanner in src/config/json.js walks a token greedily, so on its own it also accepts a
// leading zero ("01"), a fraction with no digit ("1."), a fraction with no integer part
// ("-.5") and an exponent with no digit ("1e+"). Stock JSON.parse rejects all of those, and
// the parser exists to validate installer config the way JSON.parse would (minus duplicate
// keys). Each row below names the exact message and offset the parser must produce.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseStrictJson } from "../src/config/json.js";

describe("src/config/json.js strict number grammar", () => {
  test("rejects number tokens JSON does not allow, at the end of the token", () => {
    const rejected = [
      // [document, offset of the end of the number token]
      ["1.", 2],
      ["2.", 2],
      ["01", 2],
      ["00", 2],
      ["-01", 3],
      ["-00", 3],
      ["-.5", 3],
      ["1.e5", 4],
      ["0.e1", 4],
      ["1.e", 3],
      ["1e+", 3],
      ["[1.]", 3],
      ['{"a":01}', 7],
      // Still rejected by the finite check, which the grammar check must not replace.
      ["1e999", 5],
    ];
    for (const [text, offset] of rejected) {
      assert.throws(
        () => parseStrictJson(text, "test.json"),
        {
          name: "InstallerError",
          code: 2,
          message: `Invalid JSON in test.json: invalid number at offset ${offset}.`,
        },
        JSON.stringify(text),
      );
    }
  });

  test("accepts every number form JSON allows, including negative zero", () => {
    const accepted = [
      ["0", 0],
      ["10", 10],
      ["1.5", 1.5],
      ["-0.25", -0.25],
      ["1e5", 100000],
      ["1E+5", 100000],
      ["-12.5e-2", -0.125],
      ["0.0", 0],
      ["1234567890", 1234567890],
    ];
    for (const [text, value] of accepted) {
      assert.equal(parseStrictJson(text), value, text);
    }
    assert.ok(Object.is(parseStrictJson("-0"), -0), "-0 keeps its sign");
    assert.deepEqual(parseStrictJson('{"a": 1.5, "b": 0}'), { a: 1.5, b: 0 });
  });
});
