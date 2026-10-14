import { readFileSync, writeFileSync } from "node:fs";
import { PYYAML, parsePy, parsePyDocument, stringifyPy, PyTimestamp } from "../../src/fs/pyyaml.js";
import { mergeConfig } from "../../src/fs/hermes-config.js";
const tagged = (v) => v === null ? ["null"] : typeof v === "boolean" ? ["bool", v] : typeof v === "bigint" ? ["int", v.toString()]
  : typeof v === "number" ? (Number.isNaN(v) ? ["float", "nan"] : ["num", v === Infinity ? "inf" : v === -Infinity ? "-inf" : String(v)])
  : typeof v === "string" ? ["str", v] : v instanceof PyTimestamp ? ["ts"] : Array.isArray(v) ? v.map(tagged)
  : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tagged(x)]));
for (const au of [0, 1]) {
  const src = readFileSync(`src_${au}.yaml`, "utf8");
  writeFileSync(`parsed_${au}.json`, JSON.stringify(tagged(parsePy(src))));
  writeFileSync(`doc_${au}.yaml`, parsePyDocument(src).toString(PYYAML));
  // the installer's edit: set an owned key, keep everything else
  writeFileSync(`merged_${au}.yaml`, mergeConfig(src, { platform_toolsets: { cli: ["file"] } }, []));
}
const strings = JSON.parse(readFileSync("strings.json", "utf8"));
writeFileSync("fresh.yaml", stringifyPy({ s: strings, k: Object.fromEntries(strings.map((s, i) => [s, i]).filter(([s]) => !/[\n\x85\u2028]/.test(s))), n: [0.5, 1e21, 1.5e-7, 12, -3, true, null] }));
