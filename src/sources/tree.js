// A fetched source's tree on disk: copying a local directory into the store, and the
// digest the lock records so an offline install can refuse a store that changed.
//
// The digest covers every entry's relative path and type, a file's execute bit, size and
// content, and a symlink's target text together with what it resolves to. A special file
// (device, socket, FIFO) is refused: a source is plain files.
//
// A symlink must resolve to an entry inside the tree. A source is remote
// content, and the payload readers follow links, so a link out of the tree (to a
// credential file, say) would put that file into a rendered prompt. One that leaves the
// tree, or dangles, is refused wherever a tree is checked: before a fetched payload is
// read, when its digest is taken, and when an install verifies the store.

import { createHash } from "node:crypto";
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, symlinkSync, chmodSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { configError } from "../errors.js";

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fileSha256(path) {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/** Where the symlink at `abs` resolves, relative to `rootReal`; refuses one that leaves the tree or dangles. */
function confinedTarget(abs, path, rootReal) {
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    throw configError(`${path} is a symlink that does not resolve to anything; a source may only link inside itself.`);
  }
  const rel = relative(rootReal, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) {
    throw configError(`${path} is a symlink that points outside the source; a source may only link inside itself.`);
  }
  return rel;
}

/** Refuse a tree that holds a symlink out of itself (or a dangling one), before anything reads it. */
export function assertLinksConfined(root) {
  const rootReal = realpathSync(root);
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort(byName)) {
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) confinedTarget(abs, path, rootReal);
      else if (st.isDirectory()) walk(abs, path);
    }
  };
  walk(root, "");
}

/** "sha256:<hex>" over the whole tree at `root`; refuses a symlink out of the tree. */
export function treeDigest(root) {
  const h = createHash("sha256");
  const rootReal = realpathSync(root);
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort(byName)) {
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) h.update(`l\0${path}\0${readlinkSync(abs)}\0${confinedTarget(abs, path, rootReal)}\n`);
      else if (st.isDirectory()) {
        h.update(`d\0${path}\n`);
        walk(abs, path);
      } else if (st.isFile()) h.update(`f\0${path}\0${st.mode & 0o111 ? "x" : "-"}\0${st.size}\0${fileSha256(abs)}\n`);
      else throw configError(`${abs} is not a regular file, directory or symlink.`);
    }
  };
  walk(root, "");
  return `sha256:${h.digest("hex")}`;
}

/**
 * Copy a local source directory into `dst` (which must not exist), leaving out every
 * `.git` entry. Symlinks are copied as links, never followed.
 */
export function copyTree(src, dst) {
  mkdirSync(dst);
  for (const name of readdirSync(src).sort(byName)) {
    if (name === ".git") continue;
    const from = join(src, name);
    const to = join(dst, name);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (st.isDirectory()) copyTree(from, to);
    else if (st.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, st.mode & 0o111 ? 0o755 : 0o644);
    } else throw configError(`${from} is not a regular file, directory or symlink.`);
  }
}
