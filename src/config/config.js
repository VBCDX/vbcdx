// Configuration model (spec section 4).
//
// Validates the parsed literal config entries against the supported key set,
// resolves the installer's own directories and the selected harness root, and
// validates configured paths and the optional informational code-host URL.
// Unknown VBCDX_AGENTS_* keys fail (to catch typos); unrelated keys are ignored
// without logging their values. VBCDX_AGENTS_WORKDIR is reserved and rejected
// when nonblank. Ambient environment variables are never used as defaults.

import { isAbsolute } from "node:path";
import { configError } from "../errors.js";
import { normalizeSuffix } from "../roles/registry.js";
import { isKnownRole } from "../roles/index.js";
import { hasActiveCatalog } from "../packs/catalog.js";

const HARNESS_ROOT_KEY = {
  claude: "VBCDX_AGENTS_CLAUDE_CONFIG_DIR",
  codex: "VBCDX_AGENTS_CODEX_HOME",
  opencode: "VBCDX_AGENTS_OPENCODE_CONFIG_DIR",
  hermes: "VBCDX_AGENTS_HERMES_HOME",
};

export const LAUNCH_ENV_TRANSLATION = Object.freeze({
  VBCDX_AGENTS_CLAUDE_CONFIG_DIR: "CLAUDE_CONFIG_DIR",
  VBCDX_AGENTS_CODEX_HOME: "CODEX_HOME",
  VBCDX_AGENTS_OPENCODE_CONFIG_DIR: "OPENCODE_CONFIG_DIR",
  VBCDX_AGENTS_HERMES_HOME: "HERMES_HOME",
});

const SCALAR_KEYS = new Set([
  "VBCDX_AGENTS_BASE_DIR",
  "VBCDX_AGENTS_CREDENTIALS_DIR",
  "VBCDX_AGENTS_CLAUDE_CONFIG_DIR",
  "VBCDX_AGENTS_CODEX_HOME",
  "VBCDX_AGENTS_OPENCODE_CONFIG_DIR",
  "VBCDX_AGENTS_HERMES_HOME",
  "VBCDX_AGENTS_HERMES_BASE_URL",
  "VBCDX_AGENTS_HERMES_MODEL",
  "VBCDX_AGENTS_HERMES_WEB_SEARCH_URL",
  "VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL",
  "VBCDX_AGENTS_CODE_HOST_URL",
  "VBCDX_AGENTS_INTEGRATIONS_FILE",
  "VBCDX_AGENTS_OVERLAY_DIRS",
  "VBCDX_AGENTS_WORKDIR",
]);

const CREDENTIAL_KEY_RE = /^VBCDX_AGENTS_(USER|TOKEN|PASSWORD)_.+$/;
// Optional per-role Hermes model override: VBCDX_AGENTS_HERMES_MODEL_<SUFFIX>.
const HERMES_ROLE_MODEL_RE = /^VBCDX_AGENTS_HERMES_MODEL_(.+)$/;
const PATH_KEYS = new Set([
  "VBCDX_AGENTS_BASE_DIR",
  "VBCDX_AGENTS_CREDENTIALS_DIR",
  "VBCDX_AGENTS_CLAUDE_CONFIG_DIR",
  "VBCDX_AGENTS_CODEX_HOME",
  "VBCDX_AGENTS_OPENCODE_CONFIG_DIR",
  "VBCDX_AGENTS_HERMES_HOME",
  "VBCDX_AGENTS_INTEGRATIONS_FILE",
]);

/**
 * VBCDX_AGENTS_OVERLAY_DIRS: colon-separated absolute overlay
 * directories, applied in order after any --overlay given on the command line.
 */
export function overlayDirsFrom(entries) {
  const raw = entries.get("VBCDX_AGENTS_OVERLAY_DIRS");
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(":").map((d) => {
    if (d === "") throw configError("VBCDX_AGENTS_OVERLAY_DIRS has an empty entry.");
    return validateAbsolutePath("VBCDX_AGENTS_OVERLAY_DIRS", d);
  });
}

export function validateAbsolutePath(key, value) {
  if (!isAbsolute(value)) throw configError(`${key} must be an absolute path.`);
  if (value.split("/").includes("..")) throw configError(`${key} must not contain '..'.`);
  return value;
}

