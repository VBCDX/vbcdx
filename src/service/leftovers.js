// What an interrupted install can leave behind (a SIGKILL between its first write and the
// record): files at the paths install derives for an instance that no record names, and who
// holds the install record's lock. Read only: a dry run and doctor report it; nothing here writes,
// removes or runs a command.

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lockHolder } from "../fs/safe-writer.js";
import { PROFILES, layout, recordFile } from "./plan.js";

const exists = (sys, p) => {
  try {
    lstatSync(sys.path(p));
    return true;
  } catch {
    return false;
  }
};

// A system user install creates is local, so /etc/passwd names it: read, so that a dry run runs no command.
function localUser(sys, name) {
  try {
    return readFileSync(sys.path("/etc/passwd"), "utf8").split("\n").some((l) => l.startsWith(`${name}:`));
  } catch {
    return false;
  }
}

/** The install record's lock, as lockHolder sees it: free, held by a live process, or stale. */
export function recordLock(sys, where) {
  return lockHolder(`${sys.path(recordFile(where.home))}.lock`);
}

/**
 * The unrecorded files for one instance, given the services the record names. Per-instance paths
 * (config, state, unit) count when no record names this instance; the service's binaries and its
 * system user count only when no record names any instance of this service, since instances share
 * them.
 */
export function unrecordedLeftovers(sys, { service, instance, scope, home }, recorded) {
  const L = layout({ service, instance, version: "0", scope, home });
  const mine = recorded.some((r) => r.service === service && r.instance === instance);
  if (mine) return [];
  const anyOfService = recorded.some((r) => r.service === service);
  const out = [];
  for (const p of [L.config, L.unitPath, L.state, ...(scope === "system" ? [L.confDir] : [])]) {
    if (exists(sys, p)) out.push(p);
  }
  if (!anyOfService) {
    if (exists(sys, L.current)) out.push(L.current);
    let versions = [];
    try {
      versions = readdirSync(sys.path(L.serviceLib)).filter((v) => v !== "current").sort();
    } catch { /* none */ }
    for (const v of versions) out.push(join(L.serviceLib, v));
    if (scope === "system" && localUser(sys, PROFILES[service].user)) out.push(`user ${PROFILES[service].user}`);
  }
  return [...new Set(out)];
}
