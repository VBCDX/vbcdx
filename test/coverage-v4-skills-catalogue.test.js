// The skills catalogue is built by walking each pack's skills tree once. These
// tests call the builder directly with a pack-shaped object (it reads only
// `name` and `skillsDir`) and a small tree, one case per path that is skipped or
// ordered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSkillCatalogue } from "../src/skills/catalogue.js";
import { tempDir } from "./helpers/temp-dir.js";

const packAt = (skillsDir) => ({ name: "coverage-pack", skillsDir });

test("an entry that is not a skill file name is skipped", () => {
  const root = tempDir("vbcdx-cov-catalogue-");
  const dir = join(root, "development");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "RELEASE-NOTES.MD"), "# notes\n");
  writeFileSync(join(dir, "notes.txt"), "not a skill\n");
  const catalogue = buildSkillCatalogue([packAt(root)]);
  assert.deepEqual([...catalogue.bySlug.get("development").skills.keys()], ["RELEASE-NOTES.MD"]); // src/skills/catalogue.js:76
  assert.equal(catalogue.documents.size, 0);
});

test("a directory named like a skill file is skipped", () => {
  const root = tempDir("vbcdx-cov-catalogue-");
  const dir = join(root, "development");
  mkdirSync(join(dir, "FOLDER.MD"), { recursive: true });
  writeFileSync(join(dir, "REAL.MD"), "# real\n");
  const catalogue = buildSkillCatalogue([packAt(root)]);
  assert.deepEqual([...catalogue.bySlug.get("development").skills.keys()], ["REAL.MD"]); // src/skills/catalogue.js:78
});

test("a directory named like a top-level document is skipped", () => {
  const root = tempDir("vbcdx-cov-catalogue-");
  mkdirSync(join(root, "README.md"), { recursive: true });
  writeFileSync(join(root, "GUIDE.md"), "# guide\n");
  const catalogue = buildSkillCatalogue([packAt(root)]);
  assert.deepEqual([...catalogue.documents.keys()], ["GUIDE.md"]); // src/skills/catalogue.js:87
});

test("skills and documents are sorted by file name", () => {
  const root = tempDir("vbcdx-cov-catalogue-");
  const dir = join(root, "development");
  mkdirSync(dir, { recursive: true });
  // Written in ascending order so a reading that preserves creation order hands
  // the sort an ascending run: the binary-insertion path then compares a later
  // element against an earlier one, which is the branch under test.
  const skills = ["ALPHA.MD", "ECHO.MD", "MIKE.MD", "QUEBEC.MD", "ZULU.MD"];
  for (const name of skills) writeFileSync(join(dir, name), `# ${name}\n`);
  const documents = ["AARDVARK.md", "BADGER.md", "COYOTE.md", "DONKEY.md", "EAGLE.md"];
  for (const name of documents) writeFileSync(join(root, name), `# ${name}\n`);
  const catalogue = buildSkillCatalogue([packAt(root)]);
  assert.deepEqual([...catalogue.bySlug.get("development").skills.keys()], skills); // src/skills/catalogue.js:92
  assert.deepEqual([...catalogue.documents.keys()], documents);
});