/** Validate an absolute HTTP(S) URL without embedded credentials. */
export function validateServiceUrl(key, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configError(`${key} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configError(`${key} must use http or https.`);
  }
  if (url.username || url.password) {
    throw configError(`${key} must not embed credentials in the URL.`);
  }
  return value;
}

/**
 * Build the validated configuration for a run.
 *
 * @param {Map<string,string>} entries parsed literal config
 * @param {object} opts
 * @param {"claude"|"codex"|"opencode"|"hermes"} opts.harness
 * @param {"user"|"project"} opts.scope
 * @returns {object} config
 */
export function loadConfig(entries, { harness, scope }) {
  for (const key of entries.keys()) {
    if (!key.startsWith("VBCDX_AGENTS_")) continue; // unrelated key: ignored, value not logged
    if (SCALAR_KEYS.has(key)) continue;
    if (CREDENTIAL_KEY_RE.test(key)) continue;
    if (HERMES_ROLE_MODEL_RE.test(key)) continue;
    throw configError(`Unsupported configuration key ${key}. Check for a typo; unknown VBCDX_AGENTS_ keys are rejected.`);
  }

  for (const key of PATH_KEYS) {
    if (entries.has(key)) validateAbsolutePath(key, entries.get(key));
  }
  if (entries.has("VBCDX_AGENTS_CODE_HOST_URL")) {
    validateServiceUrl("VBCDX_AGENTS_CODE_HOST_URL", entries.get("VBCDX_AGENTS_CODE_HOST_URL"));
  }

  const workdir = entries.get("VBCDX_AGENTS_WORKDIR");
  if (typeof workdir === "string" && workdir.trim() !== "") {
    throw configError(
      "VBCDX_AGENTS_WORKDIR is reserved and unsupported; leave it blank. General workdir management is deferred.",
    );
  }

  const baseDir = entries.get("VBCDX_AGENTS_BASE_DIR");
  if (!baseDir) throw configError("VBCDX_AGENTS_BASE_DIR is required.");
  const credentialsDir = entries.get("VBCDX_AGENTS_CREDENTIALS_DIR");
  if (!credentialsDir) throw configError("VBCDX_AGENTS_CREDENTIALS_DIR is required.");

  // The selected harness root is required for user scope; project scope uses
  // the containing worktree instead.
  let harnessRoot;
  const rootKey = HARNESS_ROOT_KEY[harness];
  if (scope === "user") {
    harnessRoot = entries.get(rootKey);
    if (!harnessRoot) {
      throw configError(`${rootKey} is required for ${harness} ${scope} scope.`);
    }
  }

  const hermes = harness === "hermes" ? loadHermesRouting(entries) : null;
  const hermesWebSearch = harness === "hermes" ? loadHermesWebSearch(entries) : null;

  return {
    harness,
    scope,
    hermes,
    hermesWebSearch,
    baseDir,
    credentialsDir,
    harnessRoot,
    codeHostUrl: entries.get("VBCDX_AGENTS_CODE_HOST_URL") || null,
    integrationsFile: entries.get("VBCDX_AGENTS_INTEGRATIONS_FILE") || null,
    // The launch-environment translation the operator must apply for user scope.
    launchEnv:
      scope === "user" && rootKey && entries.has(rootKey)
        ? { [LAUNCH_ENV_TRANSLATION[rootKey]]: entries.get(rootKey) }
        : {},
  };
}

// A model name is a single token: it is written verbatim into a YAML scalar.
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * Optional, nonsecret Hermes model routing (hermes harness only). Hermes
 * profiles cannot run without a model section, so the renderer emits one when
 * VBCDX_AGENTS_HERMES_BASE_URL and a model are configured; the API key is never
 * accepted here — the profile reads it from its own operator-owned .env via
 * key_env. Returns null when no routing is configured.
 */
export function loadHermesRouting(entries) {
  const baseUrl = entries.get("VBCDX_AGENTS_HERMES_BASE_URL") || "";
  const model = entries.get("VBCDX_AGENTS_HERMES_MODEL") || "";
  const roleModels = {};
  for (const [key, value] of entries) {
    const m = HERMES_ROLE_MODEL_RE.exec(key);
    if (!m || !value) continue;
    const id = normalizeSuffix(m[1]);
    // Checked against the loaded agent packs. A command that renders no role (list,
    // doctor, remove, install tool) loads none, and reads no per-role model either.
    if (hasActiveCatalog() && !isKnownRole(id)) throw configError(`${key} does not name a role of a loaded agent pack (unknown suffix ${m[1]}).`);
    if (!MODEL_NAME_RE.test(value)) throw configError(`${key} is not a valid model name.`);
    roleModels[id] = value;
  }
  if (model && !MODEL_NAME_RE.test(model)) throw configError("VBCDX_AGENTS_HERMES_MODEL is not a valid model name.");
  if (!baseUrl) {
    if (model || Object.keys(roleModels).length) {
      throw configError("VBCDX_AGENTS_HERMES_MODEL(_<ROLE>) requires VBCDX_AGENTS_HERMES_BASE_URL.");
    }
    return null;
  }
  validateServiceUrl("VBCDX_AGENTS_HERMES_BASE_URL", baseUrl);
  if (!model && Object.keys(roleModels).length === 0) {
    throw configError("VBCDX_AGENTS_HERMES_BASE_URL requires VBCDX_AGENTS_HERMES_MODEL or a per-role VBCDX_AGENTS_HERMES_MODEL_<ROLE>.");
  }
  return { baseUrl, model: model || null, roleModels };
}

// A LiteLLM search tool name is a path segment of the gateway's /v1/search/<name> route.
const SEARCH_TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Optional, nonsecret Hermes web search (hermes harness only): the LiteLLM gateway URL and
 * the name of a search tool configured on it, for the roles whose descriptor declares
 * web_search. There is no default for either; setting only one is an error. The key is never
 * accepted here: the plugin reads the profile's own HERMES_PROVIDER_API_KEY. Returns null
 * when web search is not configured.
 */
export function loadHermesWebSearch(entries) {
  const baseUrl = entries.get("VBCDX_AGENTS_HERMES_WEB_SEARCH_URL") || "";
  const tool = entries.get("VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL") || "";
  if (!baseUrl && !tool) return null;
  if (!baseUrl) throw configError("VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL requires VBCDX_AGENTS_HERMES_WEB_SEARCH_URL (the LiteLLM gateway URL).");
  if (!tool) throw configError("VBCDX_AGENTS_HERMES_WEB_SEARCH_URL requires VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL (a search tool name configured on that gateway).");
  validateServiceUrl("VBCDX_AGENTS_HERMES_WEB_SEARCH_URL", baseUrl);
  if (!SEARCH_TOOL_RE.test(tool)) throw configError("VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL is not a valid search tool name.");
  return { baseUrl, tool };
}
