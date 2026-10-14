// The package is universal: nothing in the repository names one deployment.
//
// This walks every tracked file (the repository goes public, tests and CI included) plus
// every file npm publishes, and fails on a deployment's hostnames, node names, network
// ranges, operator and fork names, its review process, and private tracker references. The patterns are assembled from
// fragments, so this file never matches them itself and can sit in a repo that is
// grepped the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const j = (...parts) => parts.join("");

// [label, pattern, a sample the pattern must match]
const DENY = [
  ["deployment hostname", new RegExp(j("tam", "tam"), "i"), j("git.", "tam", "tam", ".co")],
  ["node name", new RegExp(j("\\bai", "-001\\b"), "i"), j("ai", "-001")],
  ["node name", new RegExp(j("hermes", "AI"), "i"), j("hermes", "AI")],
  ["node name", new RegExp(j("hermes", "0[12]"), "i"), j("hermes", "02")],
  ["operator account", new RegExp(j("pve", "-agent"), "i"), j("pve", "-agent")],
  ["operator fork", new RegExp(j("\\bfork", " [A-D]\\b")), j("fork", " B")],
  ["operator fork", new RegExp(j("circle", "-q"), "i"), j("circle", "-q")],
  ["private tracker", new RegExp(j("infra", "structure/[\\w.-]+#\\d+")), j("infra", "structure/development#508")],
  ["private tracker", new RegExp(j("hermes", "-cluster"), "i"), j("hermes", "-cluster#18")],
  ["personal account", new RegExp(j("tya", "bonil"), "i"), j("tya", "bonil")],
  ["private registry", new RegExp(j("verd", "accio"), "i"), j("verd", "accio")],
  ["node name", new RegExp(j("\\bapps", "-0\\d")), j("apps", "-002")],
  ["node name", new RegExp(j("\\bai", "-tools\\b")), j("ai", "-tools")],
  ["node name", new RegExp(j("hermes", "\\d\\d")), j("hermes", "07")],
  ["private tracker", new RegExp(j("infra", "structure/[\\w-]+")), j("infra", "structure/hermes-api")],
  ["private tracker", new RegExp(j("\\b(?:DEV|DAP|vbcdx|FP|CP)", "#\\d")), j("DAP", "#118")],
  ["private tracker", new RegExp(j("(?:^|[^\\w&/'\"`=])", "#\\d{1,4}\\b")), j("see ", "#43")],
  ["process rule", new RegExp(j("Rule", " #\\d|§", "\\d")), j("Rule", " #", "11")],
  ["deployment network", new RegExp(j("192\\.168", "\\.40\\.|\\b10\\.20", "\\.20\\.")), j("192.168", ".40.114")],
  ["Coolify id", new RegExp(j("\\b(?=[a-z0-9]{24}\\b)(?=[a-z0-9]*[g-z])", "(?=[a-z0-9]*\\d)[a-z0-9]{24}\\b")), j("s171azawtq", "ablhu5nmfv8l4m")],
  ["agent identity", new RegExp(j("\\bCODER", "_AGENT\\b|FORGEJO_(?:USER|PASS)", "_[A-Z]")), j("CODER", "_AGENT")],
  ["review process", new RegExp(j("IVAN", " VERDICT|ivan_state", "_mark|audit", "\\.sh|\\[agent", "-update\\]")), j("IVAN", " VERDICT")],
];

// The tokens the universality requirement names, written independently of DENY (and from
// fragments): every one must be caught by some DENY pattern, so deleting a row fails.
const REQUIRED = [
  j("tam", "tam"), j("ai", "-001"), j("hermes", "AI"), j("hermes", "01"), j("hermes", "02"),
  j("pve", "-agent"), j("fork", " A"), j("fork", " D"), j("circle", "-q"),
  j("infra", "structure/caddy#64"), j("hermes", "-cluster"), j("tya", "bonil"),
];

// Every tracked file, and what npm publishes: the `files` entries (directories walked),
// the files npm always includes, and .env.example. packs/ is the A2A image's build
// context, which holds only its README in the repository.
function shippedFiles() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const roots = [...pkg.files, "package.json", "README.md", "LICENSE", ".env.example"];
  const out = new Set();
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else out.add(p);
  };
  for (const r of roots) if (existsSync(join(ROOT, r))) walk(join(ROOT, r));
  const tracked = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of tracked) if (existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile()) out.add(join(ROOT, f));
  return [...out].sort();
}

function leaks(text) {
  return DENY.filter(([, re]) => re.test(text)).map(([label, re]) => `${label} ${re}`);
}

test("every deny pattern matches its sample, and this file's own text matches none", () => {
  for (const [label, re, sample] of DENY) assert.match(sample, re, `${label}: ${re} must catch ${sample}`);
  assert.deepEqual(leaks(readFileSync(fileURLToPath(import.meta.url), "utf8")), []);
});

test("the deny list covers every required token, so removing a pattern fails", () => {
  for (const token of REQUIRED) assert.ok(DENY.some(([, re]) => re.test(token)), `no deny pattern catches ${token}`);
});

test("the walk covers what npm ships, including the plugin, the schemas and .env.example", () => {
  const files = shippedFiles().map((f) => relative(ROOT, f));
  for (const f of [
    ".env.example", "README.md", "package.json", "bin/vbcdx-dev-agents.js", "src/renderers/hermes.js",
    "assets/hermes/plugins/web-litellm-search/__init__.py", "assets/hermes/plugins/web-litellm-search/plugin.yaml",
    "schema/vbcdx-pack.schema.json", "schema/vbcdx-role.schema.json", "src/packs/load.js",
  ]) assert.ok(files.includes(f), `${f} is walked`);
});

test("no shipped file names a deployment's hosts, nodes, operators or private trackers", () => {
  const found = [];
  for (const file of shippedFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const hit of leaks(line)) found.push(`${relative(ROOT, file)}:${i + 1}: ${hit}`);
    });
  }
  assert.deepEqual(found, []);
});
