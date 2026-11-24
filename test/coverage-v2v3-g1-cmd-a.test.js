// Installer coverage, second batch, group 1: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { frontmatter, catalogueSkills, installSkill } from "../src/install/commands.js";
import { resolveContext } from "../src/install/context.js";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";

describe("src/install/commands.js coverage, part 1", () => {
  function ctxFor(harness, home) {
    return resolveContext({ harness, scope: "user", envPath: null, home, cwd: home, env: {} });
  }

  function firstInstallableSkill() {
    return catalogueSkills().find(
      (s) =>
        typeof s.name === "string" &&
        /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.name) &&
        typeof s.description === "string" &&
        s.description !== "",
    );
  }

  // src/install/commands.js 217
  test("frontmatter: content without a delimited block has no frontmatter", () => {
    assert.deepEqual(frontmatter("# Title\n\nJust markdown, no frontmatter block.\n"), {});
    assert.deepEqual(frontmatter("no delimiters at all"), {});
    assert.deepEqual(frontmatter(""), {});
  });

  // src/install/commands.js 220
  test("frontmatter: a scalar YAML body is not an object, so the result is empty", () => {
    assert.deepEqual(frontmatter("---\nhello world\n---\nbody\n"), {});
    assert.deepEqual(frontmatter('---\n"a quoted scalar"\n---\n'), {});
  });

  // src/install/commands.js 221
  test("frontmatter: an unparseable YAML body yields empty rather than throwing", () => {
    assert.deepEqual(frontmatter("---\nkey: [unterminated\n---\nbody\n"), {});
  });

  // src/install/commands.js 241
  test("installSkill: an unknown skill names the catalogue by installable stem", () => {
    const skills = catalogueSkills();
    assert.ok(skills.length > 0, "the catalogue ships skills");
    const home = tempDir("vbcdx-cov-cmd-");
    const ctx = ctxFor("opencode", home);
    const stem = skills[0].stem.toLowerCase();
    assert.throws(
      () => installSkill(ctx, "zzz-not-a-catalogue-skill"),
      (err) => {
        assert.match(err.message, /^Unknown skill /);
        assert.match(err.message, /Available: /);
        assert.doesNotMatch(err.message, /Available: none\./);
        assert.ok(err.message.includes(stem), `expected the known list to contain ${stem}: ${err.message}`);
        return true;
      },
    );
  });

  // src/install/commands.js 264
  test("installSkill: a dry run reports the plan and writes nothing", () => {
    const skill = firstInstallableSkill();
    assert.ok(skill, "the catalogue ships an installable skill");
    const home = tempDir("vbcdx-cov-cmd-");
    const ctx = ctxFor("opencode", home);
    const report = installSkill(ctx, skill.name, { dryRun: true });
    assert.equal(report.kind, "skill");
    assert.equal(report.skill, skill.name);
    assert.equal(report.dryRun, true);
    assert.notEqual(report.action, "conflict");
    assert.equal(existsSync(report.file), false);
  });

  // src/install/commands.js 259
  test("installSkill: an edited destination is a conflict, dry run reports the note, force replaces it", () => {
    const skill = firstInstallableSkill();
    assert.ok(skill, "the catalogue ships an installable skill");
    const home = tempDir("vbcdx-cov-cmd-");
    const ctx = ctxFor("opencode", home);
    const report = installSkill(ctx, skill.name);
    assert.equal(report.kind, "skill");
    assert.ok(existsSync(report.file), "install should have written the skill file");
    appendFileSync(report.file, "\n<!-- edited outside the installer -->\n");

    const note = "it was modified outside the installer or is not package-owned; rerun with --force to replace it";
    const dry = installSkill(ctx, skill.name, { dryRun: true });
    assert.equal(dry.conflict, note);
    assert.equal(dry.action, "conflict");

    assert.throws(
      () => installSkill(ctx, skill.name),
      (err) => {
        assert.ok(err.message.includes(note), `expected the conflict note in: ${err.message}`);
        return true;
      },
    );

    const forced = installSkill(ctx, skill.name, { force: true });
    assert.equal(forced.action, "forced");
    assert.equal(readFileSync(forced.file, "utf8"), skill.content);
  });
});
