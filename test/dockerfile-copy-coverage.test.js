// Guard: the Dockerfile must place every file the A2A server entrypoint reaches
// through its relative import graph at the exact path it is imported from inside
// the image.
//
// Why this exists (issues): Docker never resolves JavaScript imports, so
// a COPY set that omits a needed source — or lands it at the wrong destination —
// still builds cleanly. The fault only surfaces when Node tries to resolve the
// module at boot and the container exits. That is how an earlier change shipped a server
// that imported `../skills/catalogue.js` while the Dockerfile copied only
// `src/a2a`, `src/roles`, and `assets/roles` (a missing *source*); a mistyped
// *destination* (`COPY src/skills ./src/WRONGDEST`) is the same boot failure via a
// different typo. Nothing in CI builds and runs the image (no Docker daemon
// on the runners), so this guard is the only line
// of defence for both classes.
//
// The earlier version of this guard matched COPY *source* strings only, so it was
// blind to wrong destinations: the source was still listed, so it stayed green
// while the image was broken. This version models each COPY's source -> destination
// mapping (applying WORKDIR) the way Docker's builder does, then resolves the
// entrypoint's import graph against the resulting *in-image* paths. An imported
// file is "covered" only when some COPY actually produces it at the path it is
// imported from — which catches missing sources and wrong destinations alike.
//
// Node builtins (`node:*`) and bare package specifiers are out of scope — only
// relative imports can be missing from the image. Runtime data directories read
// via `fs` (schema/, and the agent packs copied to node_modules/) are not imports
// and are intentionally NOT checked here; they are covered by their own COPY lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, posix } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The container's entrypoint, relative to WORKDIR, matching the Dockerfile's CMD
// (`node bin/a2a-server.js`).
const ENTRYPOINT = "bin/a2a-server.js";

// Parse the Dockerfile into its effective WORKDIR and the ordered list of COPY
// directives. A COPY line is `COPY <flags...> <src...> <dest>`; the destination is
// the last non-flag token, the rest are sources. Flags (`--chown`, `--from`) begin
// with "--"; they are separated out (not dropped) so assertModelledCopyForms can
// reject a flag the source->destination model does not implement.
function parseDockerfile(text) {
  let workdir = "/"; // Docker's default working directory.
  const copies = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const wd = line.match(/^WORKDIR\s+(\S+)/i);
    if (wd) {
      workdir = posix.resolve(workdir, wd[1]);
      continue;
    }
    if (!/^COPY\b/i.test(line)) continue;
    const allTokens = line.slice("COPY".length).trim().split(/\s+/);
    const flags = allTokens.filter((t) => t.startsWith("--"));
    const tokens = allTokens.filter((t) => !t.startsWith("--"));
    if (tokens.length < 2) continue; // need at least one source + a dest
    copies.push({ flags, sources: tokens.slice(0, -1), dest: tokens[tokens.length - 1] });
  }
  return { workdir, copies };
}

