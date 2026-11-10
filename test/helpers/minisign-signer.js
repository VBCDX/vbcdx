// A minisign signer for tests, written straight from the format, so a test can build a
// signed release (the verifier itself is checked against reference vectors separately).
import { createHash, generateKeyPairSync, sign } from "node:crypto";

export function keypair(idByte = 1) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = Buffer.alloc(8, idByte);
  return { privateKey, keyId, pub: Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64") };
}

export function signFile(kp, data, comment) {
  const s = sign(null, createHash("blake2b512").update(data).digest(), kp.privateKey);
  const g = sign(null, Buffer.concat([s, Buffer.from(comment)]), kp.privateKey);
  return ["untrusted comment: test signature", Buffer.concat([Buffer.from("ED"), kp.keyId, s]).toString("base64"),
    `trusted comment: ${comment}`, g.toString("base64"), ""].join("\n");
}
