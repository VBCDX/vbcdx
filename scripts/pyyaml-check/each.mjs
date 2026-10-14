import { readFileSync } from "node:fs";
import { parsePyDocument } from "../../src/fs/pyyaml.js";
const docs = JSON.parse(readFileSync("each.json", "utf8"));
const fail = { v: [], k: [] }, wrong = { v: [], k: [] };
for (const d of docs) {
  for (const kind of ["v", "k"]) {
    let js;
    try { js = parsePyDocument(d[kind]).toJS(); } catch (e) { fail[kind].push([d.s, d.au, e.code]); continue; }
    const got = kind === "v" ? js.s[0] : Object.keys(js)[0];
    if (got !== d["ref_" + kind] || got !== d["cref_" + kind]) wrong[kind].push([d.s, d.au, got]);
  }
}
for (const kind of ["v", "k"]) {
  console.log(`${kind}: ${fail[kind].length} parse failures, ${wrong[kind].length} wrong values`);
  for (const f of fail[kind].slice(0, 6)) console.log("  FAIL", JSON.stringify(f));
  for (const w of wrong[kind].slice(0, 6)) console.log("  WRONG", JSON.stringify(w));
  const cls = {}; for (const [s] of fail[kind]) { const has = (c) => s.includes(String.fromCharCode(c)); const key = [has(10) && "LF", has(0x85) && "NEL", has(0x2028) && "LS", has(9) && "TAB", (s.startsWith(" ") || s.endsWith(" ")) && "EDGE-SP"].filter(Boolean).join("+") || "other"; cls[key] = (cls[key] || 0) + 1; }
  console.log("  failure classes:", JSON.stringify(cls));
}
for (const kind of ["v", "k"]) {
  const cls = {};
  for (const [s, au] of wrong[kind]) {
    const d = docs.find((x) => x.s === s && x.au === au);
    const text = d[kind];
    const raw = [0x85, 0x2028, 0x2029].filter((c) => text.includes(String.fromCharCode(c))).map((c) => c.toString(16));
    const key = `au=${au} raw=${raw.join("+") || "none"}`;
    cls[key] = (cls[key] || 0) + 1;
  }
  console.log(`${kind} wrong-value classes:`, JSON.stringify(cls));
  const allFailRaw = fail[kind].every(([s, au]) => { const t = docs.find((x) => x.s === s && x.au === au)[kind]; return [0x85, 0x2028, 0x2029].some((c) => t.includes(String.fromCharCode(c))); });
  console.log(`${kind} every parse failure has a raw NEL/LS/PS:`, allFailRaw);
}