// Precondition: buildMappings models only the COPY destination forms
// the shipped Dockerfile actually uses. A future edit that introduces a form the
// model does not implement would otherwise be silently mis-mapped — worst case a
// FALSE NEGATIVE (guard green while the image is broken). Detect and REJECT those
// forms loudly here instead of guessing. Deliberately small: a boundary assertion,
// not a second Docker builder. The forms rejected, and why each breaks the model:
//   - `--from=<stage>`: buildMappings resolves every source against the build
//     context on disk; a stage artifact does not exist there, so it cannot model
//     a multi-stage copy.
//   - glob/wildcard source (`*`, `?`, `[]`): treated as a literal path, never
//     expanded, so a matched set would be silently under-modelled.
//   - a single file copied to a plain (no trailing slash) destination that a prior
//     COPY already created as a directory: Docker copies the file INTO it
//     (dest/basename), but buildMappings models a rename to exactly that path — the
//     one orientation that can flip a real breakage to green.
function assertModelledCopyForms({ workdir, copies }) {
  const copyDirs = new Set(); // in-image paths a prior COPY established as a directory
  for (const { flags, sources, dest } of copies) {
    const from = flags.find((f) => /^--from(=|$)/i.test(f));
    if (from) {
      throw new Error(
        `Dockerfile uses a COPY form the coverage model does not handle: multi-stage "${from}". ` +
          `buildMappings resolves sources against the build context only — extend it to model ` +
          `stage artifacts before shipping a multi-stage COPY.`
      );
    }
    for (const src of sources) {
      if (/[*?[\]]/.test(src)) {
        throw new Error(
          `Dockerfile uses a COPY form the coverage model does not handle: glob/wildcard source "${src}". ` +
            `buildMappings treats each source as a literal path and does not expand globs.`
        );
      }
    }
    const destAbs = posix.resolve(workdir, dest);
    const destIsDir = dest.endsWith("/") || sources.length > 1;
    if (!destIsDir && sources.length === 1 && copyDirs.has(destAbs)) {
      throw new Error(
        `Dockerfile uses a COPY form the coverage model does not handle: file "${sources[0]}" copied to ` +
          `"${dest}", a destination a prior COPY already created as a directory. Docker copies the file ` +
          `into that directory (${dest}/basename); the model would read it as a rename to exactly that ` +
          `path — a false negative. Model this form before shipping it.`
      );
    }
    // Record the directory destinations this COPY establishes, for the collision
    // check on later directives: an explicit directory dest (trailing slash or
    // multi-source) or a directory source (its contents land under destAbs).
    if (destIsDir) copyDirs.add(destAbs);
    for (const src of sources) {
      const srcAbsRepo = join(ROOT, src);
      if (existsSync(srcAbsRepo) && statSync(srcAbsRepo).isDirectory()) copyDirs.add(destAbs);
    }
  }
}

// Model each COPY's source -> destination mapping as Docker's builder resolves it,
// for the subset of destination forms this Dockerfile uses:
//   - The destination is resolved relative to WORKDIR when not absolute.
//   - A *directory* source has its contents copied into the destination, which is
//     treated as a directory:  COPY src/a2a ./src/a2a  =>  /app/src/a2a/<rel>.
//   - A *file* source with a destination ending in "/" (or with multiple sources,
//     where the destination must be a directory) lands under that directory by
//     basename:  COPY package.json ./  =>  /app/package.json.
//   - A *file* source with a plain destination is renamed to exactly that path:
//     COPY bin/a2a-server.js ./bin/a2a-server.js  =>  /app/bin/a2a-server.js.
// Returns a list of { srcRepo, ...imageTarget } entries; a directory entry maps a
// whole subtree (imageDir), a file entry maps a single path (imagePath).
function buildMappings({ workdir, copies }) {
  const mappings = [];
  for (const { sources, dest } of copies) {
    const destAbs = posix.resolve(workdir, dest);
    const destIsDir = dest.endsWith("/") || sources.length > 1;
    for (const src of sources) {
      const srcAbsRepo = join(ROOT, src);
      const srcIsDir = existsSync(srcAbsRepo) && statSync(srcAbsRepo).isDirectory();
      if (srcIsDir) {
        mappings.push({ kind: "dir", srcRepo: src, imageDir: destAbs });
      } else if (destIsDir) {
        mappings.push({
          kind: "file",
          srcRepo: src,
          imagePath: posix.join(destAbs, posix.basename(src)),
        });
      } else {
        mappings.push({ kind: "file", srcRepo: src, imagePath: destAbs });
      }
    }
  }
  return mappings;
}

// Map an in-image path back to the repo file that produces it, or null if no COPY
// puts a file there. Directory mappings cover any path under their destination;
// the underlying repo file must still exist (a subtree COPY only ships the files
// that are actually present in the source), so we verify it is a real file.
function imageToRepoFile(imagePath, mappings) {
  for (const m of mappings) {
    let repo = null;
    if (m.kind === "file") {
      if (imagePath === m.imagePath) repo = m.srcRepo;
    } else {
      const prefix = m.imageDir + "/";
      if (imagePath.startsWith(prefix)) repo = posix.join(m.srcRepo, imagePath.slice(prefix.length));
    }
    if (repo) {
      const abs = join(ROOT, repo);
      if (existsSync(abs) && statSync(abs).isFile()) return repo;
    }
  }
  return null;
}

// Every relative specifier imported (statically or dynamically) by a file. A
// regex is sufficient and robust to multi-line import groups, since the
// `from "..."` / `import("...")` clause is what identifies the target.
function relativeImports(sourceText) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
    /\bimport\s+["']([^"']+)["']/g, // side-effect import "x"
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(sourceText)) !== null) {
      if (m[1].startsWith(".")) specs.add(m[1]);
    }
  }
  return [...specs];
}

