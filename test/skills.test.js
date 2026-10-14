import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/a2a/server.js";
import { CATEGORIES, allDocuments } from "../src/skills/catalogue.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const BASE = "https://agents.example";
let server;
let origin;

before(async () => {
  server = createServer({ configuredBaseUrl: BASE });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function req(path, method = "GET") {
  const res = await fetch(`${origin}${path}`, { method });
  const contentType = res.headers.get("content-type") || "";
  let body = null;
  const text = await res.text();
  if (text && contentType.includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, contentType, body, text, headers: res.headers };
}

test("GET /skills/ lists all eight categories plus documents", async () => {
  const r = await req("/skills/");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /^application\/json/);
  assert.equal(r.body.categories.length, 8);
  const slugs = r.body.categories.map((c) => c.slug);
  assert.deepEqual(slugs, CATEGORIES.map((c) => c.slug));
  // Development holds the fixture pack's skill; the catalogue is discoverable.
  const dev = r.body.categories.find((c) => c.slug === "development");
  assert.equal(dev.count, 1);
  assert.equal(dev.url, `${BASE}/skills/development/`);
  // The context template is a top-level document.
  assert.ok(r.body.documents.some((d) => d.file === "CONTEXT.example.md"));
  // Alias without the trailing slash.
  const alias = await req("/skills");
  assert.equal(alias.status, 200);
  assert.deepEqual(alias.body, r.body);
});

test("GET /skills/development/ indexes the category's skills", async () => {
  const r = await req("/skills/development/");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /^application\/json/);
  assert.equal(r.body.category.slug, "development");
  assert.equal(r.body.category.name, "Development");
  const s = r.body.skills.find((x) => x.file === "WRITING-NOTES.MD");
  assert.ok(s, "WRITING-NOTES.MD should be listed");
  assert.equal(s.name, "WRITING-NOTES");
  assert.equal(s.url, `${BASE}/skills/development/WRITING-NOTES.MD`);
  // No-slash form serves the same index.
  const noSlash = await req("/skills/development");
  assert.equal(noSlash.status, 200);
  assert.deepEqual(noSlash.body, r.body);
});

test("an empty category still indexes (discoverable), with zero skills", async () => {
  const r = await req("/skills/testing/");
  assert.equal(r.status, 200);
  assert.equal(r.body.category.slug, "testing");
  assert.deepEqual(r.body.skills, []);
});

test("GET /skills/development/WRITING-NOTES.MD serves the document as markdown", async () => {
  const r = await req("/skills/development/WRITING-NOTES.MD");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /^text\/markdown; charset=utf-8/);
  assert.match(r.text, /^---\nname: writing-notes-example\n/);
  assert.match(r.text, /# Writing notes/);
});

test("GET /skills/CONTEXT.example.md serves the context template", async () => {
  const r = await req("/skills/CONTEXT.example.md");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /^text\/markdown; charset=utf-8/);
  assert.match(r.text, /Context template/i);
});

test("unknown category and unknown skill both 404", async () => {
  const unknownCat = await req("/skills/nope/");
  assert.equal(unknownCat.status, 404);
  const unknownSkill = await req("/skills/development/NOT-A-SKILL.MD");
  assert.equal(unknownSkill.status, 404);
  assert.equal(unknownSkill.body.error, "not_found");
});

test("wrong casing 404s — the router is case-sensitive to the canonical form", async () => {
  for (const path of [
    "/skills/Development/WRITING-NOTES.MD",
    "/skills/development/vbcdx-issues.md",
    "/skills/development/WRITING-NOTES.md",
  ]) {
    const r = await req(path);
    assert.equal(r.status, 404, `expected 404 for ${path}, got ${r.status}`);
  }
});

test("path traversal cannot serve an arbitrary file (encoded and raw forms)", async () => {
  // The invariant: no hostile path ever serves a file from outside the built
  // manifest. Most vectors keep their bogus segment (encoded slash/backslash,
  // null byte, over-long) and 404 on the manifest miss. A couple are collapsed
  // by WHATWG dot-segment normalization BEFORE the handler runs — e.g.
  // ".../%2e%2e" becomes "/skills/" (the index) and "/skills/%2e%2e/%2e%2e/etc/passwd"
  // becomes "/etc/passwd" (an unmatched path, 404). Both are safe: neither
  // serves an arbitrary file. So we accept a 404 OR a 200 that is one of our
  // known JSON index shapes, and in every case assert nothing leaked.
  const attacks = [
    "/skills/development/..%2f..%2f..%2fetc%2fpasswd",
    "/skills/development/%2e%2e%2f%2e%2e%2fpackage.json",
    "/skills/%2e%2e%2f%2e%2e%2fetc/passwd",
    "/skills/..%2f..%2fpackage.json",
    "/skills/development/%2e%2e",
    "/skills/development/....%2f....%2fpackage.json",
    "/skills/development/WRITING-NOTES.MD%00",
    "/skills/%2Fetc%2Fpasswd",
    "/skills/development/..%5c..%5cwindows",
    "/skills/development/" + "A".repeat(5000) + ".MD",
    "/skills/%2e%2e/%2e%2e/etc/passwd",
  ];
  for (const path of attacks) {
    const r = await req(path);
    if (r.status !== 404) {
      assert.equal(r.status, 200, `unexpected status for ${path}`);
      assert.match(r.contentType, /^application\/json/, `served non-index for ${path}`);
      // A 200 is only acceptable if it is one of our JSON index shapes, never a file.
      assert.ok(
        r.body && (Array.isArray(r.body.categories) || r.body.category),
        `served something other than a catalogue index for ${path}`,
      );
    }
    // Never leak file contents: package.json has this key, /etc/passwd has "root:...:0:0:".
    assert.ok(!r.text.includes("\"dependencies\""), `leaked package.json for ${path}`);
    assert.ok(!/root:.*:0:0:/.test(r.text), `leaked /etc/passwd for ${path}`);
  }
});

test("a malformed percent-escape in a /skills segment returns 404, not a crash", async () => {
  const r = await req("/skills/development/%zz.MD");
  assert.equal(r.status, 404);
  const r2 = await req("/skills/%zz/");
  assert.equal(r2.status, 404);
});

test("non-GET on a /skills path is 405 with an Allow header", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await req("/skills/development/WRITING-NOTES.MD", method);
    assert.equal(r.status, 405, `${method} should be 405`);
    assert.match(r.headers.get("allow") || "", /GET/);
  }
});

test("HEAD on a skill document returns headers with no body", async () => {
  const r = await req("/skills/development/WRITING-NOTES.MD", "HEAD");
  assert.equal(r.status, 200);
  assert.match(r.contentType, /^text\/markdown; charset=utf-8/);
  assert.equal(r.text, "");
});

test("allDocuments() covers every served document and matches the tree", () => {
  const docs = allDocuments();
  // The fixture pack's skill and its context template are both served.
  assert.ok(docs.some((d) => d.relPath === "development/WRITING-NOTES.MD"));
  assert.ok(docs.some((d) => d.relPath === "CONTEXT.example.md"));
});
