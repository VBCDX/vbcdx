// Minisign signature verification, in-process (the service-CLI spec, npm shipping: release checksums are
// signed with minisign). No `minisign` binary is needed on the host.
//
// Format (https://jedisct1.github.io/minisign/):
//   public key  base64( "Ed" | key id (8) | Ed25519 public key (32) )
//   signature   untrusted comment line
//               base64( "ED" | key id (8) | Ed25519 signature (64) )  over BLAKE2b-512(file)
//               "trusted comment: <text>"
//               base64( global signature (64) )  over ( signature (64) | <text> )
//
// Only prehashed "ED" signatures are accepted: minisign's default since 0.9. A legacy "Ed"
// signature (over the raw file) is refused unless a caller opts in, which only the
// test-vector check does. Every failure is one InstallerError naming what failed, never
// a value from the file.

import { createHash, createPublicKey, verify } from "node:crypto";
import { conflictError } from "../errors.js";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
// minisign prints a key id as a little-endian 64-bit number: the bytes reversed, in hex.
const keyIdText = (id) => Buffer.from(id).reverse().toString("hex").toUpperCase();

function b64(text, bytes, what) {
  const s = String(text).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw conflictError(`minisign: the ${what} is not base64.`);
  const buf = Buffer.from(s, "base64");
  if (buf.length !== bytes) throw conflictError(`minisign: the ${what} is ${buf.length} bytes, expected ${bytes}.`);
  return buf;
}

/** Parse a minisign public key: the bare base64 line, or a .pub file's two lines. */
export function parsePublicKey(text) {
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("untrusted comment:")).pop();
  const raw = b64(line || "", 42, "public key");
  if (raw.subarray(0, 2).toString("latin1") !== "Ed") throw conflictError("minisign: the public key is not an Ed25519 key.");
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw.subarray(10)]), format: "der", type: "spki" }),
  };
}

/** Parse a .minisig file into its parts. */
export function parseSignature(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:")) throw conflictError("minisign: the signature file is malformed.");
  const sig = b64(lines[1], 74, "signature");
  const alg = sig.subarray(0, 2).toString("latin1");
  if (alg !== "ED" && alg !== "Ed") throw conflictError("minisign: unknown signature algorithm.");
  if (!lines[2].startsWith("trusted comment: ")) throw conflictError("minisign: the trusted comment line is missing.");
  return {
    alg,
    keyId: sig.subarray(2, 10),
    signature: sig.subarray(10),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature: b64(lines[3], 64, "global signature"),
  };
}

/**
 * Verify `data` against a minisign signature with one of the trusted public keys.
 * @returns {{trustedComment: string, keyId: string}} on success; throws exit 5 otherwise.
 */
export function verifyMinisign(data, signatureText, trustedKeys, { allowLegacy = false } = {}) {
  const sig = parseSignature(signatureText);
  const keys = trustedKeys.map((k) => (typeof k === "string" ? parsePublicKey(k) : k));
  if (!keys.length) throw conflictError("minisign: no release key is pinned, so nothing can be verified.");
  const pk = keys.find((k) => k.keyId.equals(sig.keyId));
  if (!pk) throw conflictError(`minisign: signed by key ${keyIdText(sig.keyId)}, which is not a trusted release key.`);
  if (sig.alg === "Ed" && !allowLegacy) throw conflictError("minisign: legacy (non-prehashed) signatures are refused.");
  const message = sig.alg === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  if (!verify(null, message, pk.key, sig.signature)) throw conflictError("minisign: the signature does not match the file.");
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!verify(null, global, pk.key, sig.globalSignature)) throw conflictError("minisign: the trusted comment's signature does not match.");
  return { trustedComment: sig.trustedComment, keyId: keyIdText(sig.keyId) };
}

export { keyIdText };