// Resolve a relative specifier to its in-image target the way Node's ESM loader
// does: exactly the path it spells, extension included. Node does NOT append `.js`
// nor try `<dir>/index.js` for relative specifiers — that is CommonJS behaviour.
// Modelling only this form is deliberate: an extensionless relative
// import that would throw ERR_MODULE_NOT_FOUND at runtime must resolve to a path
// no COPY produces, so it is flagged rather than silently matched against a
// same-named `.js` file that happens to be copied.
function resolveEsmTarget(importerImagePath, spec) {
  return posix.resolve(posix.dirname(importerImagePath), spec);
}

// Walk the transitive relative-import graph from the entrypoint in image space.
// Returns the repo files reached (for the sanity check) and the list of imports
// whose in-image target no COPY produces.
function importGraph(entryImage, mappings) {
  const seen = new Set(); // in-image paths visited
  const reachedRepo = new Set(); // repo files reached
  const missing = []; // { importer, spec, target }
  const stack = [entryImage];
  while (stack.length) {
    const img = stack.pop();
    if (seen.has(img)) continue;
    seen.add(img);
    const repo = imageToRepoFile(img, mappings);
    if (!repo) {
      // Only the entrypoint can reach this branch — every other node is pushed
      // only after it is confirmed produced. So the entrypoint itself is absent
      // from the image.
      assert.fail(`in-image path ${img} is not produced by any COPY directive`);
    }
    reachedRepo.add(repo);
    for (const spec of relativeImports(readFileSync(join(ROOT, repo), "utf8"))) {
      const target = resolveEsmTarget(img, spec);
      if (imageToRepoFile(target, mappings)) {
        stack.push(target);
      } else {
        missing.push({ importer: img, spec, target });
      }
    }
  }
  return { seen, reachedRepo, missing };
}

// Compose the model from a Dockerfile's text: parse, map, and pick the in-image
// entrypoint path.
function modelFrom(dockerfileText) {
  const parsed = parseDockerfile(dockerfileText);
  assertModelledCopyForms(parsed); // fail loudly on a form buildMappings can't model
  const mappings = buildMappings(parsed);
  const entryImage = posix.resolve(parsed.workdir, ENTRYPOINT);
  return { mappings, entryImage };
}

const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");

test("Dockerfile places the entrypoint's import graph at resolvable in-image paths", () => {
  const { mappings, entryImage } = modelFrom(DOCKERFILE);
  const { reachedRepo, missing } = importGraph(entryImage, mappings);

  const report = missing
    .map(
      (m) =>
        `  ${m.importer} imports ${JSON.stringify(m.spec)} -> ${m.target} (no COPY produces this in-image path)`
    )
    .sort();
  assert.deepEqual(
    report,
    [],
    `The Dockerfile does not place every file the entrypoint imports at the path it is imported from:\n${report.join(
      "\n"
    )}\nCOPY destinations produced:\n${mappings
      .map((m) =>
        m.kind === "dir" ? `  ${m.imageDir}/ (from ${m.srcRepo}/)` : `  ${m.imagePath} (from ${m.srcRepo})`
      )
      .join("\n")}`
  );

  // Sanity: with nothing missing, the walk must still have descended past the
  // entrypoint through real import edges — otherwise a broken walker (a regex or
  // parse bug) would let the coverage check pass vacuously. On a correct
  // Dockerfile every reached file is covered, so these are all present.
  assert.ok(
    reachedRepo.has("src/a2a/server.js") &&
      reachedRepo.has("src/skills/catalogue.js") &&
      reachedRepo.has("src/roles/registry.js"),
    `import walk did not reach expected modules; reached: ${[...reachedRepo].sort().join(", ")}`
  );
});

test("guard catches a wrong COPY destination (correct source, wrong target path)", () => {
  // The exact reproduction from The skills source is still copied, only
  // its destination is wrong, so a source-string check would stay green.
  const broken = DOCKERFILE.replace("COPY src/skills ./src/skills", "COPY src/skills ./src/WRONGDEST");
  assert.notEqual(broken, DOCKERFILE, "fixture precondition: the skills COPY line must exist to be rewritten");
  const { mappings, entryImage } = modelFrom(broken);
  const { missing } = importGraph(entryImage, mappings);
  assert.ok(
    missing.some((m) => m.target.endsWith("/src/skills/catalogue.js")),
    `a wrong skills destination must be reported as an unproduced in-image path; got: ${JSON.stringify(missing)}`
  );
});

