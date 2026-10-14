import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as yamlParse } from "yaml";
import { parse as tomlParse } from "smol-toml";
import { getRole, allRoles } from "../src/roles/index.js";
import { renderClaude } from "../src/renderers/claude.js";
import { renderCodex } from "../src/renderers/codex.js";
import { renderOpencode } from "../src/renderers/opencode.js";
import { renderHermes } from "../src/renderers/hermes.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

function splitFrontmatter(md) {
  assert.ok(md.startsWith("---\n"), "starts with frontmatter");
  const end = md.indexOf("\n---\n", 4);
  assert.ok(end > 0, "frontmatter closes");
  return { fm: yamlParse(md.slice(4, end)), body: md.slice(end + 5) };
}

test("Claude renders valid frontmatter for every role", () => {
  for (const id of FIXTURE_IDS) {
    const out = renderClaude(getRole(id));
    const { fm, body } = splitFrontmatter(out.content);
    assert.equal(fm.name, id);
    assert.ok(fm.description.length > 0);
    assert.equal(fm.model, "inherit");
    assert.match(fm.tools, /Read/);
    assert.ok(body.includes("You are"));
  }
});

test("Claude tool list reflects filesystem/shell/web/delegation capabilities", () => {
  const code = splitFrontmatter(renderClaude(getRole("code-agent")).content).fm.tools;
  assert.match(code, /Write/); // read-write
  assert.match(code, /Bash/); // shell
  assert.doesNotMatch(code, /WebFetch/); // code-agent web:false
  const review = splitFrontmatter(renderClaude(getRole("review-agent")).content).fm.tools;
  assert.doesNotMatch(review, /\bWrite\b/); // inspector: read-only
  assert.match(review, /WebFetch/); // web:true
  const pm = splitFrontmatter(renderClaude(getRole("pm-agent")).content).fm.tools;
  assert.match(pm, /Agent/); // delegation:true
});

test("OpenCode renders mode and a permission map for every role", () => {
  for (const id of FIXTURE_IDS) {
    const { fm } = splitFrontmatter(renderOpencode(getRole(id)).content);
    assert.ok(["all", "primary"].includes(fm.mode));
    assert.equal(fm.permission.read, "allow");
  }
  const ro = splitFrontmatter(renderOpencode(getRole("review-agent")).content).fm;
  assert.equal(ro.permission.edit, "deny");
  assert.equal(ro.permission.bash, "allow");
  const rw = splitFrontmatter(renderOpencode(getRole("code-agent")).content).fm;
  assert.equal(rw.permission.edit, "allow");
  assert.equal(rw.permission.webfetch, "deny");
});

test("Codex renders valid TOML with sandbox_mode and developer_instructions", () => {
  for (const id of FIXTURE_IDS) {
    const doc = tomlParse(renderCodex(getRole(id)).content);
    assert.equal(doc.name, id);
    assert.ok(doc.developer_instructions.includes("You are"));
    assert.ok(["read-only", "workspace-write"].includes(doc.sandbox_mode));
  }
  assert.equal(tomlParse(renderCodex(getRole("code-agent")).content).sandbox_mode, "workspace-write");
  assert.equal(tomlParse(renderCodex(getRole("review-agent")).content).sandbox_mode, "read-only");
});

test("bound service tools render only when an integration maps the role", () => {
  const integrations = {
    services: {
      forgejo: {
        serverName: "forgejo",
        tools: ["whoami", "create_comment", "merge_pull_request"],
        credentials: { "code-agent": "/abs/creds/code-agent.env" },
      },
    },
  };
  const out = renderClaude(getRole("code-agent"), { integrations });
  assert.match(out.content, /mcp__forgejo__whoami/);
  assert.match(out.content, /mcp__forgejo__create_comment/);
  // code-agent has no merge_pull_request in its allowlist -> not bound even if in manifest
  assert.doesNotMatch(out.content, /mcp__forgejo__merge_pull_request/);
  assert.match(out.content, /credential_file="\/abs\/creds\/code-agent.env"/);
  // A role with no mapping gets no binding note.
  const pm = renderClaude(getRole("pm-agent"), { integrations });
  assert.doesNotMatch(pm.content, /Bound service credentials/);
});

test("no rendered definition leaks a forbidden infra token", () => {
  const roles = [...allRoles().values()];
  for (const role of roles) {
    for (const out of [renderClaude(role), renderCodex(role), renderOpencode(role), ...renderHermes(role).files]) {
      assert.doesNotMatch(out.content, /CODE_HOST_/);
    }
  }
});


// Every renderer passes the role's prompt through as written: the opening line and the
// whole body, with no harness-specific rewriting of the text.
test("every renderer carries the role's prompt unchanged, for every role", () => {
  for (const id of FIXTURE_IDS) {
    const role = getRole(id);
    const prompt = role.prompt.trimEnd();
    const outputs = {
      claude: renderClaude(role).content,
      codex: tomlParse(renderCodex(role).content).developer_instructions,
      opencode: renderOpencode(role).content,
      hermes: renderHermes(role).files.find((f) => f.name === "SOUL.md").content,
    };
    for (const [harness, text] of Object.entries(outputs)) assert.ok(text.includes(prompt), `${id} / ${harness}`);
  }
});
