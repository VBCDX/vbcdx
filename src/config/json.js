// Strict JSON parser that rejects duplicate object keys and trailing data.
//
// The integration binding file and the service manifests are configuration the
// installer must validate strictly (spec section 6.1): a duplicate JSON key is
// an error, not a last-writer-wins silent merge. The stock JSON.parse cannot
// report duplicate keys, so this small recursive-descent parser does. It reads
// text only — no interpolation, no ambient values, no code execution.

import { configError } from "../errors.js";

export function parseStrictJson(text, source = "<json>") {
  let i = 0;
  const n = text.length;

  function fail(msg) {
    throw configError(`Invalid JSON in ${source}: ${msg} at offset ${i}.`);
  }
  function ws() {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  }
  function parseValue() {
    ws();
    if (i >= n) fail("unexpected end of input");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    fail(`unexpected character ${JSON.stringify(c)}`);
  }
  function parseObject() {
    i++; // {
    const obj = {};
    const keys = new Set();
    ws();
    if (text[i] === "}") { i++; return obj; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail("expected string key");
      const key = parseString();
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      ws();
      if (text[i] !== ":") fail("expected ':'");
      i++;
      obj[key] = parseValue();
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return obj; }
      fail("expected ',' or '}'");
    }
  }
  function parseArray() {
    i++; // [
    const arr = [];
    ws();
    if (text[i] === "]") { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return arr; }
      fail("expected ',' or ']'");
    }
  }
  function parseString() {
    // Delegate escaping to JSON.parse on the exact quoted token for fidelity.
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (c === '"') { i++; break; }
      if (c === "\n" || c === "\r") fail("unterminated string");
      i++;
    }
    if (i > n) fail("unterminated string");
    const token = text.slice(start, i);
    try {
      return JSON.parse(token);
    } catch {
      fail("malformed string");
    }
  }
  function parseNumber() {
    const start = i;
    if (text[i] === "-") i++;
    while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    if (text[i] === ".") { i++; while (i < n && text[i] >= "0" && text[i] <= "9") i++; }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    const token = text.slice(start, i);
    const num = Number(token);
    if (!Number.isFinite(num)) fail("invalid number");
    return num;
  }

  const value = parseValue();
  ws();
  if (i !== n) fail("trailing data after JSON value");
  return value;
}
