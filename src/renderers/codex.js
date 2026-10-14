// Codex renderer (spec section 7).
//
// Emits <id>.toml with name, description, developer_instructions (the canonical
// prompt), and the native sandbox_mode policy field. Codex has no per-agent
// tool allowlist field, so bound service tools and their credential_file are
// surfaced inside developer_instructions rather than an invented config key;
// delegation relies on Codex's native agent type, not a fabricated field.
// Model is omitted so routing is decided at spawn / by parent configuration.

import { stringify as tomlStringify } from "smol-toml";
import { codexSandboxMode, boundServiceTools, credentialBindingNote } from "./native.js";

export function renderCodex(role, { integrations } = {}) {
  const cap = role.descriptor.local_capabilities;
  const bindings = boundServiceTools(role.descriptor, integrations);
  const developerInstructions = role.prompt.trimEnd() + "\n" + credentialBindingNote(bindings);
  const doc = {
    name: role.id,
    description: role.descriptor.description,
    sandbox_mode: codexSandboxMode(cap),
    developer_instructions: developerInstructions,
  };
  // smol-toml escapes multi-line string content correctly (no naive interpolation).
  const content = tomlStringify(doc);
  return { filename: `${role.id}.toml`, content: content.endsWith("\n") ? content : content + "\n", mode: 0o644 };
}
