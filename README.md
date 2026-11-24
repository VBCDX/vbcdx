# @vbcdx/vbcdx

One installer for agent packs, skills and MCP tool packages, across **Claude Code**,
**Codex**, **OpenCode** and **Hermes Agent**.

- **Agents.** Renders the roles of an agent pack into each harness's native format:
  Claude Code subagents, Codex agents, OpenCode agents, Hermes profiles.
- **Tools.** Registers an MCP tool package in the harness's MCP configuration and binds
  it to the roles allowed to use it.
- **Skills.** Copies a pack's skills into the harness's skills directory.
- **Safe updates.** Records everything it writes, updates only its own files and config
  entries, and never overwrites your edits without `--force`.

vbcdx ships no agents of its own. Install an agent pack next to it, for example
[`@vbcdx/dev-agents-plugin`](https://github.com/VBCDX/dev-agents-plugin).

## Requirements

- Linux or macOS
- Node.js 22 or later, with the npm it ships (npm 10)
- For `vbcdx install service …` (the sidecar and the server services; Linux with systemd, as
  root): the `passwd` package, which provides `useradd`. A minimal Debian 13 image may not have
  it, and has no `sudo` or `curl`.
- For agents, skills and tools (`vbcdx install agent|skill|tool`): one of Claude Code, Codex,
  OpenCode or Hermes Agent, installed and run once so its home exists (`~/.claude`, `~/.codex`,
  `~/.config/opencode`, `~/.hermes`), or its home set with its own variable (for Claude Code,
  `CLAUDE_CONFIG_DIR`). Without that variable, at user scope (the default, not
  `--scope=project`), `vbcdx install` stops rather than create the default home. For Claude
  Code an existing `~/.claude.json` counts as installed.

### Node.js 22 on Linux

Distribution packages can be older than 22: on Debian 13, `apt install nodejs` gives Node 20.19,
which is below the minimum, and npm then only warns. Check with `node -v`. The official release
tarball works on any glibc Linux. As root, on Debian or Ubuntu:

```sh
apt-get update && apt-get install -y curl ca-certificates xz-utils passwd
V=v22.23.4   # any Node 22 release listed at https://nodejs.org/dist/
A=x64        # or arm64
curl -fsSLO "https://nodejs.org/dist/$V/node-$V-linux-$A.tar.xz"
curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " node-$V-linux-$A.tar.xz\$" | sha256sum -c -
tar -xJf "node-$V-linux-$A.tar.xz" -C /usr/local --strip-components=1 --no-same-owner
rm "node-$V-linux-$A.tar.xz"
node -v      # v22.…
```

On macOS, use the installer from [nodejs.org](https://nodejs.org/) (Node 22 LTS).

## Install

First set the `@vbcdx` scope's registry, in the npm config of the user who runs vbcdx, to the
registry you install from. Until the public release that is the test registry, whose address comes
from your operator; reading it needs no login. (Without this line npm takes `@vbcdx/vbcdx` from the
public registry, which holds only an older release without the service commands.)

```sh
npm config set @vbcdx:registry https://<registry>/
```

Then install:

```sh
npm install -g @vbcdx/vbcdx
vbcdx --version
```

vbcdx uses the same npm config when it fetches a service (`vbcdx install service … --version`).

**For `sudo vbcdx …`:** the service commands run as root, so install vbcdx for root too (the
tarball above puts `node`, `npm` and then `vbcdx` in `/usr/local/bin`, on root's PATH), and set any
registry line in root's npm config. If you installed Node and vbcdx only as your own user (nvm, or a
user npm prefix), `sudo vbcdx` fails with `sudo: vbcdx: command not found`.

Agent packs and tool packages are npm packages too. Install them the same way, or point
vbcdx at a local checkout:

```sh
npm install -g @vbcdx/dev-agents-plugin
```

## Quick start

Install every role of the dev agent pack into Claude Code, give the roles the tools of a
tool package (`@example/tracker-tools` below stands for one you have installed), and check the
result. Claude Code must be installed and have run once on this host, so
that `~/.claude` exists (see [Requirements](#requirements)). If its configuration is somewhere else,
point vbcdx at it first, with `export CLAUDE_CONFIG_DIR=<its configuration directory>` (or pass
`--env=<absolute path of its config file>`). With neither, at user scope (the default), and with
no `~/.claude` and no `~/.claude.json`, `vbcdx install` stops with
`No claude configuration found at …` (exit 2) rather than create it.

On a host with no Claude Code yet, install it and run it once (see Claude Code's own
[setup docs](https://docs.anthropic.com/en/docs/claude-code/setup)). `claude --version` alone doesn't
create `~/.claude`; `claude config list` does, even before you sign in (it then reports
`Not logged in` and exits 1, which is fine here):

```sh
npm install -g @anthropic-ai/claude-code
claude config list
```

```sh
vbcdx install tool @example/tracker-tools --harness=claude
vbcdx install agent all --harness=claude
vbcdx doctor --harness=claude
```

- `install tool` adds an `mcpServers.example-tracker` entry to `~/.claude.json` (or
  `$CLAUDE_CONFIG_DIR/.claude.json`). The settings the
  server reads, such as `EXAMPLE_TRACKER_URL`, are written as `${VAR}` references; set
  them in the environment Claude Code starts in. This is for a tool package that needs no
  key. A tool that needs one is refused here: see
  [How a tool gets its key](#how-a-tool-gets-its-key).
- `install agent all` writes one subagent per role to `~/.claude/agents/`. Each role
  lists the tools its definition allows.
- `doctor` checks that each tool's entry is as written, its manifest loads and its required
  settings are set. It never prints a value.

Rerunning a command changes nothing. `vbcdx remove tool example-tracker --harness=claude`
takes the entry out again.

## Services

vbcdx also installs the VBCDX services, verified against the release keys it pins, as systemd
units. These commands run as root (Linux; see [Requirements](#requirements)):

```
vbcdx install service sidecar|control-plane|dispatch-server|keyhole-server [--version <v>] [--dry-run]
vbcdx remove  service <service> [--wipe] [--dry-run]
vbcdx doctor  --service <service>
vbcdx service <service> status|start|stop|restart|logs [--follow]
vbcdx config  service sidecar|keyhole|dispatch <args…>      the service's own commands, through the sidecar
vbcdx list    services
```

- [docs/sidecar.md](docs/sidecar.md): the sidecar, on each host where agents run.
- [docs/control-plane.md](docs/control-plane.md): the control plane (auth and registry), its tunnel,
  connecting sidecars, users and workspaces.
- [docs/dispatch-server.md](docs/dispatch-server.md): the Dispatch server, next to the control plane.
- [docs/keyhole-server.md](docs/keyhole-server.md): the Keyhole server, on the control plane's host (installer 0.2.5 or later).
- [docs/security.md](docs/security.md): what this protects: the secrets and where they live, what you trust, how to cut access off, and this release's limits.

`--version` names a release of the service's npm package (`@vbcdx/sidecar`, which also carries
the control plane, `@vbcdx/dispatch` or `@vbcdx/keyhole`). See what is published with
`npm view @vbcdx/sidecar versions dist-tags` (or that package's name).

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
| `--force` | replace files edited since vbcdx wrote them, and files at a target path that vbcdx didn't write |
| `--dry-run` | report what would change, write nothing |
| `--json` | machine-readable output |
| `--quiet` | errors and warnings only |

A credential (a token or a password) is never accepted on the command line. The service
commands do take endpoints as arguments (`--control-plane`, `--listen` and the like).

**Where files go.** Without `--env`, vbcdx writes into the harness's own home: the
harness variable when set (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`,
`HERMES_HOME`), otherwise its default (`~/.claude`, `~/.codex`, `~/.config/opencode`,
`~/.hermes`). If that default home doesn't exist, `install` stops rather than create it; a home
you name with the harness variable or `--env` is used as given. Its own
state (the install record) lives in `~/.vbcdx`.

**Finding packages.** A pack or tool package is looked up as a local path (starting
with `./`, `../` or `/`), then in `node_modules` from the current directory upwards, then
next to vbcdx, then in `npm root -g`. Installing a pack or tool downloads nothing: `vbcdx fetch`
gets sources, and `vbcdx install service` installs a service's signed release, from the npm
registry by default (`--from <dir>` takes a local release instead; see their sections).

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
  "contracts": ["vbcdx.forgejo/1"],
  "contract_tags": { "vbcdx.forgejo/1": "code-host" }
}
```

`contract_tags` (optional) gives a contract the vendor-neutral tag that an A2A agent card shows
for a role using it: one of `code-host`, `deployment`, `issue-tracker`, `messaging`, `secrets`,
`storage` or `ci`. Each key must be in `contracts`. A contract with no tag adds none to the card,
and that holds for the bundled contracts too.

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
  "manifest": { "args": ["manifest"] }
}
```

- `env` lists every variable the server reads, each a non-secret setting (`"kind": "config"`).
  vbcdx writes them into the harness entry as references, never as values. `modes` limits a
  variable to `stdio` or `http`.
- `manifest` names the command that prints the server's tool list and its contract (for
  example `vbcdx.forgejo/1`). vbcdx binds the tools to the roles that list that contract.
- A declaration must not ask for a key. `install tool` refuses one that says it does: a
  `credential_file` field or an `env` item of kind `credential` (exit 2). It can't tell a key
  from a setting by its name, so an item a package labels `config` is written as a reference
  the harness fills from its own environment. A package declares a key as `credential`, and the
  key goes to Keyhole: see [How a tool gets its key](#how-a-tool-gets-its-key).

Schema: [`vbcdx-tool.schema.json`](schema/vbcdx-tool.schema.json). In a package's own
tests, use `validateToolDeclaration(obj, { pkg })` from `@vbcdx/vbcdx/tool-declaration`.

| Harness | MCP configuration written |
| --- | --- |
| Claude Code | `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json` (project: `.mcp.json`), `mcpServers.<name>` |
| Codex | `$CODEX_HOME/config.toml` (project: `.codex/config.toml`), `[mcp_servers.<name>]` |
| OpenCode | `<config>/opencode.json` (project: `opencode.json`), `mcp.<name>` |
| Hermes Agent | each bound profile's `config.yaml`, `mcp_servers.<name>` |

Each edit touches one entry and keeps every other key. TOML and YAML files keep their comments;
a JSON file is written back with two-space indentation, and one with comments can't be edited
that way. A file that can't be edited that way is left alone and reported.

## How a tool gets its key

**This version of vbcdx writes no harness entry for a keyed tool yet** (see the last point
below). What follows is how a keyed tool works with the sidecar and Keyhole, which vbcdx installs
as services. A tool that needs a key (an API token, a password) gets it one way. The key is
stored in Keyhole, and the sidecar on the agent's host uses it for one call:

1. An admin registers the tool in Keyhole, stores its key there and grants the tool.
2. The agent calls the sidecar on its own host.
3. The sidecar asks Keyhole for the key, sealed to that one request, makes the call itself
   and passes back the service's reply.

In this flow the agent, its harness and their configuration files never hold the key.
[`docs/security.md`](docs/security.md) says where each secret lives, who can read it and how
to cut access off. [`docs/sidecar.md`](docs/sidecar.md) and
[`docs/keyhole-server.md`](docs/keyhole-server.md) say how to install the sidecar and Keyhole.

vbcdx writes no key anywhere:

- It writes no credential file and reads none.
- An MCP entry it writes is a local command with references to non-secret settings. It
  never has a header, a URL or a variable that holds a key.
- `install tool` refuses a tool package that asks for a key. Register that tool in Keyhole.
- This version writes no harness entry for a Keyhole tool yet.

### Upgrading from 0.2.14 or earlier

Earlier versions wrote one credential file per role, and per role and tool, under
`~/.vbcdx/credentials/` (or the directory `VBCDX_AGENTS_CREDENTIALS_DIR` named). This version
reads none of them, and stops on the inputs that produced or used them. Each refusal names
what to remove and never prints a value.

| Left from the earlier version | What vbcdx does now |
| --- | --- |
| `VBCDX_AGENTS_USER_…`, `VBCDX_AGENTS_TOKEN_…` or `VBCDX_AGENTS_PASSWORD_…` keys in the configuration file | stops (exit 2) and names the keys |
| `credentials`, `headers` or `allow_cleartext` on a service in the integrations file, or an `http` service (`"transport": "http"`, `url`, `roles`, `tool_prefix`) | stops (exit 2) and names the fields |
| `git_url` or `git_roles` on a service in the integrations file | stops (exit 2) and names the fields: see [Hermes git is removed](#hermes-git-is-removed) |
| a tool package with `credential_file`, or an `env` item of kind `credential` | `install tool` stops (exit 2) |
| a tool installed earlier that takes a credential | `doctor` fails; `install agent` warns and binds it to no role |
| credential files still on disk | `doctor` fails (exit 5) and lists each file; `install agent` warns with the same list |

vbcdx never opens, moves or deletes those files: it can't prove a file is its own, and
deleting a file revokes nothing. To finish the move:

1. Register each tool in Keyhole, store its key there and grant it.
2. Remove the keys and fields named above, and each tool `doctor` reports
   (`vbcdx remove tool <name> --harness=<harness>`).
3. Run `vbcdx install agent` again.
4. Revoke the old tokens at their service.
5. Delete the old files. `vbcdx doctor` then passes.

If your configuration file sets `VBCDX_AGENTS_CREDENTIALS_DIR`, leave that line in until
`doctor` passes: it is where vbcdx looks for the old files.

#### Hermes git is removed

Earlier versions could give a Hermes role git access with a token read from the profile's
`.env`. That feature isn't in this release: it put a git host's token in the role's terminal,
outside the Keyhole and sidecar route. What went:

- the `hermes-git` helper (`profiles/<id>/bin/hermes-git`);
- `terminal.env_passthrough` in the profile's `config.yaml`, which named the token's variable;
- the git section of the profile's `SOUL.md`;
- `git_url` and `git_roles` in the integrations file, and the `http` service that carried them.

vbcdx stops (exit 2) on an integrations file that still has those fields, and names them.
Take them out, then run `vbcdx install agent all --harness=hermes` again. That run:

- deletes `bin/hermes-git`. If you edited it, it is kept and reported as a conflict;
  `--force` deletes it;
- removes `terminal.env_passthrough` from `config.yaml` (and the `terminal` map, if nothing
  else is in it), and keeps your other settings;
- writes `SOUL.md` again without the git section.

It does not touch:

- **The token in the profile's `.env`** (`VBCDX_<SERVICE>_TOKEN`, or `VBCDX_FORGEJO_GIT_TOKEN`
  with `VBCDX_FORGEJO_GIT_TOKEN_SCOPE`). The file is yours. Revoke the token at the git host,
  then delete the lines: deleting a line revokes nothing.
- **Existing clones.** Each clone's `.git/config` still names the deleted helper as its
  credential helper, so `git fetch` and `git push` in it fail until you remove that line or
  set a helper of your own. A pre-push hook the helper installed stays too.

A role can still clone public repositories without a credential. Git with a credential
(private clones, pushes) is yours to set up for the agent's OS user; vbcdx doesn't manage
or protect it.

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
vbcdx install agent all --harness=hermes --lock="$PWD/vbcdx.lock.json"
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
  An MCP entry is the local command of a tool registered with `install tool`.
- Each role's tool allow-list is applied on every platform, and every other toolset is
  disabled.
- The profiles target Hermes Agent v0.21.5.
- **Model:** set `VBCDX_AGENTS_HERMES_BASE_URL` and `VBCDX_AGENTS_HERMES_MODEL` in the
  configuration file. The profile's `.env` holds `HERMES_PROVIDER_API_KEY`.
- **Web search** for roles that use it: set `VBCDX_AGENTS_HERMES_WEB_SEARCH_URL` to a
  LiteLLM gateway and `VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL` to a search tool configured
  on it.
- Each profile's `.env` belongs to you; vbcdx never writes it. Profiles share the host,
  so they are not a sandbox.

## Integrations file

`VBCDX_AGENTS_INTEGRATIONS_FILE` names a JSON file that lists services by name, each with its
exported tool manifest and an optional `stdio` launch (`{ "command": …, "args": […], "env": […] }`,
the shapes a tool package's `vbcdx.json` uses).

```json
{
  "schema_version": 1,
  "services": {
    "tracker": {
      "server_name": "tracker",
      "manifest_file": "/home/you/.config/vbcdx/manifests/tracker.json",
      "stdio": { "command": "example-tracker", "args": ["mcp"], "env": ["EXAMPLE_TRACKER_URL"] }
    }
  }
}
```

You don't need this file. It carries no credential and binds no role to a tool: roles are bound
to the tools registered with `vbcdx install tool`. While the file is configured it replaces
those tools' bindings, so a role then has no tool.

vbcdx stops (exit 2), naming the fields, on a `credentials`, `headers` or `allow_cleartext`
field, on an `http` service (`"transport": "http"`, `url`, `roles`, `tool_prefix`) and on
`git_url` or `git_roles`: see [How a tool gets its key](#how-a-tool-gets-its-key) and
[Hermes git is removed](#hermes-git-is-removed).

The file can name a program to start, so it is read only when no one but its owner can change
it: a regular file (not a symlink) owned by you or root, writable by no one else, in a
directory no one else can write to unless the directory is sticky. Otherwise vbcdx stops with
exit 2 and names the file.

## Updates and conflicts

vbcdx records each file it writes in `~/.vbcdx/manifests/installation.json`. On a rerun:

- unchanged files are left alone, and missing ones are restored;
- files that still match what vbcdx wrote are updated;
- files you edited are reported as conflicts and kept, unless you pass `--force`;
- files the new version no longer produces are removed, unless you edited them.

Conflicts are found before anything is written, so a conflict never leaves a partial
update. The writes themselves are not one transaction: an I/O error part-way leaves the files
written so far, and the report lists them so the run can be repeated. Without `--force`, vbcdx
never touches a file it didn't write, apart from the one entry `install tool` edits in a
harness's config file.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | invalid command, option or configuration |
| 3 | not used (earlier versions: credential file problem) |
| 4 | filesystem error (permissions, ownership, lock, write) |
| 5 | conflict, unsupported scope, or a failed `doctor` check |
| 6 | a tool command failed or timed out |

## A2A agent cards

`bin/a2a-server.js` serves an [A2A](https://a2a-protocol.org) agent card for each role
of the loaded packs (`/agents/<id>.json`, indexed at `/agents/`) and their skills
(`/skills/`). It serves cards only: it runs no agents and needs no credentials.
`VBCDX_A2A_PACKS` picks the packs, and `PORT`, `HOST` and `PUBLIC_BASE_URL` configure the
server. It has no auth, and listens on `127.0.0.1:8080` unless `HOST` says otherwise. The
container image sets `HOST=0.0.0.0`, so there the port mapping decides who can reach it. On
any deployment others can reach, set `PUBLIC_BASE_URL`: without it, the card URLs are built
from the request's `Host` header. The repository's
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

The `vbcdx-dev-agents init` command still works in this release and prints a notice that it
will be removed in the next one.
`vbcdx install agent all --env=<file>` replaces it.

## Development

```sh
npm ci
npm test
npm run lint
npm run coverage         # every test file in its own process; writes coverage/summary.json
npm run coverage:check   # gates the totals against coverage-floor
```

`npm run coverage` measures lines, branches and functions of `bin/` and `src/` from the raw V8
coverage of every process the tests start, and prints a table per file. A failing test file
fails it; `node scripts/coverage.mjs --allow-test-failures` measures anyway. `coverage-floor`
holds the percentages CI requires: it starts at the measured baseline and only goes up.
`coverage-exclusions` lists any file left out of the totals, each with its reason.

The tests use a small agent pack in `test/fixtures/agent-pack/`.

## License

MIT
