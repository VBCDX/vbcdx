// The LiteLLM web provider — search *and* fetch — vendored as a rendered asset.
//
// The provider is a Hermes plugin written in Python, so this test runs the real file
// under python3 (as test/hermes-git.test.js runs hermes-git.py) against a stub LiteLLM
// gateway and a stub page. Only the public provider ABC is stubbed: the plugin must not
// reach into Hermes' private plumbing, and here it cannot.
//
// What it pins, from the issue: the key is used by name and never leaves the gateway
// (Required 4), the tool is read-only (Required 5), and every failure — an unset key, an
// unknown search tool, HTTP 429, HTTP 500, a 200 with no results field, a 404 page, an
// empty page — has its own visible error and can never be mistaken for "no results"
// (Required 7). Required 3 (fetch a result and quote it) is the reason the file exists.
//
// And the one thing that would silently defeat all of it: a redirect. Neither request
// follows a 3xx, so the two tests below stand a *second* server up and
// assert it is never contacted at all — the same refusal already set for the forgejo token.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { renderHermesWebSearchPlugin } from "../src/renderers/hermes.js";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(here, "..", "assets", "hermes", "plugins", "web-litellm-search");
const PLUGIN = join(PLUGIN_DIR, "__init__.py");
const MANIFEST = join(PLUGIN_DIR, "plugin.yaml");

const KEY = "stub-litellm-key-2f9a";
const QUOTED = "A string prefix that matches the whole string never matches a longer ref.";
const roots = [];
const servers = [];
// Teardown is unconditional: a test that fails must fail fast, never leave a listening
// stub behind (an open handle keeps `node --test` alive past the last result line).
after(() => { for (const s of servers) s.close(); for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

// ---- the stub gateway + stub pages, in this process
//
// The python child talks back to this server, so every call must be async: a blocking
// spawnSync would freeze the event loop that is supposed to answer it.
function stub(opts = {}) {
  const seen = { search: [], page: [] };
  const json = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  const html = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  };
  const redirect = (res, location) => {
    res.writeHead(302, { Location: location });
    res.end();
  };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      if (path.startsWith("/v1/search/")) {
        seen.search.push({ tool: path.slice("/v1/search/".length), auth: req.headers.authorization, body });
        if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: "invalid key" });
        const { query, max_results } = JSON.parse(body);
        seen.search[seen.search.length - 1].query = query;
        seen.search[seen.search.length - 1].max_results = max_results;
        if (query === "redirect") return redirect(res, `${opts.redirectSearchTo}/stolen`);
        if (query === "ratelimit") return json(res, 429, { error: "rate limited" });
        if (query === "gateway-500") return json(res, 500, { error: "internal error" });
        if (query === "gateway-500-cause") return json(res, 500, { error: "Unknown search tool: NoSuchTool" });
        if (query === "gateway-500-leak") return json(res, 500, { error: `key ${KEY} is not permitted`, detail: "and here is more" });
        if (query === "gateway-500-text") return json(res, 500, "upstream timed out");
        if (query === "gateway-500-bare") return json(res, 500, "{}");
        if (query === "unknown-tool") return json(res, 200, { error: `Unknown search tool: ${seen.search[seen.search.length - 1].tool}` });
        if (query === "no-field") return json(res, 200, { object: "list", data: [] });
        if (query === "leak-key") return json(res, 200, { error: `key ${KEY} is not permitted for this tool` });
        if (query === "garbage") return json(res, 200, "not json at all");
        return json(res, 200, {
          results: [
            { title: "gitcredentials(7)", url: "http://127.0.0.1:0/page", snippet: "credential helpers" },
            { title: "Second hit", url: "http://127.0.0.1:0/page", snippet: "another" },
          ],
        });
      }
      seen.page.push({ path, auth: req.headers.authorization });
      if (path === "/page-redirect") return redirect(res, `${opts.redirectPageTo}/stolen-page`);
      if (path === "/page") {
        return html(res, 200, `<html><head><title>gitcredentials(7)</title><style>.x{}</style></head>
          <body><h1>Credential helpers</h1><p>${QUOTED}</p>
          <script>var noise = "should not be quoted";</script></body></html>`);
      }
      if (path === "/scriptonly") return html(res, 200, "<html><body><script>only a script</script></body></html>");
      if (path === "/empty") return html(res, 200, "   ");
      return html(res, 404, "<html><body>not found</body></html>");
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      let closed = false;
      const close = () => { if (!closed) { closed = true; srv.close(); } };
      servers.push({ close });
      resolve({ base, seen, close });
    });
  });
}

