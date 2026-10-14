// Claude Code renderer (spec section 7).
//
// Emits <id>.md with YAML frontmatter (name, description, explicit tools,
// inherited model) followed by the canonical prompt as the system prompt. Tool
// identifiers come from the shared capability translation plus any bound MCP
// service tools; the model is left inherited so spawn-time routing is not baked
// into the definition.

import { stringify as yamlStringify } from "yaml";
import { claudeLocalTools, boundServiceTools, mcpToolId, credentialBindingNote } from "./native.js";

export function renderClaude(role, { integrations } = {}) {
  const cap = role.descriptor.local_capabilities;
  const tools = claudeLocalTools(cap);
  const bindings = boundServiceTools(role.descriptor, integrations);
  for (const b of bindings) {
    for (const t of b.tools) tools.push(mcpToolId("claude", b.server, (b.toolPrefix || "") + t));
  }
  // Serialize the frontmatter with a real YAML serializer so a description or
  // prompt can never break the document; tools is the documented comma list.
  const frontmatter = yamlStringify({
    name: role.id,
    description: role.descriptor.description,
    tools: tools.join(", "),
    model: "inherit",
  }).trimEnd();

  const body = role.prompt.trimEnd() + "\n" + credentialBindingNote(bindings);
  const content = `---\n${frontmatter}\n---\n\n${body}`;
  return { filename: `${role.id}.md`, content: content.endsWith("\n") ? content : content + "\n", mode: 0o644 };
}
