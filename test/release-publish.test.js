// scripts/release-publish.sh: the tag-only publish of this
// package to the test registry. The script runs from a scratch copy (its own package.json) with a
// fake npm that resolves a scoped package's registry the way npm does: `--@vbcdx:registry=` on the
// command line, then a project .npmrc, then the userconfig's `@vbcdx:registry`, then `--registry`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "TEST-TOKEN-CANARY-0123456789";
const REG = "https://npm.test.example/";

const FAKE_NPM = `#!/usr/bin/env bash
echo "npm $*" >> "$NPM_LOG"
args=("$@") uc= cli= reg=
for ((i = 0; i < \${#args[@]}; i++)); do
  case \${args[i]} in
    --userconfig) uc=\${args[i+1]};;
    --registry) reg=\${args[i+1]};;
    --@vbcdx:registry=*) cli=\${args[i]#--@vbcdx:registry=};;
  esac
done
[ -n "$uc" ] && cp "$uc" "$NPM_LOG.npmrc" && echo "userconfig $(stat -c %a "$uc") $uc" >> "$NPM_LOG"
scope() { [ -f "$1" ] && sed -n 's/^@vbcdx:registry=//p' "$1" | tail -n 1; }
eff=$cli
[ -n "$eff" ] || eff=$(scope .npmrc)
[ -n "$eff" ] || eff=$(scope "$uc")
[ -n "$eff" ] || eff=$reg
host=\${eff#*://}
auth=$(grep -F "//$host:_authToken=" "$uc" | sed -n 's/.*_authToken=\\\${\\(.*\\)}$/\\1/p' | tail -n 1)
echo "effective $eff auth=\${auth:-none} token=\${NPM_TEST_REGISTRY_TOKEN:+present}" >> "$NPM_LOG"
`;