// ---- a third host, reachable only if a redirect is actually followed
//
// It answers 200 with an empty result set, so a followed redirect would not merely leak the
// key: it would look like a successful search. Everything it receives is recorded, so a test
// can assert it was never contacted at all.
function decoy() {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url.split("?")[0], auth: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      let closed = false;
      const close = () => { if (!closed) { closed = true; srv.close(); } };
      servers.push({ close });
      resolve({ base: `http://127.0.0.1:${srv.address().port}`, seen, close });
    });
  });
}

// ---- the plugin, run for real under python3
const DRIVER = `
import importlib.util, json, os, sys, types

class WebSearchProvider:  # agent/web_search_provider.py — the public plugin-facing ABC
    def is_available(self): raise NotImplementedError
    def supports_search(self): return True
    def supports_extract(self): return False
    def is_keyless_available(self): return False

def get_provider_env(name): return (os.environ.get(name) or "").strip()

agent = types.ModuleType("agent")
wsp = types.ModuleType("agent.web_search_provider")
wsp.WebSearchProvider = WebSearchProvider
wsp.get_provider_env = get_provider_env
agent.web_search_provider = wsp
sys.modules["agent"] = agent
sys.modules["agent.web_search_provider"] = wsp

spec = importlib.util.spec_from_file_location("litellm_search", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Context:
    def __init__(self): self.providers = []
    def register_web_search_provider(self, provider): self.providers.append(provider)

ctx = Context()
module.register(ctx)
provider = ctx.providers[0]
plan = json.loads(sys.argv[2])

# The fetch reaches public addresses only. The stubs listen on loopback, so a test
# trusts loopback unless it asks for the real rule with strict.
import ipaddress, socket
_public = module._address_allowed
if plan.get("trust_loopback", True):
    module._address_allowed = lambda ip: ip.is_loopback or _public(ip)
# A name that answers one address, then another: the connection must use the first.
if plan.get("rebind"):
    rb = plan["rebind"]
    _real = socket.getaddrinfo
    answers = [rb["first"], rb["then"]]
    def _rebinding(host, port, *a, **k):
        if host != rb["host"]:
            return _real(host, port, *a, **k)
        ip = answers.pop(0) if len(answers) > 1 else answers[0]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]
    socket.getaddrinfo = _rebinding

out = {
    "registered": len(ctx.providers),
    "name": provider.name,
    "display_name": provider.display_name,
    "available": provider.is_available(),
    "supports_search": provider.supports_search(),
    "supports_extract": provider.supports_extract(),
    "setup_schema": provider.get_setup_schema(),
}
if plan.get("search"):
    out["search"] = provider.search(plan["search"], plan.get("limit", 5))
if plan.get("urls") is not None:
    out["extract"] = provider.extract(plan["urls"])
if plan.get("addresses"):
    out["allowed"] = {a: _public(ipaddress.ip_address(a)) for a in plan["addresses"]}
if plan.get("global_probe"):
    # Each address made to read as global and unicast, as an older Python's tables may say:
    # only the explicit deny list can refuse it, so the result is the same on any interpreter.
    def _forced(a):
        real = ipaddress.ip_address(a)
        cls = type("Forced", (type(real),), {"is_global": property(lambda self: True), "is_multicast": property(lambda self: False)})
        return cls(a)
    out["forced"] = {a: _public(_forced(a)) for a in plan["global_probe"]}
if plan.get("mapped_probe"):
    # An IPv6 address whose own is_global says the opposite of the IPv4 it carries: the rule
    # must judge the carried address, on any Python (3.13 also does this natively).
    class _Mapped:
        version = 6
        is_multicast = False
        def __init__(self, v4, own): self.ipv4_mapped, self.is_global = ipaddress.ip_address(v4), own
    out["mapped"] = {"private_v4": _public(_Mapped("10.0.0.1", True)), "public_v4": _public(_Mapped("8.8.8.8", False))}
sys.stdout.write(json.dumps(out))
`;
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const driverPath = join(tmp("web-provider-driver-"), "driver.py");

