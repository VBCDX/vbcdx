// Installer coverage, second batch, group 1: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseEnvText, parseEnvFile } from "../src/config/env-parser.js";
import { tempDir } from "./helpers/temp-dir.js";

describe("src/config/env-parser.js coverage, part 1", () => {
  test("rejects a single-quoted value that contains a single quote", () => {
    // src/config/env-parser.js 56
    assert.throws(
      () => parseEnvText("NAME='a'b'"),
      { message: "Malformed single-quoted value for NAME at line 1: single quotes cannot contain a quote." },
    );
  });

  test("rejects configuration content that is not text", () => {
    // src/config/env-parser.js 72
    for (const bad of [null, undefined, 42, true, {}, ["NAME=value"]]) {
      assert.throws(
        () => parseEnvText(bad),
        { message: "Configuration content must be text." },
      );
    }
  });

  test("treats an empty or whitespace-only value as the empty string", () => {
    // src/config/env-parser.js 106
    const parsed = parseEnvText("EMPTY=\nSPACES=   \nTAB=\t\n");
    assert.equal(parsed.size, 3);
    assert.equal(parsed.get("EMPTY"), "");
    assert.equal(parsed.get("SPACES"), "");
    assert.equal(parsed.get("TAB"), "");
  });

  test("rejects a NUL byte that an escape decodes into a value", () => {
    // src/config/env-parser.js 116
    const text = 'NAME="\\u0000"';
    assert.equal(text.includes("\0"), false);
    assert.throws(
      () => parseEnvText(text),
      { message: "Value for NAME at line 1 contains a NUL byte." },
    );
  });

  test("parseEnvFile reports the read failure and falls back when the error has no code", () => {
    // src/config/env-parser.js 135
    const missing = join(tempDir("vbcdx-cov-env-"), "absent.env");
    assert.throws(
      () => parseEnvFile(missing),
      { message: `Cannot read configuration file: ${missing} (ENOENT).` },
    );

    const unreadable = join(tempDir("vbcdx-cov-env-"), "unreadable.env");
    const failingRead = () => {
      throw new Error("boom");
    };
    assert.throws(
      () => parseEnvFile(unreadable, failingRead),
      { message: `Cannot read configuration file: ${unreadable} (read error).` },
    );
  });
});
