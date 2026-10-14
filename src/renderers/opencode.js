// OpenCode renderer (spec section 7).
//
// Emits <id>.md with YAML frontmatter (description, mode, explicit permission
// map) and the canonical prompt as the body. PM and all-in-one use primary
// mode; other roles use all mode so they can be used directly and delegated to.
// Bound MCP service tools are allowlisted through the deprecated-but-supported
// tools map using the <server>_<tool> identifier form; built-in capabilities
// are expressed as permissions. Model is omitted so global/spawn routing wins.

import { stringify as yamlStringify } from "yaml";
import { opencodePermission, boundServiceTools, mcpToolId, credentialBindingNote } from "./native.js";

export function renderOpencode(role, { integrations } = {}) {
  const cap = role.descriptor.local_capabilities;
  const frontmatter = {
    description: role.descriptor.description,
    mode: role.descriptor.opencode_mode,
    permission: opencodePermission(cap),
  };
  const bindings = boundServiceTools(role.descriptor, integrations);
  if (bindings.length) {
    const tools = {};
    for (const b of bindings) for (const t of b.tools) tools[mcpToolId("opencode", b.server, (b.toolPrefix || "") + t)] = true;
    frontmatter.tools = tools;
  }
  const fm = yamlStringify(frontmatter).trimEnd();
  const body = role.prompt.trimEnd() + "\n" + credentialBindingNote(bindings);
  const content = `---\n${fm}\n---\n\n${body}`;
  return { filename: `${role.id}.md`, content: content.endsWith("\n") ? content : content + "\n", mode: 0o644 };
}