function runProvider({ plugin = PLUGIN, base, key = KEY, tool = "example-search", search, urls, limit, env: extra, strict = false, rebind, addresses, mappedProbe, globalProbe }) {
  writeFileSync(driverPath, DRIVER);
  const env = { PATH: process.env.PATH, HOME: driverPath, PYTHONDONTWRITEBYTECODE: "1" };
  if (base) env.LITELLM_SEARCH_BASE = base;
  if (tool) env.LITELLM_SEARCH_TOOL = tool;
  if (key) env.LITELLM_SEARCH_API_KEY = key;
  Object.assign(env, extra || {}); // explicit overrides, e.g. the advertised key env name
  // Python's json reads Infinity and NaN; JSON.stringify writes them as null.
  const nonFinite = typeof limit === "number" && !Number.isFinite(limit);
  const plan = nonFinite
    ? JSON.stringify({ search, urls, limit: "@@LIMIT@@", trust_loopback: !strict, rebind, addresses, mapped_probe: mappedProbe, global_probe: globalProbe }).replace('"@@LIMIT@@"', Number.isNaN(limit) ? "NaN" : limit > 0 ? "Infinity" : "-Infinity")
    : JSON.stringify({ search, urls, limit, trust_loopback: !strict, rebind, addresses, mapped_probe: mappedProbe, global_probe: globalProbe });
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [driverPath, plugin, plan], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      // Reject rather than throw: a throw inside this handler would leave the promise
      // unsettled, so the caller's cleanup would never run and the suite would hang.
      if (status !== 0) return reject(new Error(`python3 exited ${status}: ${stderr}`));
      try {
        resolve({ raw: stdout.trim(), out: JSON.parse(stdout.trim()) });
      } catch (err) {
        reject(new Error(`provider produced no JSON (${err.message}): ${stdout}${stderr}`));
      }
    });
  });
}

// ---- the manifest and the provider surface

test("the plugin manifest is a backend that provides litellm-search", () => {
  const manifest = yamlParse(readFileSync(MANIFEST, "utf8"));
  assert.equal(manifest.name, "web-litellm-search");
  assert.equal(manifest.kind, "backend");
  assert.deepEqual(manifest.provides_web_providers, ["litellm-search"]);
  // No key value, and no `requires_env`: a manifest that refuses to load without the key
  // would unregister the provider, and a pinned web.search_backend that is not registered
  // falls back to another backend instead of reporting the missing key (Required 7).
  assert.doesNotMatch(readFileSync(MANIFEST, "utf8"), /key\s*[:=]/i);
  assert.equal(manifest.requires_env, undefined);
});

test("one provider serves both search and fetch, and reports availability from the key alone", async () => {
  const s = await stub();
  try {
    const withKey = await runProvider({ base: s.base, urls: [] });
    assert.equal(withKey.out.registered, 1);
    assert.equal(withKey.out.name, "litellm-search");
    assert.equal(withKey.out.supports_search, true);
    assert.equal(withKey.out.supports_extract, true);
    assert.equal(withKey.out.available, true);
    assert.deepEqual(withKey.out.setup_schema.env_vars.map((v) => v.key), ["HERMES_PROVIDER_API_KEY"]);
    const noKey = await runProvider({ base: s.base, key: "", urls: [] });
    assert.equal(noKey.out.available, false);
    assert.equal(noKey.out.supports_extract, true); // still the configured extract backend
  } finally { s.close(); }
});

// ---- search

test("search returns ranked title/url/snippet rows and sends the key to the gateway only", async () => {
  const s = await stub();
  try {
    const { out } = await runProvider({ base: s.base, search: "git credential helper", limit: 50 });
    assert.equal(out.search.success, true);
    assert.deepEqual(out.search.data.web, [
      { title: "gitcredentials(7)", url: "http://127.0.0.1:0/page", description: "credential helpers", position: 1 },
      { title: "Second hit", url: "http://127.0.0.1:0/page", description: "another", position: 2 },
    ]);
    // the documented wire shape, in order: title, url, description, position
    assert.deepEqual(Object.keys(out.search.data.web[0]), ["title", "url", "description", "position"]);
    assert.equal(s.seen.search.length, 1);
    assert.equal(s.seen.search[0].auth, `Bearer ${KEY}`);
    assert.equal(s.seen.search[0].tool, "example-search");
    assert.equal(s.seen.search[0].query, "git credential helper");
    assert.equal(s.seen.search[0].max_results, 20); // the vendor cap, not 50
  } finally { s.close(); }
});

