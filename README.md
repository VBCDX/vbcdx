# @vbcdx/vbcdx

One installer for agent packs, skills and MCP tool packages, across **Claude Code**,
**Codex**, **OpenCode** and **Hermes Agent**.

- **Agents.** Renders the roles of an agent pack into each harness's native format:
  Claude Code subagents, Codex agents, OpenCode agents, Hermes profiles.
- **Tools.** Registers an MCP tool package in the harness's MCP configuration and binds
  it to the roles allowed to use it.
- **Skills.** Copies a pack's skills into the harness's skills directory.
- **Safe updates.** Records everything it writes, updates only its own files, and never
  overwrites your edits without `--force`.

vbcdx ships no agents of its own. Install an agent pack next to it, for example
[`@vbcdx/dev-agents-plugin`](https://github.com/VBCDX/dev-agents-plugin).

## Requirements

- Node.js 22 or later
- A POSIX system (Linux or macOS)

## Install

```sh
npm install -g @vbcdx/vbcdx
```

Agent packs and tool packages are npm packages too. Install them the same way, or point
vbcdx at a local checkout:

```sh
npm install -g @vbcdx/dev-agents-plugin @vbcdx/forgejo-plugin
```

## Quick start

Install every role of the dev agent pack into Claude Code, give the roles the Forgejo
tools, and check the result:

```sh
vbcdx install tool @vbcdx/forgejo-plugin --harness=claude
vbcdx install agent all --harness=claude
vbcdx doctor --harness=claude
```

- `install tool` adds an `mcpServers.forgejo` entry to `~/.claude.json` (or
  `$CLAUDE_CONFIG_DIR/.claude.json`). The settings the
  server reads, such as `VBCDX_FORGEJO_URL`, are written as `${VAR}` references; set
  them in the environment Claude Code starts in.
- `install agent all` writes one subagent per role to `~/.claude/agents/`. Each role
  lists the Forgejo tools its definition allows and is told which credential file to
  pass (see [Credentials](#credentials)).
- `doctor` checks that each tool's entry is as written, its manifest loads, its required
  settings are set and each bound role's credential file is in place. It never prints a
  value.

Rerunning a command changes nothing. `vbcdx remove tool forgejo --harness=claude` takes
the entry out again.

## Commands

```
vbcdx install agent <id>[,<id>...]|all --harness=<h>
vbcdx install skill <name>              --harness=<h>
vbcdx install tool  <package|path>      --harness=<h>
vbcdx packs                             list agent packs, roles, skills and contracts
vbcdx list                              --harness=<h>
vbcdx remove <agent|skill|tool> <name>  --harness=<h>
vbcdx doctor                            --harness=<h>
vbcdx fetch   [--sources=<file>] [--lock=<file>] [--store=<dir>]
vbcdx sources [--lock=<file>]
```

Harnesses: `claude`, `codex`, `opencode`, `hermes`.

| Option | |
| --- | --- |
| `--pack=<package\|path>` | agent pack to read roles and skills from; repeatable. Default: every installed agent pack |
| `--overlay=<dir>` | apply an [overlay](#overlays); repeatable |
| `--scope=<user\|project>` | `user` (default) or `project` (writes into the current Git worktree; not for Hermes) |
| `--env=<absolute path>` | use a [configuration file](#configuration-file) instead of the harness defaults |
| `--lock=<file>` | take packs and tools only from a lock written by `vbcdx fetch` |
| `--force` | replace files edited since vbcdx wrote them |
| `--dry-run` | report what would change, write nothing |
| `--json` | machine-readable output |
| `--quiet` | errors and warnings only |

Credentials and endpoints are never accepted on the command line.

**Where files go.** Without `--env`, vbcdx writes into the harness's own home: the
harness variable when set (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`,
`HERMES_HOME`), otherwise its default (`~/.claude`, `~/.codex`, `~/.config/opencode`,
`~/.hermes`). If that home doesn't exist, vbcdx stops rather than create it. Its own
state (the install record and credential files) lives in `~/.vbcdx`.

**Finding packages.** A pack or tool package is looked up as a local path (starting
with `./`, `../` or `/`), then in `node_modules` from the current directory upwards, then
next to vbcdx, then in `npm root -g`. vbcdx never downloads from the registry itself.

**Skills.** `install skill` takes the name `vbcdx packs` lists (or the skill file's name
in lower case) and writes `<skills dir>/<name>/SKILL.md`. The skills directory is
`<CLAUDE_CONFIG_DIR>/skills` for Claude Code, `~/.agents/skills` for Codex and
`<OPENCODE_CONFIG_DIR>/skills` for OpenCode (project scope: `.claude/skills`,
`.agents/skills`, `.opencode/skills`). Hermes has no skills directory.

## Agent packs

An agent pack is an npm package with a `vbcdx-pack.json` at its root:

```json
{
  "schema_version": 1,
  "name": "example-agents",
  "description": "A small agent pack.",
  "roles_dir": "roles",
  "roles": ["code-agent", "review-agent"],
  "skills_dir": "skills",
  "contracts": ["vbcdx.forgejo/1"]
}
```

Each role is a directory `roles/<id>/` with:

- `prompt.md`: the role's prompt, used as written by every harness.
- `role.json`: what the role may do, in terms vbcdx maps to each harness: its policy,
  local capabilities (filesystem read-only or read-write, shell, web, delegation), and
  the tools it may call for each tool contract it uses.

Skills live in `skills/<category>/<NAME>.MD` with `name` and `description` frontmatter.

Schemas: [`vbcdx-pack.schema.json`](schema/vbcdx-pack.schema.json) and
[`vbcdx-role.schema.json`](schema/vbcdx-role.schema.json). In a pack's own tests, use
`readPack(dir)` from `@vbcdx/vbcdx/pack`, which also checks the rules that span files.

## Tool packages

A tool package is an npm package with an MCP server and a `vbcdx.json` at its root that
says how to start it:

```json
{
  "schema_version": 1,
  "server_name": "example-tracker",
  "stdio": { "bin": "example-tracker", "args": ["mcp"] },
  "http": { "args": ["serve"], "path": "/mcp", "port_env": "EXAMPLE_TRACKER_HTTP_PORT" },
  "env": [
    { "name": "EXAMPLE_TRACKER_URL", "description": "Origin of the tracker instance.", "kind": "config", "required": true },
    { "name": "EXAMPLE_TRACKER_HTTP_PORT", "description": "Listen port in network mode.", "kind": "config", "required": false, "modes": ["http"] }
  ],
  "credential_file": { "argument": "credential_file" },
  "manifest": { "args": ["manifest"] }
}
```

- `env` lists every variable the server reads. vbcdx writes them into the harness entry
  as references, never as values. `modes` limits a variable to `stdio` or `http`.
- `manifest` names the command that prints the server's tool list and its contract (for
  example `vbcdx.forgejo/1`). vbcdx binds the tools to the roles that list that contract.
- `credential_file` names the tool argument that takes a role's credential file. A
  server that declares it should fail a call without a usable file, with an error that
  names the file.

Schema: [`vbcdx-tool.schema.json`](schema/vbcdx-tool.schema.json). In a package's own
tests, use `validateToolDeclaration(obj, { pkg })` from `@vbcdx/vbcdx/tool-declaration`.

| Harness | MCP configuration written |
| --- | --- |
| Claude Code | `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json` (project: `.mcp.json`), `mcpServers.<name>` |
| Codex | `$CODEX_HOME/config.toml` (project: `.codex/config.toml`), `[mcp_servers.<name>]` |
| OpenCode | `<config>/opencode.json` (project: `opencode.json`), `mcp.<name>` |
| Hermes Agent | each bound profile's `config.yaml`, `mcp_servers.<name>` |

Each edit touches one entry and keeps every other key and comment. A file that can't be
edited that way is left alone and reported.

## Credentials

Agents can be installed with no credentials at all. A role bound to a tool that takes a
credential file is told which file to pass, one per role and tool:

```
~/.vbcdx/credentials/<role>/<tool>.env
```

```sh
VBCDX_AGENTS_ROLE=review-agent
VBCDX_AGENTS_USER=review-bot
VBCDX_AGENTS_TOKEN=<token>
```

Create the file yourself (mode `0600`, in a `0700` directory), or let vbcdx write it from
your [configuration file](#configuration-file):

```sh
VBCDX_AGENTS_USER_REVIEW_AGENT__FORGEJO=review-bot
VBCDX_AGENTS_TOKEN_REVIEW_AGENT__FORGEJO=<token>
```

The key suffix is the role, two underscores, then the tool, upper-cased with hyphens as
underscores. A Forgejo file needs `USER` and `TOKEN` (or `PASSWORD`); other tools need
`TOKEN`. `install agent` warns about each missing file, and `doctor` checks that each one
exists, is private, names its role and has the fields it needs. An existing file is kept
unless you pass `--force`.

Give each role's token only the scopes its tools need. A role with a shell can call the
service directly with its own token, so the token's permissions are the real boundary.

## Overlays

An overlay adds your own rules to a pack's roles without forking the pack. It is a
directory with a `vbcdx-overlay.json`:

```json
{ "schema_version": 1, "name": "acme-dev", "version": "1.0.0",
  "packs": ["example-agents"],
  "vars": { "human_account": "alice" } }
```

| File | Effect |
| --- | --- |
| `all.md` | appended to every role of the overlay's packs |
| `roles/<id>.md` | appended to that role |
| `slots/<name>.md` | replaces slot `<name>` in every role that has it |
| `slots/<role>/<name>.md` | replaces it in that role only |

- **Slots.** A pack marks a replaceable section as
  `<!-- vbcdx:slot <name> -->default<!-- /vbcdx:slot -->`.
- **Variables.** A pack declares variables with defaults in `vbcdx-pack.json`; prompts
  use `{{vars.<name>}}`, and an overlay's `vars` override the defaults.
- **Renames.** `"rename": { "adversarial-auditor": "red-team" }` installs a pack role
  under your own id.

Apply overlays with `--overlay=<dir>` or `VBCDX_AGENTS_OVERLAY_DIRS` in the configuration
file. Removing an overlay restores the pack's output exactly. Schema:
[`vbcdx-overlay.schema.json`](schema/vbcdx-overlay.schema.json).

## Custom sources

Packs and tool packages can also come from any git repository or local directory.
Fetching happens at build time, so the machine that installs needs no network access and
no credentials.

```json
{ "schema_version": 1, "sources": {
  "dev-agents": { "shorthand": "dev-agents", "ref": "main" },
  "forgejo":    { "git": "https://git.example.org/acme/forgejo-plugin.git", "ref": "v1.2.0", "auth_env": "FORGE_TOKEN" },
  "local":      { "dir": "../my-agent-pack" } } }
```

```sh
vbcdx fetch                                     # reads vbcdx.sources.json
vbcdx install agent all --harness=hermes --lock=vbcdx.lock.json
```

- `shorthand` names a canonical package: `dev-agents`, `forgejo` or `coolify`.
- A git source needs a `ref`: a branch, a tag or a full 40-character commit SHA. It
  resolves to one commit, recorded in `vbcdx.lock.json` with a digest of the whole tree.
- `auth_env` names the variable holding a token for a private repository. The token is
  sent only to that origin and never written anywhere.
- A tool package's dependencies are installed from its lockfile, with install scripts
  disabled.
- With `--lock`, vbcdx uses only the lock and its store, and refuses to run if anything
  in the store has changed.

## Configuration file

`--env=<file>` replaces the harness defaults with explicit directories and settings. The
file is read literally: nothing in it is expanded or executed.

```sh
VBCDX_AGENTS_BASE_DIR=/home/you/.local/state/vbcdx
VBCDX_AGENTS_CREDENTIALS_DIR=/home/you/.config/vbcdx/credentials
VBCDX_AGENTS_CLAUDE_CONFIG_DIR=/home/you/.config/claude
```

When the directories differ from the harness defaults, start the harness with the
matching variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR` or
`HERMES_HOME`). [`.env.example`](.env.example) lists every key.

## Harnesses

| Harness | User scope | Project scope |
| --- | --- | --- |
| Claude Code | `<CLAUDE_CONFIG_DIR>/agents/<id>.md` | `.claude/agents/<id>.md` |
| Codex | `<CODEX_HOME>/agents/<id>.toml` | `.codex/agents/<id>.toml` |
| OpenCode | `<OPENCODE_CONFIG_DIR>/agents/<id>.md` | `.opencode/agents/<id>.md` |
| Hermes Agent | `<HERMES_HOME>/profiles/<id>/` | not supported |

### Hermes Agent

Each role becomes a Hermes profile with `SOUL.md`, `profile.yaml` and `config.yaml`:

```sh
vbcdx install agent all --harness=hermes
hermes -p code-agent chat
```

- `config.yaml` is merged, not replaced: vbcdx owns the toolsets, the model and its own
  MCP entries, and keeps every other setting, including ones saved from Hermes Web UI.
- Each role's tool allow-list is applied on every platform, and every other toolset is
  disabled.
- The profiles target Hermes Agent v0.21.5.
- **Model:** set `VBCDX_AGENTS_HERMES_BASE_URL` and `VBCDX_AGENTS_HERMES_MODEL` in the
  configuration file. The profile's `.env` holds `HERMES_PROVIDER_API_KEY`.
- **Web search** for roles that use it: set `VBCDX_AGENTS_HERMES_WEB_SEARCH_URL` to a
  LiteLLM gateway and `VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL` to a search tool configured
  on it.
- **Git for roles:** `git_url` and `git_roles` on a Forgejo service in the
  [integrations file](#integrations-file) give chosen roles a `hermes-git` helper that
  clones through the role's own fork and opens pull requests, or clones read-only.
- Each profile's `.env` belongs to you; vbcdx never writes it. Profiles share the host,
  so they are not a sandbox.

## Integrations file

For setups that don't use `install tool`, such as MCP servers reached over HTTP through a
gateway, `VBCDX_AGENTS_INTEGRATIONS_FILE` names a JSON file listing each service, its
exported tool manifest and the roles it binds to:

```json
{
  "schema_version": 1,
  "services": {
    "forgejo": {
      "server_name": "forgejo",
      "manifest_file": "/home/you/.config/vbcdx/manifests/forgejo.json",
      "transport": "http",
      "url": "https://gateway.example/mcp/forgejo",
      "roles": ["code-agent", "review-agent"]
    }
  }
}
```

A tool binds to a role only when it is in both the role's allow-list and the service's
manifest. `http:` URLs are accepted only for loopback addresses, or with
`"allow_cleartext": true`.

## Updates and conflicts

vbcdx records each file it writes in `~/.vbcdx/manifests/installation.json`. On a rerun:

- unchanged files are left alone, and missing ones are restored;
- files that still match what vbcdx wrote are updated;
- files you edited are reported as conflicts and kept, unless you pass `--force`;
- files the new version no longer produces are removed, unless you edited them.

Conflicts are found before anything is written, so a conflict never leaves a partial
update. vbcdx never touches a file it didn't write.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | invalid command, option or configuration |
| 3 | credential file problem |
| 4 | filesystem error (permissions, ownership, lock, write) |
| 5 | conflict, unsupported scope, or a failed `doctor` check |
| 6 | a tool command failed or timed out |

## A2A agent cards

`bin/a2a-server.js` serves an [A2A](https://a2a-protocol.org) agent card for each role
of the loaded packs (`/agents/<id>.json`, indexed at `/agents/`) and their skills
(`/skills/`). It serves cards only: it runs no agents and needs no credentials.
`VBCDX_A2A_PACKS` picks the packs, and `PORT`, `HOST` and `PUBLIC_BASE_URL` configure the
server. The repository's
[`Dockerfile`](https://github.com/VBCDX/vbcdx/blob/main/Dockerfile) builds it with the
packs placed under `packs/` (see
[`packs/README.md`](https://github.com/VBCDX/vbcdx/blob/main/packs/README.md)).

## Library

| Import | |
| --- | --- |
| `@vbcdx/vbcdx/pack` | `readPack`, `validatePackDeclaration`, `validateRoleDescriptor` |
| `@vbcdx/vbcdx/tool-declaration` | `validateToolDeclaration` |
| `@vbcdx/vbcdx/overlay` | `validateOverlayDeclaration`, `readOverlay` |
| `@vbcdx/vbcdx/schema/*.json` | the JSON Schemas |

## Migrating from vbcdx-dev-agents

The `vbcdx-dev-agents init` command still works and prints a deprecation notice.
`vbcdx install agent all --env=<file>` replaces it.

## Development

```sh
npm ci
npm test
npm run lint
```

The tests use a small agent pack in `test/fixtures/agent-pack/`.

## License

MIT
