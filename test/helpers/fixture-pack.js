// The test fixture agent pack (test/fixtures/agent-pack), loaded and made the active
// catalogue on import, so a test can render its roles directly. Tests that run the
// CLI or init() pass PACK_ARG instead: the installer ships no roles of its own.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readPack } from "../../src/packs/load.js";
import { buildCatalog, setActiveCatalog } from "../../src/packs/catalog.js";

export const FIXTURE_PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "agent-pack");
export const FIXTURE_PACK = readPack(FIXTURE_PACK_DIR);
export const FIXTURE_CATALOG = buildCatalog([FIXTURE_PACK]);
export const FIXTURE_IDS = Object.freeze([...FIXTURE_CATALOG.ids]);
export const FIXTURE_SKILLS_DIR = FIXTURE_PACK.skillsDir;
export const PACK_ARG = `--pack=${FIXTURE_PACK_DIR}`;

setActiveCatalog(FIXTURE_CATALOG);
