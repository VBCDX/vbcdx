// PEM certificate files the installer is given (--service-cert, --control-ca) or carries over from
// an install (the recorded control CA): one reader, one set of rules.

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { configError } from "../errors.js";

// A service certificate chain (the leaf and the control CA) is a few kilobytes.
const CERT_MAX = 64 * 1024;

/**
 * A PEM certificate file given on the command line, read before anything is written: a regular
 * file, never through a symlink (and non-blocking, so a planted FIFO can't hang the installer), at
 * most CERT_MAX, PEM certificates only, and never one holding a private key. Only its shape is
 * checked here; the daemon's own check decides the rest.
 */
export function readPemCerts(flag, f, from) {
  let fd;
  try {
    fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw configError(`${flag} ${f} can't be opened (${e.code}); it must be a regular file, not a symlink.`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw configError(`${flag} ${f} must be a regular file.`);
    const buf = Buffer.alloc(CERT_MAX + 1);
    let n = 0;
    for (let k; n < buf.length && (k = readSync(fd, buf, n, buf.length - n, null)) > 0;) n += k;
    if (n > CERT_MAX) throw configError(`${flag} ${f} is larger than a certificate chain.`);
    const pem = buf.subarray(0, n);
    if (!pem.toString("latin1").startsWith("-----BEGIN CERTIFICATE-----") || /PRIVATE KEY/.test(pem.toString("latin1"))) {
      throw configError(`${flag} ${f} is not a PEM certificate chain (${from}).`);
    }
    return Buffer.from(pem);
  } finally {
    closeSync(fd);
  }
}

