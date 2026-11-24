#!/usr/bin/env node
// Refuses ci/general-use/ unless it is exactly the pinned copy: every file SHA256SUMS lists
// is present and unchanged, and no other file is there except the repository's own lists.
//
// The shared files (the scanner, its tests, the pull-request step, this script, the README,
// SHA256SUMS itself by being the list) are the same bytes in every repository that carries
// the gate. Three files belong to the repository and are not pinned: allow.txt,
// first-party.txt and SOURCE.
//
// SOURCE says where the shared files came from. In the repository that owns them it is the
// word `canonical`. In every other repository it is, line by line: the owning repository as
// owner/name (CANONICAL_REPOSITORY, exactly; no host), the release tag the files were copied
// at, the 40-hex commit of that tag, an empty line, and that commit's SHA256SUMS. The earlier
// first line, the URL LEGACY_URL, is still read, exactly, with a note, so that a copy can move
// to the name while its base branch's check still asks for the URL. Where the files were copied at
// a commit that has no tag yet, the tag line is a commit pin, `vX.Y.Z-commit.<40-hex>`
// (X.Y.Z the release it will become): it must name the commit line's id, in full. The copy is bound to it: the
// first line must be the one this file names, the local SHA256SUMS must be the recorded list
// byte for byte, and every file must hash to it. Nothing is fetched: that the tag is the
// owning repository's and points at the commit is for a reviewer to compare.
//
// Only the owning repository may say `canonical`. Where the CI variable GITHUB_REPOSITORY is
// set, it must name that repository (CANONICAL_REPOSITORY, compared without regard to case):
// a copy that says `canonical` is refused. Where it is not set, a CI job (one of
// CI_VARIABLES is set) is refused too, since a job that cannot say which repository it is
// in cannot make the claim; a local run is accepted, with a note that the repository was
// not checked.
//
// Usage: node ci/general-use/verify-dir.mjs [dir]     exit 0 ok, 1 refused, 2 cannot check
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL = ["SOURCE", "allow.txt", "first-party.txt"];
export const SHARED = ["README.md", "gate.mjs", "scan.mjs", "scan.test.mjs", "verify-dir.mjs"];

/** The repository that owns the shared files, as owner/name: the only one whose SOURCE is `canonical`. */
export const CANONICAL_REPOSITORY = "VBCDX/vbcdx";
/**
 * The earlier first line of a copy's SOURCE. It is read, exactly, with a note, until the
 * copies have moved to CANONICAL_REPOSITORY; then it is refused like any other source.
 */
export const LEGACY_URL = "https://github.com/VBCDX/vbcdx.git";
/** Where one of these is set, the run is a CI job. The same list as the scanner's. */
export const CI_VARIABLES = ["CI", "GITHUB_ACTIONS", "FORGEJO_ACTIONS", "GITEA_ACTIONS"];

const TAG = "v(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const COPY_SOURCE = new RegExp(`^([^\\n]+)\\n(${TAG})\\n([0-9a-f]{40})\\n(?:\\n([\\s\\S]*))?$`);

