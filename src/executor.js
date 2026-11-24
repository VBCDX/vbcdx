// Plan executor (spec sections 8, 9, 10). Applies a plan built by planner.js:
// acquires exclusive locks in stable order, preflights, and writes generated
// definitions through the manifest ownership classifier. It writes no credential
// file and creates no credential directory.
// Multi-file operations are not globally transactional; the returned report
// lists exactly what changed so a partial failure can be retried safely.
//
// Every generated write is classified BEFORE the first one, so a
// conflict (a hand-edited or unowned file) refuses the whole run with the full
// list and nothing half-applied; --dry-run reports the same classification.
// The manifest is saved even when a later step fails, so a file that was
// written is always recorded as ours. A Hermes config.yaml is merged on the
// keys the installer owns (src/fs/hermes-config.js), not owned whole.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { readManifest, writeManifest, classifyGenerated, classifyRemoval, applyRemoval } from "./fs/manifest.js";
import { planRemovals } from "./planner.js";
import { ensureDir, acquireLocks, atomicWrite, digestOf, validateExistingFile } from "./fs/safe-writer.js";
import { classifyHermesConfig } from "./fs/hermes-config.js";
import { conflictError } from "./errors.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

/**
 * Why a leftover file was refused, and what --force does to it: a file the
 * installer wrote, no longer rendered, that was edited by hand since.
 */
const REMOVAL_NOTE = "was written by the installer and this render no longer produces it, but it was edited by hand; --force deletes it";

/**
 * Classify every generated write (flat and Hermes definitions) against disk
 * and the manifest. Read-only.
 */
function classifyWrites(plan, manifest) {
  const writes = plan.generated.map((g) => {
    const recorded = manifest.files[g.destination];
    if (g.merge === "hermes-config") {
      const c = classifyHermesConfig(g.destination, g.content, recorded);
      return { g, cls: c.cls, content: c.content, record: c.record, recordChanged: c.recordChanged, note: c.note };
    }
    return { g, cls: classifyGenerated(g.destination, g.digest, recorded), content: g.content };
  });
  // The manifest entries this run is responsible for that the current
  // render no longer produces. "Absent" candidates are not reported: there is
  // nothing on disk to remove and their record is left for a later rerun.
  const removals = planRemovals(plan, manifest)
    .map((r) => ({ ...r, cls: classifyRemoval(r.destination, r.digest) }))
    .filter((r) => r.cls !== "absent");
  const conflicts = [
    ...writes.filter((w) => w.cls === "conflict").map((w) => w.g.destination),
    ...removals.filter((r) => r.cls === "conflict").map((r) => r.destination),
  ];
  // Why each conflicting Hermes config.yaml was refused, and what --force would do.
  const notes = {
    ...Object.fromEntries(writes.filter((w) => w.cls === "conflict" && w.note).map((w) => [w.g.destination, w.note])),
    ...Object.fromEntries(removals.filter((r) => r.cls === "conflict").map((r) => [r.destination, REMOVAL_NOTE])),
  };
  return { writes, conflicts, notes, removals };
}

/** One line per refused path, then its note (if any) on the next line. */
export function conflictLines(conflicts, notes = {}) {
  return conflicts.flatMap((c) => (notes[c] ? [`  ${c}`, `      ${notes[c]}`] : [`  ${c}`]));
}

function refuseConflicts(conflicts, notes) {
  const headline =
    `Refusing to overwrite ${conflicts.length} file(s) modified outside the installer or not package-owned; nothing was written. ` +
    "Rerun with --force to replace them:";
  const lines = [headline, ...conflictLines(conflicts, notes)];
  throw conflictError(lines.join("\n"), { lines });
}

/**
 * Execute a plan.
 * @param {object} plan from buildPlan
 * @param {object} [deps] injected for tests: `readManifest` (default: the real reader)
 * @returns {object} report of actions taken (or planned, when dryRun)
 */
