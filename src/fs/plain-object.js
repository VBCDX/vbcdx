// One definition of a plain mapping, shared by the installer's read and write rules.
//
// A mapping is a plain object, not an array and not an object that carries a
// prototype of its own: a PyYAML timestamp (src/fs/pyyaml.js) parses to a
// PyTimestamp, and a sequence parses to an Array. Both are documents an in-place
// key edit cannot treat as a mapping, so both sides (remove in
// src/install/commands.js, install classification in src/fs/hermes-config.js)
// must say so the same way.

/** Whether `v` is a plain mapping (Object literal / JSON object). */
export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