test("each search failure is its own visible error, never an empty result set", async () => {
  const s = await stub();
  const cases = [
    ["ratelimit", "LiteLLM search HTTP 429 (example-search): rate limited"],
    ["gateway-500", "LiteLLM search HTTP 500 (example-search): internal error"],
    ["unknown-tool", "LiteLLM search error (example-search): Unknown search tool: example-search"],
    ["no-field", "LiteLLM search returned no results field (example-search)"],
    ["garbage", "LiteLLM search returned a non-JSON body (example-search)"],
  ];
  try {
    for (const [query, error] of cases) {
      const { out } = await runProvider({ base: s.base, search: query });
      assert.equal(out.search.success, false, query);
      assert.equal(out.search.error, error, query);
      assert.equal(out.search.data, undefined, `${query} must not carry a result set`);
    }
    const noKey = await runProvider({ base: s.base, key: "", search: "anything" });
    assert.equal(noKey.out.search.success, false);
    assert.equal(noKey.out.search.error, "no LiteLLM key (HERMES_PROVIDER_API_KEY / LITELLM_SEARCH_API_KEY)");
    assert.equal(noKey.out.search.data, undefined);
    // A gateway that never answers is reported too, and is not "no results"
    const down = await runProvider({ base: "http://127.0.0.1:1", search: "anything" });
    assert.equal(down.out.search.success, false);
    assert.match(down.out.search.error, /^LiteLLM search failed \(example-search\): /);
  } finally { s.close(); }
});

test("an HTTP error that explains itself keeps its explanation, redacted (review O1)", async () => {
  const s = await stub();
  try {
    // the cause survives: a 500 that says why must not read as a bare status code
    const cause = await runProvider({ base: s.base, search: "gateway-500-cause" });
    assert.equal(cause.out.search.success, false);
    assert.equal(cause.out.search.error, "LiteLLM search HTTP 500 (example-search): Unknown search tool: NoSuchTool");
    assert.equal(cause.out.search.data, undefined);
    // a plain-text error body is an explanation too
    const text = await runProvider({ base: s.base, search: "gateway-500-text" });
    assert.equal(text.out.search.error, "LiteLLM search HTTP 500 (example-search): upstream timed out");
    // a body with nothing to say still reports its status, and gains no dangling ": "
    const bare = await runProvider({ base: s.base, search: "gateway-500-bare" });
    assert.equal(bare.out.search.error, "LiteLLM search HTTP 500 (example-search)");
    // an invalid key keeps the gateway's own reason
    const refused = await runProvider({ base: s.base, key: "not-the-key", search: "anything" });
    assert.equal(refused.out.search.error, "LiteLLM search HTTP 401 (example-search): invalid key");
    assert.equal(refused.out.search.data, undefined);
    // and the detail cannot carry the key out
    const echo = await runProvider({ base: s.base, search: "gateway-500-leak" });
    assert.equal(echo.out.search.error, "LiteLLM search HTTP 500 (example-search): key <redacted> is not permitted");
    assert.ok(!echo.raw.includes(KEY), "the credential must not appear anywhere in the provider's output");
  } finally { s.close(); }
});

test("a configured but unknown search tool is reported, not softened to no results", async () => {
  const s = await stub();
  try {
    const { out } = await runProvider({ base: s.base, tool: "NoSuchTool", search: "unknown-tool" });
    assert.equal(out.search.success, false);
    assert.match(out.search.error, /LiteLLM search error \(NoSuchTool\): Unknown search tool: NoSuchTool/);
  } finally { s.close(); }
});

// ---- redirects: refused on both requests

test("a gateway that redirects cannot hand the key to another host (review B1)", async () => {
  const other = await decoy();
  const s = await stub({ redirectSearchTo: other.base });
  try {
    const { raw, out } = await runProvider({ base: s.base, search: "redirect" });
    // The host named by Location is never contacted: no connection, so nothing to leak to.
    // Asserted first, so a regression prints what that host actually received (key redacted).
    const received = JSON.stringify(other.seen).split(KEY).join("<redacted>");
    assert.deepEqual(other.seen, [], `the redirect target must not be contacted at all; it received ${received}`);
    assert.equal(out.search.success, false);
    assert.equal(
      out.search.error,
      "LiteLLM search HTTP 302 (example-search): the request carries the gateway key, so a redirect is refused rather than followed",
    );
    assert.equal(out.search.data, undefined);
    assert.ok(!raw.includes(KEY), "the credential must not appear anywhere in the provider's output");
  } finally { s.close(); other.close(); }
});

