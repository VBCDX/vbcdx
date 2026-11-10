# Installing the sidecar

The sidecar is the VBCDX service on each host where agents run. Agents reach every VBCDX
service through it: on its own it serves its local sockets; connected to a control plane
([control-plane.md](control-plane.md)), it carries their requests over one mutual-TLS tunnel,
and the control plane forwards them to Keyhole or Dispatch.

`vbcdx install service sidecar` installs it as a system service, from the signed `@vbcdx/sidecar`
release, verified against the release keys the installer pins before anything is written.

First the [Requirements](../README.md#requirements) and [Install](../README.md#install) in the
README: Node.js 22, the `passwd` package, and vbcdx installed for root. The commands here are
written with `sudo`; in a root shell (a minimal Debian image logs you in as root and has no
`sudo`), run them without it.

## Install

`--version` names a version of `@vbcdx/sidecar`; without it, the installer takes the `latest`
dist-tag. See what is published with `npm view @vbcdx/sidecar versions dist-tags`.

```sh
sudo vbcdx install service sidecar --version <version> --dry-run   # review the plan
sudo vbcdx install service sidecar --version <version>
```

It prints `Installed service sidecar <version> as instance default (system)`, the unit it started
and the socket it listens on. `--no-start` enables the unit without starting it, and
`--instance <name>` installs another instance next to `default`.

What install puts down (instance `default`):

| What | Where | Mode, owner |
|------|-------|-------------|
| user and group | `vbcdx` (system, no login shell) | |
| binaries | `/usr/local/lib/vbcdx/sidecar/<version>/vbcdx-sidecar`, `…/vbcdx-svc` | 0755 root |
| `current` | `/usr/local/lib/vbcdx/sidecar/current` → `<version>` | |
| config | `/etc/vbcdx/default/sidecar.toml` | 0640 root:vbcdx |
| state | `/var/lib/vbcdx/default` | 0700 vbcdx |
| sockets | `/run/vbcdx/default.sock`, `/run/vbcdx/default.admin.sock` | 0660 group vbcdx |
| unit | `/etc/systemd/system/vbcdx-sidecar-default.service` | 0644 |

From installer 0.2.5 a system install also writes `/etc/vbcdx/default/install.json` (0640
root:vbcdx): the installed `vbcdx-svc`'s path and checksum, so that members of group `vbcdx` can
run `vbcdx config service …` (below). It names nothing secret.

To connect the sidecar to a control plane, reinstall it with `--control-plane` and an enrollment
token: [control-plane.md, "Connect a sidecar"](control-plane.md#connect-a-sidecar).

## Check it

```sh
sudo vbcdx doctor --service sidecar          # exit 0 when every check passes, 5 otherwise
sudo vbcdx service sidecar status            # also start, stop, restart, logs [--follow]
sudo vbcdx list services
```

Doctor checks the binaries and `current`, that the config and unit are the ones install wrote,
the state dir's mode, that the unit is active, and that both sockets are 0660 group `vbcdx`.
On a sidecar connected to a control plane it also checks the tunnel: `check --dial` (a fresh
connection) and `check --live` (the running daemon's own link).

## Use it

Each service's own commands run through the installed sidecar:

```sh
vbcdx config service sidecar <command> …      # sign-in, users, workspaces, agents (control-plane.md)
vbcdx config service dispatch <command> …      # Dispatch, e.g. messages send|list (Keyhole and Dispatch, below)
```

`--help` on either lists its commands. Keyhole has no `config service keyhole` commands in this
version yet. They run as root, or as a member of group `vbcdx`
with installer 0.2.5 or later (`sudo usermod -aG vbcdx <user>`, then log in again). A session
belongs to the sidecar it was made on and to the local user who made it.

## Keyhole and Dispatch

There is nothing to install on the sidecar for Keyhole or Dispatch: a sidecar connected to a
control plane carries their calls over its tunnel, and the control plane forwards them to the
Keyhole and Dispatch servers ([keyhole-server.md](keyhole-server.md),
[dispatch-server.md](dispatch-server.md)). `vbcdx install service keyhole` and
`vbcdx install service dispatch` stop with a usage error that names the server to install
instead.

Older sidecars had modules, turned on with `vbcdx install service dispatch|keyhole` and recorded
in `/etc/vbcdx/default/modules.toml`. The sidecar now ignores that file, and the next upgrade
([Upgrade](#upgrade), below) removes it, or keeps and names it if you edited it.

## Upgrade

Install the new version over the old one, giving only the new version:

```sh
sudo vbcdx install service sidecar --version <new version> --dry-run
sudo vbcdx install service sidecar --version <new version>
```

The settings are kept (including `--control-plane`, so an enrolled sidecar stays enrolled as the
same sidecar), the unit restarts on the new binary, and the old version's directory goes. An
older version is refused unless you pass `--allow-downgrade`.

## Remove

```sh
sudo vbcdx remove service sidecar --dry-run    # what would go, and what is kept
sudo vbcdx remove service sidecar              # the unit, config and binaries; state stays
sudo vbcdx remove service sidecar --wipe       # in place of the line above: also the state
```

A file you edited since install is kept and named. On an enrolled sidecar, revoke it on the
control plane too: `vbcdx-control sidecars revoke <id> --yes` (control-plane.md).