test("guard catches a removed COPY source (the missing-source class, no regression)", () => {
  const broken = DOCKERFILE.replace(/^COPY src\/skills .*$/m, "# (skills COPY removed for the test)");
  assert.notEqual(broken, DOCKERFILE, "fixture precondition: the skills COPY line must exist to be removed");
  const { mappings, entryImage } = modelFrom(broken);
  const { missing } = importGraph(entryImage, mappings);
  assert.ok(
    missing.some((m) => m.target.endsWith("/src/skills/catalogue.js")),
    `a removed skills COPY must be reported as an unproduced in-image path; got: ${JSON.stringify(missing)}`
  );
});

test("resolver matches Node ESM: an extensionless relative import is not silently covered", () => {
  const { mappings } = modelFrom(DOCKERFILE);
  // Node's ESM loader requires the exact path with extension; it does not append
  // `.js`. An extensionless specifier must therefore resolve to a path no COPY
  // produces (the file on disk is `catalogue.js`, the import asked for `catalogue`).
  const bare = resolveEsmTarget("/app/src/a2a/server.js", "../skills/catalogue");
  assert.equal(bare, "/app/src/skills/catalogue", "resolver must not append .js");
  assert.equal(
    imageToRepoFile(bare, mappings),
    null,
    "an extensionless import must NOT be matched against the copied catalogue.js"
  );
  // The extensioned specifier the code actually uses is produced, as a control.
  const good = resolveEsmTarget("/app/src/a2a/server.js", "../skills/catalogue.js");
  assert.equal(imageToRepoFile(good, mappings), "src/skills/catalogue.js");
});

test("the shipped Dockerfile stays within the modelled COPY subset — read from disk, not a fixture", () => {
  // A guard can be right about its in-memory fixture and wrong about the file that
  // ships, so this proof reads the real Dockerfile off disk and runs the precondition
  // against it. modelFrom calls assertModelledCopyForms; a clean pass is the control
  // for the failure proofs below.
  const onDisk = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  assert.doesNotThrow(() => modelFrom(onDisk), "the shipped Dockerfile must stay within the modelled subset");
});

test("guard rejects a multi-stage COPY --from — an unmodelled form fails loudly", () => {
  const broken = DOCKERFILE.replace("COPY src/a2a ./src/a2a", "COPY --from=builder /out/src/a2a ./src/a2a");
  assert.notEqual(broken, DOCKERFILE, "fixture precondition: the a2a COPY line must exist to be rewritten");
  assert.throws(
    () => modelFrom(broken),
    /coverage model does not handle: multi-stage "--from=builder"/,
    "a --from stage copy must trip the precondition, not be silently mis-modelled"
  );
});

test("guard rejects a glob/wildcard COPY source — an unmodelled form fails loudly", () => {
  const broken = DOCKERFILE.replace("COPY bin/a2a-server.js ./bin/a2a-server.js", "COPY bin/*.js ./bin/");
  assert.notEqual(broken, DOCKERFILE, "fixture precondition: the bin COPY line must exist to be rewritten");
  assert.throws(
    () => modelFrom(broken),
    /coverage model does not handle: glob\/wildcard source "bin\/\*\.js"/,
    "a glob source must trip the precondition, not be treated as a literal path"
  );
});

test("guard rejects a file COPY that collides with a prior directory destination — the false-negative form", () => {
  // `COPY src/a2a ./src/a2a` establishes /app/src/a2a as a directory. A later file
  // copied to that same plain destination would, in Docker, land INSIDE it as
  // /app/src/a2a/package.json — but the model reads it as a rename to /app/src/a2a.
  // This is the one orientation that could flip a broken image to green, so it must
  // fail loudly.
  const broken = DOCKERFILE.replace("COPY packs ./node_modules", "COPY packs ./node_modules\nCOPY package.json ./src/a2a");
  assert.notEqual(broken, DOCKERFILE, "fixture precondition: the packs COPY line must exist to extend");
  assert.throws(
    () => modelFrom(broken),
    /a destination a prior COPY already created as a directory/,
    "a file copied onto a prior directory destination must trip the precondition"
  );
});