test("a page that redirects is refused, not followed off the URL that was checked (review S1)", async () => {
  const other = await decoy();
  const s = await stub({ redirectPageTo: other.base });
  try {
    const { out } = await runProvider({ base: s.base, urls: [`${s.base}/page-redirect`, `${s.base}/page`] });
    const by = Object.fromEntries(out.extract.map((p) => [p.url, p]));
    const received = JSON.stringify(other.seen).split(KEY).join("<redacted>");
    assert.deepEqual(other.seen, [], `the redirect target must never be fetched; it received ${received}`);
    assert.equal(
      by[`${s.base}/page-redirect`].error,
      "fetch HTTP 302: a redirect would move the fetch off the URL that was checked, so it is refused",
    );
    assert.equal(by[`${s.base}/page-redirect`].content, "");
    // a redirecting URL is one URL's problem: the readable one still comes back whole
    assert.ok(by[`${s.base}/page`].content.includes(QUOTED));
  } finally { s.close(); other.close(); }
});

// ---- fetch

test("a chosen result is fetched and its sentence can be quoted, without the key following it", async () => {
  const s = await stub();
  try {
    const { out } = await runProvider({ base: s.base, urls: [`${s.base}/page`] });
    const [page] = out.extract;
    assert.equal(page.url, `${s.base}/page`);
    assert.equal(page.title, "gitcredentials(7)");
    assert.ok(page.content.includes(QUOTED), `page content must let the caller quote the sentence: ${page.content}`);
    assert.equal(page.raw_content, page.content);
    assert.deepEqual(page.metadata, { sourceURL: `${s.base}/page`, title: "gitcredentials(7)" });
    assert.doesNotMatch(page.content, /should not be quoted/); // script/style dropped
    assert.doesNotMatch(page.content, /\.x\{\}/);
    // the gateway key authenticates the gateway, never the page
    assert.deepEqual(s.seen.page, [{ path: "/page", auth: undefined }]);
  } finally { s.close(); }
});

test("fetch failures are per-URL and distinct, and a bad URL does not spoil the others", async () => {
  const s = await stub();
  try {
    const { out } = await runProvider({
      base: s.base,
      urls: [`${s.base}/missing`, `${s.base}/empty`, `${s.base}/scriptonly`, "file:///etc/passwd", `${s.base}/page`],
    });
    const by = Object.fromEntries(out.extract.map((p) => [p.url, p]));
    assert.equal(by[`${s.base}/missing`].error, "fetch HTTP 404");
    assert.equal(by[`${s.base}/empty`].error, "fetch returned an empty body");
    assert.equal(by[`${s.base}/scriptonly`].error, "fetch found no readable text in the response");
    assert.equal(by["file:///etc/passwd"].error, "fetch refused: only http:// and https:// URLs can be fetched");
    assert.deepEqual(Object.keys(by[`${s.base}/missing`]), ["url", "title", "content", "error"]);
    // the readable one still came back whole
    assert.equal(by[`${s.base}/page`].error, undefined);
    assert.ok(by[`${s.base}/page`].content.includes(QUOTED));
  } finally { s.close(); }
});

// ---- fetch: public addresses only

test("a page on a non-public address is refused before anything is sent", async () => {
  const s = await stub();
  try {
    const port = new URL(s.base).port;
    const urls = [
      `${s.base}/page`, `http://localhost:${port}/page`, `http://[::1]:${port}/page`, `http://0x7f.1:${port}/page`,
      "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://100.64.0.1/",
      "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://0.0.0.0/", "http://224.0.0.1/",
    ];
    const { out } = await runProvider({ base: s.base, urls, strict: true });
    for (const page of out.extract) {
      assert.match(page.error, /^fetch refused: .* is not a public address$/, page.url);
      assert.equal(page.content, "");
    }
    assert.deepEqual(s.seen.page, [], "the stub must never be asked for the page");
  } finally { s.close(); }
});