export function executePlan(plan, { readManifest: read = readManifest } = {}) {
  const pkgVersion = readPkgVersion();
  const report = {
    dryRun: plan.dryRun,
    harness: plan.harness,
    scope: plan.scope,
    generated: [],
    removals: [],
    launchEnv: plan.launchEnv,
    integrations: plan.integrations,
    warnings: [...plan.warnings],
  };

  if (plan.dryRun) {
    // Read-only: classify against disk and the manifest, take no lock, write
    // nothing. Conflicts are reported, as the real run would refuse them.
    const { writes, conflicts, notes, removals } = classifyWrites(plan, read(plan.manifestPath, pkgVersion));
    // What the real run would delete, or the conflict it would refuse.
    for (const r of removals) report.removals.push({ role: r.role, destination: r.destination, action: r.cls === "remove" ? "remove" : plan.force ? "forced" : "conflict" });
    for (const w of writes) report.generated.push({ role: w.g.role, destination: w.g.destination, action: w.cls === "conflict" && plan.force ? "forced" : w.cls });
    report.conflicts = plan.force ? [] : conflicts;
    report.conflict_notes = plan.force ? {} : notes;
    return report;
  }

  // The manifest is locked first and read once, under that lock. A file
  // this render no longer produces and the installer wrote is a managed destination
  // too, so it is locked like the rest; its candidate list comes from that same read,
  // which is also the one the removals are applied from, so every file removed is one
  // this run locked (finding 2). Locks fail fast, so taking the
  // manifest's before the others cannot deadlock.
  const releaseManifest = acquireLocks([plan.manifestPath]);
  let releaseOthers = () => {};
  const release = () => { releaseOthers(); releaseManifest(); };
  try {
    ensureDir(dirname(plan.manifestPath));
    const manifest = read(plan.manifestPath, pkgVersion);
    const lockTargets = [
      ...plan.generated.map((g) => g.destination),
      ...planRemovals(plan, manifest).map((r) => r.destination),
    ];
    releaseOthers = acquireLocks(lockTargets.filter((p) => p !== plan.manifestPath));

    // Pre-check: refuse every conflict up front, before the first write.
    // A leftover the operator edited is a conflict here too, so the run
    // refuses with the full list and nothing is half-applied.
    const { writes, conflicts, notes, removals } = classifyWrites(plan, manifest);
    if (conflicts.length && !plan.force) refuseConflicts(conflicts, notes);

    try {
      // Generated definitions (flat harnesses and Hermes profiles).
      for (const w of writes) {
        const { g } = w;
        let action = w.cls;
        let digest;
        if (w.cls === "noop") {
          if (digestOf(g.destination) !== null) validateExistingFile(g.destination); // safety-validate before trusting
          digest = digestOf(g.destination);
        } else {
          ensureDir(dirname(g.destination));
          if (digestOf(g.destination) !== null) validateExistingFile(g.destination); // owner/symlink/regular checks before overwrite
          digest = atomicWrite(g.destination, w.content, { mode: g.mode }).digest;
          if (w.cls === "conflict") action = "forced";
        }
        // The list of overlays that shaped the file is kept current even when the file itself
        // is unchanged: it can change (a new version) while the text stays the same.
        const prev = manifest.files[g.destination];
        const overlaysChanged = g.overlays !== undefined &&
          JSON.stringify((prev && prev.overlays) || []) !== JSON.stringify(g.overlays);
        if (w.cls !== "noop" || w.recordChanged || overlaysChanged) {
          manifest.files[g.destination] = {
            digest, mode: g.mode, role: g.role, harness: g.harness,
            package_version: pkgVersion, written_at: new Date().toISOString(),
            // The overlays that shaped this file: name, version, digest.
            ...(g.overlays && g.overlays.length ? { overlays: g.overlays } : {}),
            // A role an overlay installs under a local id records the pack id it came from.
            ...(g.renamedFrom ? { renamed_from: g.renamedFrom } : {}),
            ...(w.record || {}),
          };
        }
        report.generated.push({ role: g.role, destination: g.destination, action });
      }

      // Delete the files this render no longer produces. They were
      // classified with the writes above, so a hand-edited one was already refused
      // unless --force. Its manifest entry goes with the file.
      for (const r of removals) {
        const res = applyRemoval({ absPath: r.destination, recordedDigest: r.digest, force: plan.force });
        if (res.action === "absent") continue;
        delete manifest.files[r.destination];
        report.removals.push({ role: r.role, destination: r.destination, action: res.action });
      }
    } finally {
      // Saved even when a step above failed, so every file already written is
      // recorded as package-owned and a rerun can update it.
      manifest.package_version = pkgVersion;
      writeManifest(plan.manifestPath, manifest);
    }
  } finally {
    release();
  }
  return report;
}