// Text from outside (a file name, a variable) is printed on one line: control characters and
// the Unicode line separators are written as escapes.
const printable = (text) => String(text).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, (c) => {
  const n = c.codePointAt(0);
  return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u{${n.toString(16)}}`;
});

/** SOURCE is neither form: which check applies cannot be told, so none is reported as done. */
export class SourceError extends Error {}

/**
 * { canonical: true } for the owning repository, or { canonical: false, origin, tag, commit, sums }
 * for a copy. The form is checked here (a first line, a release tag, a commit id); whether
 * the first line names the owning repository is for the caller, which refuses another.
 */
export function parseSource(text) {
  if (text === "canonical\n") return { canonical: true };
  const m = COPY_SOURCE.exec(text);
  if (!m) throw new SourceError("SOURCE must hold `canonical`, or four things: the owning repository as owner/name, a release tag (vX.Y.Z), its 40-hex commit id, and after an empty line that commit's SHA256SUMS");
  return { canonical: false, origin: m[1], tag: m[2], commit: m[3], sums: m[4] ?? "" };
}

const walk = (dir, prefix = "") => readdirSync(dir).sort().flatMap((name) => {
  const st = lstatSync(join(dir, name));
  if (st.isDirectory()) return walk(join(dir, name), `${prefix}${name}/`);
  return [{ rel: `${prefix}${name}`, file: st.isFile() }];
});

/** Every reason the directory is refused; an empty list means it is the pinned copy. */
export const verifyDir = (dir, env = process.env) => inspectDir(dir, env).problems;

/**
 * { problems, checked, unchecked, legacy }: every reason the directory is refused; the
 * repository a `canonical` SOURCE was checked against (null when it was not, or SOURCE names
 * a commit); whether a `canonical` SOURCE went unchecked because no repository is named; and
 * whether a copy's SOURCE names its source by the earlier first line, LEGACY_URL.
 */
export function inspectDir(dir, env = process.env) {
  const problems = [];
  let checked = null;
  let unchecked = false;
  let legacy = false;
  const present = walk(dir);
  for (const p of present) if (!p.file) problems.push(`${p.rel} is not a regular file`);
  const names = new Set(present.map((p) => p.rel));
  const listed = new Map();
  const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  if (!sums.endsWith("\n")) problems.push("SHA256SUMS does not end with a newline");
  for (const line of sums.split("\n").slice(0, -1)) {
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/.exec(line);
    if (!m) problems.push("SHA256SUMS has a line that is not `<sha256>  <path>`");
    else if (listed.has(m[2])) problems.push(`SHA256SUMS lists ${m[2]} twice`);
    else listed.set(m[2], m[1]);
  }
  for (const name of SHARED) if (!listed.has(name)) problems.push(`SHA256SUMS does not list ${name}`);
  for (const [name, want] of listed) {
    if (!names.has(name)) problems.push(`${name} is listed and missing`);
    else if (createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") !== want) problems.push(`${name} was changed`);
  }
  for (const name of names) if (name !== "SHA256SUMS" && !listed.has(name) && !LOCAL.includes(name)) problems.push(`${name} is not listed`);
  for (const name of LOCAL) {
    if (listed.has(name)) problems.push(`${name} belongs to the repository and must not be pinned`);
    if (!names.has(name)) problems.push(`${name} is missing`);
  }
  if (names.has("SOURCE")) {
    const source = parseSource(readFileSync(join(dir, "SOURCE"), "utf8"));
    if (!source.canonical) {
      // The name, byte for byte; or, until the copies have moved, the earlier URL, byte for byte.
      if (source.origin === LEGACY_URL) legacy = true;
      else if (source.origin !== CANONICAL_REPOSITORY) problems.push(`SOURCE names another source than ${CANONICAL_REPOSITORY}`);
      if (source.sums !== sums) problems.push("SHA256SUMS is not the list SOURCE records for its commit");
      // A commit pin, `vX.Y.Z-commit.<40-hex>`, says it is no tag: it must name the commit
      // on the next line, in full.
      const pin = /-commit\.(.*)$/.exec(source.tag);
      if (pin && pin[1] !== source.commit) problems.push("SOURCE's commit-pin label names another commit than its commit line");
    } else {
      const repository = env.GITHUB_REPOSITORY || "";
      if (repository === "" && CI_VARIABLES.some((name) => env[name])) problems.push("SOURCE says canonical, and this CI job names no repository (GITHUB_REPOSITORY is not set): the claim cannot be checked, so it is refused");
      else if (repository === "") unchecked = true;
      else if (repository.toLowerCase() !== CANONICAL_REPOSITORY.toLowerCase()) problems.push(`SOURCE says canonical, but this is ${repository}: a copy records its source commit`);
      else checked = repository;
    }
  }
  return { problems, checked, unchecked, legacy };
}

// Run only when started as a program, not when imported (the tests import it). Both sides
// are real paths: node gives the main module its real path, so comparing with a resolved
// argv[1] would make a start through a symlink run nothing and exit 0.
function startedAsProgram() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // The program's path is gone or cannot be resolved: whether this is a start or an import
    // cannot be told, so nothing runs and the status says so. The text is fixed.
    process.stderr.write("general-use: the program path could not be resolved; the directory was not checked\n");
    process.exitCode = 2;
    return false;
  }
}

if (startedAsProgram()) {
  const dir = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
  let problems, checked, unchecked, legacy;
  try {
    ({ problems, checked, unchecked, legacy } = inspectDir(dir));
  } catch (err) {
    process.stderr.write(`general-use: the directory could not be checked: ${err instanceof SourceError ? err.message : err.code || err.name || "error"}\n`);
    process.exit(2);
  }
  for (const p of problems) process.stderr.write(`general-use: ${printable(p)}\n`);
  if (unchecked) process.stderr.write("general-use: note: SOURCE says canonical and GITHUB_REPOSITORY is not set: which repository this is was not checked\n");
  if (legacy) process.stderr.write(`general-use: note: SOURCE names its source by the earlier URL; write its first line as ${CANONICAL_REPOSITORY}\n`);
  if (checked !== null) process.stdout.write(`general-use: SOURCE is canonical, checked against GITHUB_REPOSITORY ${checked}\n`);
  process.stdout.write(`general-use: ci/general-use is ${problems.length ? "REFUSED" : "the pinned copy"}\n`);
  process.exit(problems.length ? 1 : 0);
}