test("the address rule admits global unicast addresses and nothing private or special", async () => {
  const addresses = ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c", "8.8.8.8",
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fe80::1", "fd12::1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "224.0.0.251", "ff02::1", "240.0.0.1"];
  const { out } = await runProvider({ addresses });
  const pub = new Set(["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c", "8.8.8.8", "::ffff:8.8.8.8"]);
  for (const a of addresses) assert.equal(out.allowed[a], pub.has(a), a);
});

// These ranges are refused even where the interpreter would call them global.
test("NAT64, 6to4, Teredo and the IPv4 special ranges are refused on any Python version", async () => {
  const denied = ["64:ff9b::a00:1", "64:ff9b::808:808", "64:ff9b:1::1", "2002:a00:1::1", "2002:808:808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "192.0.0.8", "198.18.0.1", "198.19.255.254", "240.0.0.1", "255.255.255.254", "::ffff:198.18.0.1"];
  const controls = ["8.8.8.8", "2001:4860:4860::8888", "64:ff9a::1", "2003::1", "192.0.1.1", "198.20.0.1", "239.255.255.254"];
  const { out } = await runProvider({ globalProbe: [...denied, ...controls] });
  for (const a of denied) assert.equal(out.forced[a], false, a);
  // A neighbour just outside each range, forced global too, is still admitted: only the listed ranges are refused.
  for (const a of controls) assert.equal(out.forced[a], true, a);
  // And with the interpreter's real tables, every listed range is refused too.
  const real = await runProvider({ addresses: denied });
  for (const a of denied) assert.equal(real.out.allowed[a], false, `real tables: ${a}`);
});

test("an IPv4-mapped IPv6 address is judged by the IPv4 address it carries", async () => {
  const { out } = await runProvider({ mappedProbe: true });
  assert.deepEqual(out.mapped, { private_v4: false, public_v4: true });
});

test("the connection goes to the address that was checked, even when the name answers differently later", async () => {
  const s = await stub();
  try {
    const port = new URL(s.base).port;
    // The stub listens on 127.0.0.1 only; 127.0.0.2 refuses. A second lookup would land there.
    const url = `http://rebind.example:${port}/page`;
    const { out } = await runProvider({ base: s.base, urls: [url], rebind: { host: "rebind.example", first: "127.0.0.1", then: "127.0.0.2" } });
    assert.equal(out.extract[0].error, undefined, JSON.stringify(out.extract[0]));
    assert.ok(out.extract[0].content.includes(QUOTED));
  } finally { s.close(); }
});

// ---- credential hygiene

test("a key the gateway echoes back is redacted, and no key value reaches the result", async () => {
  const s = await stub();
  try {
    const { raw, out } = await runProvider({ base: s.base, search: "leak-key" });
    assert.equal(out.search.success, false);
    assert.equal(out.search.error, "LiteLLM search error (example-search): key <redacted> is not permitted for this tool");
    assert.ok(!raw.includes(KEY), "the credential must not appear anywhere in the provider's output");
  } finally { s.close(); }
});

test("the key the picker advertises wins over the legacy name, and both are named (review O2)", async () => {
  const s = await stub();
  try {
    // Both names set to different values: the advertised one must be the one the gateway sees.
    // Under the previous precedence the request carried the stale legacy value and got a 401.
    const both = await runProvider({
      base: s.base,
      key: "",
      search: "precedence",
      env: { HERMES_PROVIDER_API_KEY: KEY, LITELLM_SEARCH_API_KEY: `${KEY}-stale-legacy` },
    });
    assert.equal(both.out.search.success, true);
    assert.equal(s.seen.search[0].auth, `Bearer ${KEY}`);
    // the legacy name alone still resolves: a profile not yet rendered with the new name works
    const legacyOnly = await runProvider({
      base: s.base,
      key: "",
      search: "precedence",
      env: { LITELLM_SEARCH_API_KEY: KEY },
    });
    assert.equal(legacyOnly.out.search.success, true);
    assert.equal(s.seen.search[1].auth, `Bearer ${KEY}`);
    // the picker prompts for the winning name and names both, in precedence order
    const [envVar] = legacyOnly.out.setup_schema.env_vars;
    assert.equal(envVar.key, "HERMES_PROVIDER_API_KEY");
    assert.ok(
      envVar.prompt.indexOf("HERMES_PROVIDER_API_KEY") < envVar.prompt.indexOf("LITELLM_SEARCH_API_KEY"),
      `the prompt must name both names in precedence order: ${envVar.prompt}`,
    );
  } finally { s.close(); }
});

// ---- no built-in gateway; the URL and tool come from the user's config

test("with no gateway configured, search says so and contacts no host", async () => {
  const s = await stub();
  try {
    const NOT_CONFIGURED = /^LiteLLM search is not configured: set VBCDX_AGENTS_HERMES_WEB_SEARCH_URL and VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL/;
    // The shipped asset, never rendered, with neither override: no host to call.
    const none = await runProvider({ tool: "", search: "anything" });
    assert.equal(none.out.search.success, false);
    assert.match(none.out.search.error, NOT_CONFIGURED);
    // A URL but no tool, and a tool but no URL: both refused before any request.
    const noTool = await runProvider({ base: s.base, tool: "", search: "anything" });
    assert.match(noTool.out.search.error, NOT_CONFIGURED);
    const noBase = await runProvider({ search: "anything" });
    assert.match(noBase.out.search.error, NOT_CONFIGURED);
    assert.equal(s.seen.search.length, 0, "the gateway was never contacted");
    // The picker names no host it was not given.
    assert.equal(none.out.setup_schema.env_vars[0].url, undefined);
    assert.doesNotMatch(none.raw, new RegExp(KEY));
  } finally { s.close(); }
});

test("a non-finite limit falls back to the default, never raising into the agent", async () => {
  const s = await stub();
  try {
    for (const limit of [Infinity, -Infinity, NaN]) {
      const { out } = await runProvider({ base: s.base, search: "git credential helper", limit });
      assert.equal(out.search.success, true, `${limit}: ${JSON.stringify(out.search)}`);
      assert.equal(s.seen.search.at(-1).max_results, 5, `${limit}`);
    }
  } finally { s.close(); }
});

test("an override in the profile's .env is held to the installer's rules", async () => {
  const s = await stub();
  try {
    for (const [base, tool, why] of [
      [s.base, "../../admin", /tool name is invalid/],
      [s.base, "a/b", /tool name is invalid/],
      [s.base, ".hidden", /tool name is invalid/],
      ["ftp://gateway.example.com", "example-search", /base is invalid: it must be an absolute http\(s\) URL/],
      ["gateway.example.com", "example-search", /base is invalid: it must be an absolute http\(s\) URL/],
      [s.base.replace("://", "://user:pass@"), "example-search", /must not embed credentials/],
      // JS new URL() rejects a space in the authority; urlsplit tolerates it.
      ["http://exa mple.com", "example-search", /no spaces or control characters/],
      // JS new URL() rejects an out-of-range port; urlsplit().port raises.
      ["http://gateway.example.com:99999", "example-search", /port is not a valid port number/],
    ]) {
      const { out, raw } = await runProvider({ base, tool, search: "anything" });
      assert.equal(out.search.success, false, `${base} ${tool}`);
      assert.match(out.search.error, why, `${base} ${tool}`);
      assert.doesNotMatch(raw, /pass@/, "the base's credentials are not echoed");
    }
    assert.equal(s.seen.search.length, 0, "no refused override reaches the gateway");
  } finally { s.close(); }
});

test("a rendered copy searches the user's gateway and tool; the profile's .env overrides them", async () => {
  const s = await stub();
  const other = await stub();
  try {
    const dir = tmp("web-provider-rendered-");
    const [, init] = renderHermesWebSearchPlugin({ baseUrl: s.base, tool: "rendered-tool" });
    writeFileSync(join(dir, "__init__.py"), init.content);
    const rendered = await runProvider({ plugin: join(dir, "__init__.py"), tool: "", search: "git credential helper" });
    assert.equal(rendered.out.search.success, true);
    assert.equal(s.seen.search.length, 1);
    assert.equal(s.seen.search[0].tool, "rendered-tool");
    assert.equal(rendered.out.setup_schema.env_vars[0].url, s.base);
    const overridden = await runProvider({ plugin: join(dir, "__init__.py"), base: other.base, tool: "env-tool", search: "git credential helper" });
    assert.equal(overridden.out.search.success, true);
    assert.equal(s.seen.search.length, 1, "the rendered gateway is not called when the .env overrides it");
    assert.equal(other.seen.search[0].tool, "env-tool");
  } finally { s.close(); other.close(); }
});