function scratch(version = "0.2.0", extra = { publishConfig: { access: "public" } }) {
  const dir = mkdtempSync(join(tmpdir(), "vbcdx-release-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "bin"));
  copyFileSync(join(ROOT, "scripts", "release-publish.sh"), join(dir, "scripts", "release-publish.sh"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@vbcdx/vbcdx", version, ...extra }) + "\n");
  writeFileSync(join(dir, "bin", "npm"), FAKE_NPM);
  chmodSync(join(dir, "bin", "npm"), 0o755);
  return dir;
}

function publish(dir, env = {}) {
  const log = join(dir, "npm.log");
  const r = spawnSync("bash", [join(dir, "scripts", "release-publish.sh")], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`, NPM_LOG: log,
      GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v0.2.0",
      NPM_TEST_REGISTRY: REG, NPM_TEST_REGISTRY_TOKEN: TOKEN, ...env,
    },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  return { status: r.status, out, log: existsSync(log) ? readFileSync(log, "utf8") : "", npmrc: existsSync(`${log}.npmrc`) ? readFileSync(`${log}.npmrc`, "utf8") : "" };
}

function withScratch(fn, version, extra) {
  const dir = scratch(version, extra);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a v<version> tag publishes this package to the test registry, as next, with its token", () => withScratch((dir) => {
  const r = publish(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /^npm publish \. --registry https:\/\/npm\.test\.example\/ --@vbcdx:registry=https:\/\/npm\.test\.example\/ --userconfig \S+ --tag next$/m);
  assert.doesNotMatch(r.log, /--tag latest/, "latest moves only after the scan, by hand");
  assert.match(r.log, /^effective https:\/\/npm\.test\.example\/ auth=NPM_TEST_REGISTRY_TOKEN token=present$/m);
  assert.match(r.npmrc, /^\/\/npm\.test\.example\/:_authToken=\$\{NPM_TEST_REGISTRY_TOKEN\}$/m, "the userconfig names the token's variable");
  assert.match(r.out, /published to npm\.test\.example as next$/m, "the log names the host only");
  assert.ok(!r.out.includes(TOKEN) && !r.log.includes(TOKEN) && !r.npmrc.includes(TOKEN), "the token is in no argv, file or output");
  const [, mode, path] = r.log.match(/^userconfig (\d+) (\S+)$/m) || [];
  assert.equal(mode, "600", "the userconfig is written 0600");
  assert.ok(path && !existsSync(path) && !existsSync(dirname(path)), "the userconfig and its directory are gone afterwards");
}));

for (const [name, publishConfig] of [
  ["publishConfig.registry", { registry: "https://wrong.example/" }],
  ["publishConfig's @vbcdx:registry", { "@vbcdx:registry": "https://wrong.example/" }],
]) {
  test(`publish refuses a package.json that names a registry (${name}), before npm runs`, () => withScratch((dir) => {
    const r = publish(dir);
    assert.notEqual(r.status, 0, "it published");
    assert.equal(r.log, "", "npm ran");
    assert.match(r.out, /publishConfig names a registry/);
  }, "0.2.0", { publishConfig }));
}

test("a pre-release is published as next, never latest", () => withScratch((dir) => {
  const r = publish(dir, { GITHUB_REF: "refs/tags/v0.3.0-rc.1" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /--tag next$/m);
  assert.doesNotMatch(r.log, /--tag latest/);
}, "0.3.0-rc.1"));

test("a project .npmrc can't redirect the publish", () => withScratch((dir) => {
  writeFileSync(join(dir, ".npmrc"), "@vbcdx:registry=https://wrong.example/\n");
  const r = publish(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /^effective https:\/\/npm\.test\.example\/ /m);
  assert.doesNotMatch(r.log, /wrong\.example/);
}));

const refusals = [
  ["a pull request", { GITHUB_EVENT_NAME: "pull_request" }, /only a v\* tag push is published/],
  ["a push to main", { GITHUB_REF: "refs/heads/main" }, /only a v\* tag push is published/],
  ["a tag that isn't package.json's version", { GITHUB_REF: "refs/tags/v0.2.1" }, /the tag is not v0\.2\.0/],
  ["no test registry", { NPM_TEST_REGISTRY: "" }, /NPM_TEST_REGISTRY is not set/],
  ["a cleartext registry", { NPM_TEST_REGISTRY: "http://npm.test.example/" }, /must be an https URL ending in \//],
  ["no trailing /", { NPM_TEST_REGISTRY: "https://npm.test.example" }, /must be an https URL ending in \//],
  ["credentials in the URL", { NPM_TEST_REGISTRY: "https://u:URL-PW-CANARY@npm.test.example/" }, /must not carry credentials/],
  ["a non-ASCII host", { NPM_TEST_REGISTRY: "https://npm.tést.example/" }, /not a plain ASCII host name/],
  ["npmjs", { NPM_TEST_REGISTRY: "https://registry.npmjs.org/" }, /names a public registry/],
  ["npmjs, upper case", { NPM_TEST_REGISTRY: "https://REGISTRY.npmjs.org/" }, /names a public registry/],
  ["npmjs with a trailing dot", { NPM_TEST_REGISTRY: "https://registry.npmjs.org./" }, /names a public registry/],
  ["npmjs on :443", { NPM_TEST_REGISTRY: "https://registry.npmjs.org:443/" }, /names a public registry/],
  ["npmjs with a trailing dot and :443", { NPM_TEST_REGISTRY: "https://Registry.npmjs.org.:443/" }, /names a public registry/],
  ["npmjs with a trailing dot and another port", { NPM_TEST_REGISTRY: "https://registry.npmjs.org.:8443/" }, /names a public registry/],
  ["the yarnpkg mirror", { NPM_TEST_REGISTRY: "https://registry.yarnpkg.com/" }, /names a public registry/],
  ["GitHub's registry", { NPM_TEST_REGISTRY: "https://npm.pkg.github.com/" }, /names a public registry/],
  ["an empty token", { NPM_TEST_REGISTRY_TOKEN: "" }, /NPM_TEST_REGISTRY_TOKEN secret is empty/],
  ["a token with a newline", { NPM_TEST_REGISTRY_TOKEN: "abc\n//evil.example/:_authToken=x" }, /not one line of printable characters/],
  ["a token with a space", { NPM_TEST_REGISTRY_TOKEN: "abc def" }, /not one line of printable characters/],
  ["an npmrc expansion in the registry path", { NPM_TEST_REGISTRY: "https://npm.test.example/${HOME}/" }, /path has characters outside a plain URL path/],
  ["a newline in the registry path", { NPM_TEST_REGISTRY: "https://npm.test.example/a\nb/" }, /path has characters outside a plain URL path/],
  ["a space in the registry path", { NPM_TEST_REGISTRY: "https://npm.test.example/a b/" }, /path has characters outside a plain URL path/],
];
for (const [name, env, want] of refusals) {
  test(`publish refuses ${name}, before npm runs`, () => withScratch((dir) => {
    const r = publish(dir, env);
    assert.notEqual(r.status, 0, `${name}: it published`);
    assert.equal(r.log, "", `${name}: npm ran`);
    assert.match(r.out, want);
    assert.ok(!r.out.includes("URL-PW-CANARY"), "a refused URL is not printed");
  }));
}
