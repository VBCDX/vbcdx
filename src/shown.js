// What an error may quote of what the user typed.
//
// A secret pasted into the wrong slot (a raw token given as --enroll-token-file's value, a
// password as a stray argument) must never come back on the terminal, or in a log that captures
// stderr. refuseSecretArgs (src/service/scan.js) catches marked tokens before parsing; these
// rules cover the rest:
// - a word the user chose (a command, kind, service, harness, scope or agent name) is quoted
//   only when it is name-shaped, vbcdx-core's shown_name rule: lowercase letters, digits and
//   dashes, starting with a letter, at most 32 long, and not made only of hex digits (a hex
//   token or key of that size would pass the other rules);
// - an option is quoted by its name, never its value, and only a name-shaped name;
// - a stray argument is named by its position;
// - and, as a backstop for errors raised after parsing (a path that can't be read, an instance
//   that isn't installed), the CLI replaces any value from argv that isn't name-shaped with
//   "<argument N>" before it prints an error (redactTyped). It also replaces what the code
//   can turn a typed value into before quoting it: the JSON-escaped form, the form without a
//   trailing "/", and the path it resolves to (cwd- and ~-relative), so a transformed copy
//   can't slip past a plain substring match.
// An error should still quote a typed value only as typed: the variants are the backstop's,
// not a licence to print a resolved path.

import { join, resolve } from "node:path";

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ALL_HEX = /^[0-9a-f]+$/;
// A version, or a scoped npm package name (@scope/name, npm's lowercase rule), is never a secret,
// and an error about one is clearer with it. A path is not exempt: a path slot is where a pasted
// token lands (--enroll-token-file=<token>).
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,113}$/;
// Shorter values aren't plausible secrets, and redacting them would garble messages ("." or "x").
const MIN_REDACTED = 8;

export const NOT_SHOWN = "<not shown>";

/** `w` when it is name-shaped, else null. */
export function word(w) {
  return typeof w === "string" && NAME.test(w) && !ALL_HEX.test(w) ? w : null;
}

/** A skill, tool or package name as an error may quote it: a name-shaped word or a scoped npm
 *  name (@scope/name), else NOT_SHOWN. */
export function shownName(n) {
  return word(n) ?? (typeof n === "string" && SCOPED_PACKAGE.test(n) ? n : NOT_SHOWN);
}

/** A word as an error may quote it: itself when name-shaped, else NOT_SHOWN. */
export function shownWord(w) {
  return word(w) ?? NOT_SHOWN;
}

/** An option as an error may quote it: its `--name` (never `=value`) when name-shaped, else NOT_SHOWN. */
export function shownOption(arg) {
  if (typeof arg !== "string" || !arg.startsWith("--")) return NOT_SHOWN;
  const eq = arg.indexOf("=");
  const key = eq === -1 ? arg : arg.slice(0, eq);
  return word(key.slice(2)) ? key : NOT_SHOWN;
}

/** The message for an argument that doesn't belong: its 1-based position after `vbcdx`. */
export function unexpectedArgument(position) {
  return `Unexpected argument (position ${position}).`;
}

// JSON.stringify's escaping of a string, without the quotes: what a JSON-quoted copy contains.
const jsonInner = (v) => JSON.stringify(v).slice(1, -1);

/** What the code may turn a typed value into before an error quotes it (see the header). */
function variants(v, cwd, home) {
  const forms = new Set([v, v.replace(/\/+$/, "")]);
  forms.add(resolve(cwd, v));
  if (v.startsWith("~") && home) forms.add(join(home, v.slice(1)));
  for (const f of [...forms]) forms.add(jsonInner(f));
  return [...forms].filter((f) => f.length >= MIN_REDACTED);
}

/** The values typed in argv that an error must not quote, as [value, label] pairs, longest first. */
function typedValues(argv, cwd, home) {
  const out = [];
  argv.forEach((a, i) => {
    if (typeof a !== "string") return;
    const label = `<argument ${i + 1}>`;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out.push([a.slice(eq + 1), label]);
      if (shownOption(a) === NOT_SHOWN) out.push([eq === -1 ? a.slice(2) : a.slice(2, eq), label]);
    } else {
      out.push([a, label]);
    }
  });
  // A comma list (--agents=a,b, install agent a,b) reaches an error one piece at a time.
  for (const [v, label] of [...out]) if (v.includes(",")) for (const piece of v.split(",")) out.push([piece, label]);
  return out
    .filter(([v]) => v.length >= MIN_REDACTED && !word(v) && !VERSION.test(v) && !SCOPED_PACKAGE.test(v))
    .flatMap(([v, label]) => variants(v, cwd, home).map((f) => [f, label]))
    .sort((x, y) => y[0].length - x[0].length);
}

/** `text` with every value from argv that isn't name-shaped (and each form the code may turn it
 *  into) replaced by "<argument N>". */
export function redactTyped(text, argv, { cwd = process.cwd(), home = process.env.HOME } = {}) {
  let s = String(text);
  for (const [v, label] of typedValues(argv, cwd, home)) s = s.split(v).join(label);
  return s;
}
