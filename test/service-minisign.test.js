import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { keyIdText, parsePublicKey, verifyMinisign } from "../src/service/minisign.js";

// Known-good vectors from jedisct1/rust-minisign-verify (src/lib.rs tests), made by the
// reference minisign, so the verifier is checked against an implementation that is not ours.
const REF_PK = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const REF_PREHASHED = [
  "untrusted comment: signature from minisign secret key",
  "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
  "trusted comment: timestamp:1556193335\tfile:test",
  "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==",
].join("\n");
const REF_LEGACY = [
  "untrusted comment: signature from minisign secret key",
  "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=",
  "trusted comment: timestamp:1555779966\tfile:test",
  "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==",
].join("\n");

test("reference vector: a prehashed signature over 'test' verifies", () => {
  const r = verifyMinisign(Buffer.from("test"), REF_PREHASHED, [REF_PK]);
  assert.equal(r.trustedComment, "timestamp:1556193335\tfile:test");
  assert.equal(r.keyId, "E7620F1842B4E81F");
});

test("reference vector: one changed byte of the file fails", () => {
  assert.throws(() => verifyMinisign(Buffer.from("Test"), REF_PREHASHED, [REF_PK]), /does not match the file/);
});

test("reference vector: a legacy signature is refused by default, and verifies only on opt-in", () => {
  assert.throws(() => verifyMinisign(Buffer.from("test"), REF_LEGACY, [REF_PK]), /legacy/);
  assert.equal(verifyMinisign(Buffer.from("test"), REF_LEGACY, [REF_PK], { allowLegacy: true }).keyId, "E7620F1842B4E81F");
});

test("a .pub file with its untrusted comment line parses to the same key", () => {
  const pub = `untrusted comment: minisign public key E7620F1842B4E81F\n${REF_PK}\n`;
  assert.equal(keyIdText(parsePublicKey(pub).keyId), "E7620F1842B4E81F");
});

// A local signer, written straight from the format, to probe each check one at a time.
function keypair(idByte) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = Buffer.alloc(8, idByte);
  return { privateKey, keyId, pub: Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64") };
}
function signFile(kp, data, comment) {
  const s = sign(null, createHash("blake2b512").update(data).digest(), kp.privateKey);
  const g = sign(null, Buffer.concat([s, Buffer.from(comment)]), kp.privateKey);
  return ["untrusted comment: x", Buffer.concat([Buffer.from("ED"), kp.keyId, s]).toString("base64"),
    `trusted comment: ${comment}`, g.toString("base64")].join("\n");
}

test("every failure path is refused with exit 5 and names what failed", () => {
  const a = keypair(1);
  const b = keypair(2);
  const data = Buffer.from("checksums");
  const good = signFile(a, data, "vbcdx-release @vbcdx/sidecar 0.1.0");
  assert.equal(verifyMinisign(data, good, [a.pub]).trustedComment, "vbcdx-release @vbcdx/sidecar 0.1.0");
  const cases = [
    ["untrusted key", () => verifyMinisign(data, good, [b.pub]), /not a trusted release key/],
    ["no key pinned", () => verifyMinisign(data, good, []), /no release key is pinned/],
    ["tampered file", () => verifyMinisign(Buffer.from("checksumz"), good, [a.pub]), /does not match the file/],
    ["tampered trusted comment", () => verifyMinisign(data, good.replace("0.1.0", "9.9.9"), [a.pub]), /trusted comment's signature/],
    ["truncated", () => verifyMinisign(data, good.split("\n").slice(0, 2).join("\n"), [a.pub]), /malformed/],
    ["not base64", () => verifyMinisign(data, good.replace(/\n[^\n]+\n/, "\n!!!!\n"), [a.pub]), /not base64/],
  ];
  for (const [name, fn, re] of cases) {
    assert.throws(fn, (e) => e.code === 5 && re.test(e.message), name);
  }
});

test("rotation: with two keys pinned, a release signed by either verifies, in either order; a third is refused", () => {
  const a = keypair(3);
  const b = keypair(4);
  const c = keypair(6);
  const data = Buffer.from("checksums");
  for (const [signer, pinned] of [[a, [a.pub, b.pub]], [b, [a.pub, b.pub]], [a, [b.pub, a.pub]], [b, [b.pub, a.pub]]]) {
    const r = verifyMinisign(data, signFile(signer, data, "vbcdx-release @vbcdx/sidecar 0.1.0"), pinned);
    assert.equal(r.keyId, keyIdText(signer.keyId));
  }
  assert.throws(() => verifyMinisign(data, signFile(c, data, "x"), [a.pub, b.pub]), (e) => e.code === 5 && /not a trusted release key/.test(e.message));
  // A signature made by A but labelled with B's key id fails on B's key, never falls back to A.
  const forged = signFile(a, data, "x").split("\n");
  const raw = Buffer.from(forged[1], "base64");
  b.keyId.copy(raw, 2);
  forged[1] = raw.toString("base64");
  assert.throws(() => verifyMinisign(data, forged.join("\n"), [a.pub, b.pub]), (e) => e.code === 5 && /does not match the file/.test(e.message));
});
