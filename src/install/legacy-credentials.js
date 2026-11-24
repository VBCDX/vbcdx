// Credential files an earlier version wrote.
//
// Up to 0.2.14 the installer wrote one file per role, and per role and tool, under a
// credentials directory: <dir>/<role>.env and <dir>/<role>/<tool>.env. It writes none now:
// a tool's key lives in Keyhole and reaches the tool only through the sidecar. A file left
// behind still holds a working token, so `vbcdx doctor` fails while one is there and
// `vbcdx install agent` warns, each listing the files by path.
//
// This module only lists. It never opens a file, so it cannot read a value; it never
// follows a symlink, and it never moves, changes or deletes anything: these files were
// never recorded in the install manifest, so the installer cannot prove one is its own.
// Deleting a file revokes nothing either. The operator revokes the token at its service
// and then deletes the file.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// What is not a leftover: the service CLI keeps its signed-in session at
// services/<instance>/session.json (docs/security.md), and the installer never touches
// it. It is recognised by that exact layout, not by the directory name alone, so a role
// that happened to be called "services" still has its files reported.
export const SESSION_STORE_DIR = "services";
export const SESSION_FILE = "session.json";

/**
 * Every leftover under `dir`, as sorted absolute paths: each entry that is not a
 * directory (a file, a symlink, a socket), at any depth, except the CLI's session files
 * (`services/<instance>/session.json`, regular files only). A
 * directory that cannot be listed is reported by its own path, because it cannot be
 * shown to be empty. An absent `dir` has none. A `dir` that is not a directory (a file or
 * a symlink where the directory was) is itself the leftover.
 * @param {string} dir absolute path of the old credentials directory
 * @param {object} [fs] injected for tests: `lstat` and `readdir` (default: the real ones)
 * @returns {string[]}
 */
export function legacyCredentialLeftovers(dir, { lstat = lstatSync, readdir = readdirSync } = {}) {
  const found = [];
  // depth 0 = dir, 1 = its entries, ...; `store` is true below dir/services.
  const visit = (path, depth, store) => {
    let st;
    try {
      st = lstat(path);
    } catch (err) {
      // Absent (or below something that is not a directory): nothing is there.
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") found.push(path);
      return;
    }
    if (!st.isDirectory()) {
      const isSession = store && depth === 3 && st.isFile() && path.endsWith(`/${SESSION_FILE}`);
      if (!isSession) found.push(path);
      return;
    }
    let names;
    try {
      names = readdir(path);
    } catch {
      found.push(path);
      return;
    }
    for (const name of names) {
      visit(join(path, name), depth + 1, depth === 0 ? name === SESSION_STORE_DIR : store);
    }
  };
  visit(dir, 0, false);
  return found.sort();
}

/** What to do about a leftover, in the words `doctor` and `install agent` both use. */
export const LEFTOVER_ADVICE = "it is no longer read; revoke its token at the service, then delete it";

/** The `install agent` warning for a non-empty list: the same paths `doctor` fails on. */
export function leftoverWarning(paths) {
  return `${paths.length} credential file(s) written by an earlier version are still on disk and are no longer read: ${paths.join(", ")}. ` +
    "Revoke each token at its service, then delete the files; `vbcdx doctor` fails until they are gone.";
}
