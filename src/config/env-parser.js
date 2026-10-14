// Literal configuration-file parser (spec section 4).
//
// This grammar is deliberately NOT a shell. The file is never sourced,
// executed, interpolated, or tilde-expanded, and ambient environment
// variables are never used as defaults. One grammar, defined and tested here:
//
//   * Blank lines and lines whose first non-whitespace character is `#` are
//     ignored.
//   * An assignment is split at the FIRST `=`. Whitespace around the key and
//     the value is trimmed.
//   * Unquoted values keep interior spaces, `#`, `=`, and `$` literally; there
//     is no inline comment and no variable expansion.
//   * A single-quoted value is literal end to end and contains no `'`.
//   * A double-quoted value uses JSON string escaping.
//   * Rejected: malformed quotes, trailing data after a quoted value,
//     duplicate keys (including case-equivalent duplicates), NUL bytes, and
//     decoded line breaks inside a value.
//
// Errors identify the key and 1-based line number, never the value, so a
// secret can never reach a log. Key identity/validation against the supported
// set lives in config.js; this module is pure grammar.

import { readFileSync } from "node:fs";
import { configError } from "../errors.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Decode a double-quoted value using JSON string escaping. `raw` must start
 * with `"`. Returns the decoded string; throws configError on malformed input
 * or trailing data.
 */
function decodeDoubleQuoted(raw, key, lineNo) {
  // JSON.parse enforces exactly the escaping grammar we want and rejects a
  // dangling quote or a bad escape. Trailing data after the closing quote is
  // rejected because the whole trimmed token is handed to JSON.parse.
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw configError(
      `Malformed double-quoted value for ${key} at line ${lineNo}: not a valid quoted string.`,
    );
  }
  if (typeof value !== "string") {
    throw configError(`Malformed value for ${key} at line ${lineNo}: expected a quoted string.`);
  }
  return value;
}

function decodeSingleQuoted(raw, key, lineNo) {
  if (raw.length < 2 || raw[raw.length - 1] !== "'") {
    throw configError(`Unterminated single-quoted value for ${key} at line ${lineNo}.`);
  }
  const inner = raw.slice(1, -1);
  if (inner.includes("'")) {
    throw configError(
      `Malformed single-quoted value for ${key} at line ${lineNo}: single quotes cannot contain a quote.`,
    );
  }
  return inner;
}

/**
 * Parse literal configuration text.
 *
 * @param {string} text
 * @param {string} [source] path used only in error messages
 * @returns {Map<string,string>} ordered key -> value
 */
export function parseEnvText(text, source = "<config>") {
  if (typeof text !== "string") throw configError("Configuration content must be text.");
  if (text.includes("\0")) {
    throw configError(`Configuration file ${source} contains a NUL byte.`);
  }
  const entries = new Map();
  const seenLower = new Map(); // lowercased key -> original key (dup detection)
  const lines = text.split(/\r\n|\n|\r/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmedLine = line.replace(/^[ \t]+/, "");
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) {
      throw configError(`Malformed line ${lineNo} in ${source}: expected KEY=VALUE.`);
    }
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      throw configError(
        `Invalid configuration key ${JSON.stringify(key)} at line ${lineNo} in ${source}.`,
      );
    }
    const lower = key.toLowerCase();
    if (seenLower.has(lower)) {
      throw configError(
        `Duplicate configuration key ${key} at line ${lineNo} in ${source} ` +
          `(case-equivalent to ${seenLower.get(lower)}).`,
      );
    }

    const rawValue = line.slice(eq + 1).trim();
    let value;
    if (rawValue === "") {
      value = "";
    } else if (rawValue[0] === "'") {
      value = decodeSingleQuoted(rawValue, key, lineNo);
    } else if (rawValue[0] === '"') {
      value = decodeDoubleQuoted(rawValue, key, lineNo);
    } else {
      value = rawValue;
    }

    if (value.includes("\0")) {
      throw configError(`Value for ${key} at line ${lineNo} contains a NUL byte.`);
    }
    if (/[\r\n]/.test(value)) {
      throw configError(`Value for ${key} at line ${lineNo} contains a line break.`);
    }

    seenLower.set(lower, key);
    entries.set(key, value);
  }
  return entries;
}

/** Read and parse a literal configuration file at an absolute path. */
export function parseEnvFile(absPath, readFile = readFileSync) {
  let text;
  try {
    text = readFile(absPath, "utf8");
  } catch (err) {
    throw configError(`Cannot read configuration file: ${absPath} (${err.code || "read error"}).`);
  }
  return parseEnvText(text, absPath);
}
