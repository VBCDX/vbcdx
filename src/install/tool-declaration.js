// Tool declaration (vbcdx.json) schema validator.
//
// Every MCP tool package ships a vbcdx.json at its root saying how to start its
// server (the package bin and arguments, optional HTTP mode), which environment
// variables it reads (names and one-line descriptions only) and how to print its
// tool manifest. `vbcdx install tool` reads it to write a harness's MCP entry.
// The declaration cannot hold a host, key or token: every object is closed,
// arguments are lowercase words and --flags with no digits, a flag is never followed
// by a word (so it cannot be given a value), and descriptions refuse URLs, host
// names, IP addresses and key-like runs. A description is free text, so a secret
// made only of plain words cannot be ruled out; that boundary is stated in the schema.
//
// The shipped JSON Schema (schema/vbcdx-tool.schema.json) holds every per-field rule,
// and the patterns below are read from it so the two cannot drift. Six rules span
// fields and live only here: http.port_env listed in env (and read in http mode), unique
// env names, an http section for any variable whose modes list http, stdio.bin in
// package.json, and no subcommand after a flag. A package's own tests should call
// validateToolDeclaration rather than validate against the schema alone.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseStrictJson } from "../config/json.js";
import { configError } from "../errors.js";

export const TOOL_DECLARATION_FILE = "vbcdx.json";
export const TOOL_DECLARATION_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema", "vbcdx-tool.schema.json");

const SCHEMA = JSON.parse(readFileSync(TOOL_DECLARATION_SCHEMA_PATH, "utf8"));
const P = SCHEMA.properties;
const D = SCHEMA.$defs;
const re = (s) => new RegExp(s.pattern);

const SERVER_NAME_RE = re(P.server_name);
const CONTRACT_RE = re(P.contract);
const BIN_RE = re(D.binName);
const ARG_RE = re(D.args.items);
const ENV_NAME_RE = re(D.envName);
const HTTP_PATH_RE = re(P.http.properties.path);
const HTTP_PATH_DOT_RE = re(P.http.properties.path.not);
const CRED_ARG_RE = re(P.credential_file.properties.argument);
const SCHEMA_REF_RE = re(P.$schema);
const ENV_ITEM = P.env.items.properties;
const DESC_RE = re(ENV_ITEM.description);
// A description says what a variable is for, never what it is set to: the schema's
// `not` clause lists the shapes of a value (blank, URL, host, IP, key-like runs).
const [BLANK_RE, ...VALUE_LIKE_RES] = ENV_ITEM.description.not.anyOf.map(re);
const MODES = ENV_ITEM.modes.items.enum;

/**
 * The env items a run mode reads: an item without `modes` is read in
 * both. A harness's stdio entry, its warnings and `doctor` use the "stdio" set, so a
 * network-only setting is never written into an entry that starts the stdio server.
 */
export function envForMode(env, mode) {
  return (Array.isArray(env) ? env : []).filter((e) => !Array.isArray(e.modes) || e.modes.includes(mode));
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkKeys(obj, schemaNode, label, errors) {
  const allowed = Object.keys(schemaNode.properties);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${label}: unknown field ${JSON.stringify(k)}.`);
  }
  for (const k of schemaNode.required) {
    if (!(k in obj)) errors.push(`${label}: missing required field ${k}.`);
  }
}

function checkArgs(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings.`);
    return;
  }
  if (value.length > D.args.maxItems) errors.push(`${label} has more than ${D.args.maxItems} items.`);
  let flagSeen = false;
  value.forEach((a, i) => {
    if (typeof a !== "string" || a.length > D.args.items.maxLength || !ARG_RE.test(a)) {
      errors.push(`${label}[${i}] must be a lowercase subcommand or --flag (letters and single hyphens, no digits) of at most ${D.args.items.maxLength} characters.`);
      return;
    }
    // A word after a flag would be that flag's value: subcommands come first.
    if (a.startsWith("--")) flagSeen = true;
    else if (flagSeen) errors.push(`${label}[${i}] follows a flag; subcommands come first and a flag takes no value.`);
  });
}

function checkCommand(obj, schemaNode, label, errors) {
  if (!isObject(obj)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  checkKeys(obj, schemaNode, label, errors);
  if ("args" in obj) checkArgs(obj.args, `${label}.args`, errors);
  return true;
}

/**
 * Validate a parsed vbcdx.json object.
 *
 * @param {unknown} decl the parsed declaration
 * @param {object} [opts]
 * @param {object} [opts.pkg] the package's parsed package.json; when given, the
 *   declared bin must be one of its bin entries
 * @returns {{ok: boolean, errors: string[]}} every problem found, not only the first
 */
export function validateToolDeclaration(decl, { pkg } = {}) {
  const errors = [];
  if (!isObject(decl)) return { ok: false, errors: ["vbcdx.json must be a JSON object."] };
  checkKeys(decl, SCHEMA, "vbcdx.json", errors);

  if ("$schema" in decl && (typeof decl.$schema !== "string" || decl.$schema.length > P.$schema.maxLength || !SCHEMA_REF_RE.test(decl.$schema))) {
    errors.push("$schema must be a relative path ending in vbcdx-tool.schema.json (no URL).");
  }
  if ("schema_version" in decl && decl.schema_version !== P.schema_version.const) {
    errors.push(`schema_version must be ${P.schema_version.const}; got ${JSON.stringify(decl.schema_version)}.`);
  }
  if ("server_name" in decl && (typeof decl.server_name !== "string" || !SERVER_NAME_RE.test(decl.server_name))) {
    errors.push("server_name must be 2-64 characters of lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen.");
  }
  if ("contract" in decl && (typeof decl.contract !== "string" || !CONTRACT_RE.test(decl.contract))) {
    errors.push("contract must look like <name>/<major>, for example vbcdx.forgejo/1.");
  }

  if ("stdio" in decl && checkCommand(decl.stdio, P.stdio, "stdio", errors)) {
    const bin = decl.stdio.bin;
    if ("bin" in decl.stdio && (typeof bin !== "string" || !BIN_RE.test(bin))) {
      errors.push("stdio.bin must be a package bin name (lowercase, no path).");
    } else if (pkg && typeof bin === "string") {
      const bins = typeof pkg.bin === "string" ? { [String(pkg.name || "").replace(/^@[^/]+\//, "")]: pkg.bin } : pkg.bin || {};
      if (!Object.hasOwn(bins, bin)) {
        errors.push(`stdio.bin ${JSON.stringify(bin)} is not a bin entry of the package's package.json.`);
      }
    }
  }

  if ("manifest" in decl) checkCommand(decl.manifest, P.manifest, "manifest", errors);

  const envNames = new Set();
  const stdioOnly = new Set();
  if ("env" in decl) {
    if (!Array.isArray(decl.env)) {
      errors.push("env must be an array.");
    } else {
      if (decl.env.length > P.env.maxItems) errors.push(`env has more than ${P.env.maxItems} items.`);
      decl.env.forEach((item, i) => {
        const label = `env[${i}]`;
        if (!isObject(item)) {
          errors.push(`${label} must be an object.`);
          return;
        }
        checkKeys(item, P.env.items, label, errors);
        if ("name" in item) {
          if (typeof item.name !== "string" || !ENV_NAME_RE.test(item.name)) {
            errors.push(`${label}.name must be an upper-case environment variable name.`);
          } else if (envNames.has(item.name)) {
            errors.push(`${label}.name ${item.name} is listed twice.`);
          } else {
            envNames.add(item.name);
          }
        }
        if ("description" in item) {
          const d = item.description;
          if (typeof d !== "string" || BLANK_RE.test(d) || d.length > ENV_ITEM.description.maxLength || !DESC_RE.test(d)) {
            errors.push(`${label}.description must be one non-empty line of printable text (no control or invisible formatting characters) of at most ${ENV_ITEM.description.maxLength} characters.`);
          } else if (VALUE_LIKE_RES.some((r) => r.test(d))) {
            errors.push(`${label}.description looks like it holds a value (a URL, host, IP address or key-like run); describe the variable, never its value.`);
          }
        }
        if ("kind" in item && !ENV_ITEM.kind.enum.includes(item.kind)) {
          errors.push(`${label}.kind must be one of ${ENV_ITEM.kind.enum.join(", ")}.`);
        }
        if ("required" in item && typeof item.required !== "boolean") {
          errors.push(`${label}.required must be true or false.`);
        }
        if ("modes" in item) {
          const m = item.modes;
          if (!Array.isArray(m) || m.length < ENV_ITEM.modes.minItems || m.length > ENV_ITEM.modes.maxItems ||
              !m.every((x) => MODES.includes(x)) || new Set(m).size !== m.length) {
            errors.push(`${label}.modes must list ${MODES.join(" and/or ")}, each at most once.`);
          } else if (m.includes("http") && !("http" in decl)) {
            errors.push(`${label}.modes lists http, but the declaration has no http mode.`);
          } else if (!m.includes("http")) {
            stdioOnly.add(item.name);
          }
        }
      });
    }
  }

  if ("http" in decl && checkCommand(decl.http, P.http, "http", errors)) {
    const { path, port_env: portEnv } = decl.http;
    if ("path" in decl.http && (typeof path !== "string" || path.length > P.http.properties.path.maxLength || !HTTP_PATH_RE.test(path) || HTTP_PATH_DOT_RE.test(path))) {
      errors.push("http.path must be an absolute URL path such as /mcp, with no host, query, '.' or '..' segment.");
    }
    if ("port_env" in decl.http) {
      if (typeof portEnv !== "string" || !ENV_NAME_RE.test(portEnv)) {
        errors.push("http.port_env must be an upper-case environment variable name.");
      } else if (Array.isArray(decl.env) && !envNames.has(portEnv)) {
        errors.push(`http.port_env ${portEnv} must also be listed in env.`);
      } else if (stdioOnly.has(portEnv)) {
        errors.push(`http.port_env ${portEnv} is read in http mode, so its modes must include http.`);
      }
    }
  }

  if ("credential_file" in decl) {
    const cf = decl.credential_file;
    if (!isObject(cf)) {
      errors.push("credential_file must be an object.");
    } else {
      checkKeys(cf, P.credential_file, "credential_file", errors);
      if ("argument" in cf && (typeof cf.argument !== "string" || !CRED_ARG_RE.test(cf.argument))) {
        errors.push("credential_file.argument must be a lower-case tool argument name.");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Validate, throwing a configuration error (exit 2) that lists every problem. */
export function assertToolDeclaration(decl, { pkg, source = TOOL_DECLARATION_FILE } = {}) {
  const { ok, errors } = validateToolDeclaration(decl, { pkg });
  if (!ok) {
    const lines = [`Invalid tool declaration ${source}:`, ...errors.map((e) => `  ${e}`)];
    throw configError(lines.join("\n"), { lines });
  }
  return decl;
}

/**
 * Read and validate <packageDir>/vbcdx.json against the package's own
 * package.json. Duplicate JSON keys are refused (strict parser).
 * @returns {{declaration: object, pkg: object}}
 */
export function readToolDeclaration(packageDir) {
  const declPath = join(packageDir, TOOL_DECLARATION_FILE);
  const pkgPath = join(packageDir, "package.json");
  const read = (p, what) => {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      throw configError(`${packageDir} has no readable ${what} (${err.code || "read error"}); it is not a VBCDX tool package.`);
    }
  };
  const pkg = parseStrictJson(read(pkgPath, "package.json"), pkgPath);
  const declaration = parseStrictJson(read(declPath, TOOL_DECLARATION_FILE), declPath);
  assertToolDeclaration(declaration, { pkg, source: declPath });
  return { declaration, pkg };
}
