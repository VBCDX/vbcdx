# Installing the control plane

The control plane is the set of vbcdx server services. Its first one is `vbcdx-control`:
the one common auth (users, sessions, login backends) and the registry (orgs, workspaces,
members, agents) that Keyhole and Dispatch share. Sidecars reach it; it never runs on the
agent's side.

`vbcdx install service control-plane` installs it standalone, on its own host or next to a
sidecar. The two share no user, config, state, socket or unit.

In this version:

- it serves its admin socket, and with `--tunnel` the mTLS listener sidecars connect to;
- it installs as root only, as a system service running as the user `vbcdx-control`;
- it ships in the same signed release as the sidecar (`@vbcdx/sidecar`), verified the same way.

## Install

First the [Requirements](../README.md#requirements) and [Install](../README.md#install) in the
README: Node.js 22, the `passwd` package, and vbcdx installed for root.

The commands here are written with `sudo`. In a root shell (a minimal Debian image logs you in as
root and has no `sudo`), run them without the leading `sudo`; `runuser -u … --` works from a root
shell as written.

From the registry. `--version` names a version of `@vbcdx/sidecar`, the release that carries
`vbcdx-control`; without it, the installer takes the `latest` dist-tag. The installer fetches it
with root's `npm`, so root's npm config decides the registry: the public npm registry, or the
`@vbcdx` scope's registry if root's config sets one (README, Install). See what is published, and
which version each dist-tag points at, with:

```sh
npm view @vbcdx/sidecar versions dist-tags
```

```sh
sudo vbcdx install service control-plane --version <version> --dry-run   # review the plan
sudo vbcdx install service control-plane --version <version>
```

With no registry access, install from a release tree you got another way (a CI artifact, or
the release tarball unpacked). It is verified the same way before anything is written:

```sh
mkdir rel && tar -xf vbcdx-sidecar-<version>.tar -C rel
sudo vbcdx install service control-plane --from ./rel
```

Before anything is written, the release's `checksums.json` signature is checked against the
release keys the installer pins (a key overlap: during development, DEV keys 1 and 3), and so is
the checksum of `vbcdx-control`.

What install puts down (instance `default`; `--instance <name>` for another):

| What | Where | Mode, owner |
|------|-------|-------------|
| user and group | `vbcdx-control` (system, no login shell) | |
| binary | `/usr/local/lib/vbcdx/control-plane/<version>/vbcdx-control` | 0755 root |
| `current` | `/usr/local/lib/vbcdx/control-plane/current` → `<version>` | |
| config | `/etc/vbcdx-control/default/control.toml` | 0640 root:vbcdx-control |
| state (SQLite) | `/var/lib/vbcdx-control/default` | 0700 vbcdx-control |
| admin socket | `/run/vbcdx-control/default.admin.sock` | 0600 vbcdx-control |
| unit | `/etc/systemd/system/vbcdx-control-plane-default.service` | 0644 |

`control.toml` holds exactly two keys, `admin_socket` and `state_dir`. Install runs
`vbcdx-control check` on it, as `vbcdx-control`, before it writes the unit: a config the daemon
would refuse is taken back, and nothing is started. The unit runs `check` again before
every start, then `serve`.

`--service none` writes no unit and prints the `serve` command to run yourself. `--no-start`
enables the unit without starting it.

## The tunnel listener (for sidecars)

Sidecars reach the control plane over one mutual-TLS tunnel. Give the address it listens on and
the name sidecars dial (it becomes the server certificate's name):

```sh
sudo vbcdx install service control-plane --version <version> \
  --tunnel 0.0.0.0:8443 --tunnel-name cp.example.com
```

That adds `tunnel = "vbcdx+https://0.0.0.0:8443?auth=mtls"` and `tunnel_name` to `control.toml`,
and lets the unit open IPv4/IPv6 sockets (without `--tunnel` it is unix sockets only). The
listener speaks TLS 1.3 only, never plain HTTP. Apart from the one-time enrollment call, which
needs a valid enrollment token, it serves only sidecars that present the client certificate it
issued at enrollment. Open that port on the host's firewall for your sidecars only.

The tunnel's CA is made on first start (or with `tunnel init`). Its pin is what every sidecar
needs:

```sh
sudo runuser -u vbcdx-control -- /usr/local/lib/vbcdx/control-plane/current/vbcdx-control \
  tunnel pin --instance default --instance-dir /etc/vbcdx-control/default
# sha256:<64 hex>
```

## Connect a sidecar

1. On the control-plane host, issue a one-time enrollment token for one sidecar (1 hour by
   default, at most 24 h). It is written to the file you name, created 0600, and never printed:

   ```sh
   sudo runuser -u vbcdx-control -- /usr/local/lib/vbcdx/control-plane/current/vbcdx-control \
     sidecars enroll-token --instance default --instance-dir /etc/vbcdx-control/default \
     --org acme --name build-01 --ttl 1h --token-out /var/lib/vbcdx-control/default/build-01.token
   ```

   `--org` must name an org that exists on the control plane. Create the first one when you
   bootstrap the first admin (`bootstrap --org`, in "The first admin" below), and later ones with
   `vbcdx-control orgs create --name N [--owner EMAIL]`. Both run as the service user on the
   control host, over its admin socket; neither is reachable over the tunnel.

2. Move the token file to the sidecar host over a channel you trust, then delete the control
   host's copy. On the sidecar host it must be a regular file, mode 0600, owned by the user who
   runs the install (root); the installer refuses anything else. Create it with a tight umask:

   ```sh
   umask 077
   scp cp-host:/var/lib/vbcdx-control/default/build-01.token /root/build-01.token
   ```

3. On the sidecar host, install (or reinstall) the sidecar with the control plane's address and
   pin, and the token:

   ```sh
   sudo vbcdx install service sidecar --version <version> \
     --control-plane 'vbcdx+https://cp.example.com:8443?auth=mtls&pin=sha256:<64 hex>' \
     --enroll-token-file /root/build-01.token
   ```

   Use `ca=/path/to/ca.pem` in place of `pin=` if you distribute the CA certificate instead.
   One of the two is required: the sidecar never trusts a public CA. The token goes to
   `vbcdx-sidecar enroll` on its stdin, as the sidecar's user, after the config check and before
   the unit starts. It is never on a command line, in the plan, the install record or a log.
   `--enroll-token-stdin` reads it from stdin instead. A token is single use: delete the file.

4. Check the tunnel:

   ```sh
   sudo vbcdx doctor --service sidecar     # includes "control plane tunnel (check --dial)"
                                           # and "control plane tunnel (daemon, check --live)":
                                           # the running daemon's own link, as the id on disk
   ```

An already-enrolled sidecar refuses a second enrollment. To re-enroll one (for example, after
it was revoked), run `vbcdx-sidecar enroll --force` with a new token yourself. On the control
host, `vbcdx-control sidecars list` and `sidecars revoke ID --yes` manage enrolled sidecars.

## The first admin

The control plane starts with no users. Create the first control admin once, as the service
user, with the password on stdin (or `--password-file <0600 file>`). Never on the command line:

```sh
sudo runuser -u vbcdx-control -- /usr/local/lib/vbcdx/control-plane/current/vbcdx-control \
  bootstrap --instance default --instance-dir /etc/vbcdx-control/default \
  --email admin@example.com --name "Admin" --password-stdin --org acme
```

`--org NAME` (optional) also creates the first org, with this admin as its owner, in the same
transaction. Sidecars are enrolled into an org, so a control plane that will take sidecars needs
one. Without `--org`, create it later with `vbcdx-control orgs create --name acme --owner
admin@example.com`.

It prints `{"changed": true, …}`. Run it again with the same email, name and password and it
prints `changed: false`. Any other email or password is refused (exit 5): there is only one
first admin, and bootstrap never changes a password. Further users are created through the
control plane's own auth, not by bootstrap: see "Users and workspaces" below.

## Users and workspaces

`vbcdx-control` has no command that creates users. They, the workspaces and their members are
managed through a **sidecar enrolled to this control plane**: every `sidecar` command except the
sidecar's own health and status is forwarded over the tunnel and runs on the control
plane, which holds the one auth for every service. So, in this order:

1. Bootstrap the first admin, with `--org` (above).
2. Enroll at least one sidecar ("Connect a sidecar").
3. On that sidecar's host, sign in as the first admin, then create the users, a workspace and its
   members.

Each command below runs on a sidecar host, through the installed sidecar (`vbcdx config service
sidecar …`, which runs its `vbcdx-svc`), as root or as a member of group `vbcdx`: a system
sidecar's sockets are 0660 group `vbcdx`. Add a user with `sudo usermod -aG vbcdx <user>`; it takes
effect at their next login. A member of group `vbcdx` needs installer 0.2.5 or later; with 0.2.4 or
older only root can run these commands. `--org` takes the org's id, the `org.id` that
`bootstrap` printed (`org_…`), and `add-member` takes the workspace's id that `workspace create`
prints (`ws_…`). Passwords are read from stdin or from a 0600 file you own
(`--password-file`), never from the command line.

```sh
# Sign in as the first admin (the email you gave bootstrap).
vbcdx config service sidecar auth login pw --email admin@example.com --password-stdin < admin.pw
vbcdx config service sidecar auth whoami

# A user, a workspace, and the user as one of its members.
vbcdx config service sidecar users create --org org_… --email alice@example.com --name "Alice" \
  --password-stdin < alice.pw
vbcdx config service sidecar workspace create --org org_… --name build
vbcdx config service sidecar workspace members add-member ws_… --org org_… \
  --member alice@example.com --role member
```

- `users create` needs an org admin, and makes a user with the role `user` (not an org admin);
  `workspace members add-member` needs a workspace admin.
  `--member` takes a user's id or email (`--kind agent` for an agent's id or name), and `--role`
  is `member` or `workspace_admin`. Adding the same membership again changes nothing; one that
  differs is refused (exit 5) unless you pass `--update`.
- To make a user an org admin, an Owner or an org admin gives them the role `userAdmin`:
  `vbcdx config service sidecar users edit <user id> --org org_… --role userAdmin` (`users get
  <email> --org org_…` shows a user's id and role). The org roles are `Owner`, `userAdmin` and
  `user`. Only an Owner can make someone an Owner; anyone else gets exit 7, `only an Owner makes
  someone an Owner (rule: owner_only)`.
- Each user then signs in **on their own sidecar host**, the same way (as root or a member of group
  `vbcdx`): `vbcdx config service sidecar auth login pw --email alice@example.com --password-stdin`.
  A session belongs to the sidecar it was made on and to the local user who made it: root's and
  another user's sessions on one sidecar are separate.
- Failed sign-ins are limited, for 15 minutes: 10 per email, on any sidecar, and 30 per sidecar.
  Past either limit, every sign-in exits 11 (`too many failed sign-ins for this email or from this
  caller; retry after <seconds>s`), even with the right password.
- Dispatch's commands (`vbcdx config service dispatch …`) need the org too:
  pass `--org org_…`, or set `org` in a profile in `~/.vbcdx/services.toml` (`--profile` picks
  one). Without either they stop with `no organization: pass --org or set org in your profile
  (~/.vbcdx/services.toml)`.
- Every command takes `--dry-run` (prints the request, secrets redacted, and sends nothing) and
  `--json`. `--help` lists the rest.
- A command that changes nothing, such as any read (`auth whoami`, `users get`) or an edit that is
  already in place, prints its result on stdout and `unchanged` on stderr, and exits 0.

## Check it

```sh
sudo vbcdx doctor --service control-plane          # exit 0 when every check passes, 5 otherwise
sudo vbcdx service control-plane status
sudo vbcdx service control-plane logs --follow
sudo vbcdx list services
```

Doctor checks:

- the binary's checksum and the `current` link;
- the config is the one install wrote;
- the state dir is 0700;
- the unit file is the one install wrote, and the unit is active;
- the admin socket is a 0600 socket.

## Upgrade

Install the new version over the old one. Give only the new version:

```sh
sudo vbcdx install service control-plane --version <new version> --dry-run   # review: upgrade <old> → <new>
sudo vbcdx install service control-plane --version <new version>
sudo vbcdx install service sidecar --version <new version>                   # each sidecar the same way
```

The new binary goes into its own version directory, the unit is pointed at it and restarted,
and the old version's directory goes once no other instance runs it. The same command again
is a no-op (`changed: false`).

**Every setting you leave out is kept** from the installed instance, never dropped:

| Setting | Kept from |
|---|---|
| `--tunnel` / `--tunnel-name` (control plane), and with them the unit's network access | the installed `control.toml` |
| `--control-plane` (sidecar) | the installed `sidecar.toml` |
| `--listen` (sidecar) | the install record |
| `--service none` | the install record |

The state (tunnel CA and pin, users, org, enrolled sidecars, a sidecar's tunnel identity) is
never touched by an upgrade. To **change** a setting, give its flag: it overrides only that
setting. To **clear** one, say so: `--no-tunnel` (control plane) or `--no-control-plane`
(sidecar). Give `--listen` again to change the listen. If an installed config can't be read,
the install refuses (exit 5) instead of guessing; give the setting again, or restore the file.
So `--force` alone no longer repairs a deleted or garbled `sidecar.toml`: give `--control-plane`
(or `--no-control-plane`) with it. `--no-start` is a choice for one run, not a setting: an upgrade
without it starts the unit.

The dry run of an upgrade says `upgrade <old> → <new>`, names each setting it keeps, and lists
only what changes: the new version's binaries, the `current` link, and each config or unit
file that changes, as a line diff.

**A downgrade is refused.** `--version` older than the version an instance runs exits 5 and
changes nothing, its dry run too (`refused: "downgrade"`). An older release may not read the
state a newer one wrote, and an older signed release may carry a flaw a later one fixed. Install
one only when its release notes say it reads the newer state, with `--allow-downgrade`; the
summary then says `downgraded from <newer>`. The check is per instance.

## Remove

```sh
sudo vbcdx remove service control-plane --dry-run   # what would go, and what is kept
sudo vbcdx remove service control-plane             # the unit, config and binaries; state stays
sudo vbcdx remove service control-plane --wipe      # in place of the line above: also the state
```

Remove stops and disables the unit and deletes what install wrote. A file you edited since is
kept and named. A sidecar on the same host is not touched.

Choose one of the last two lines. Without `--wipe`, the state directory
`/var/lib/vbcdx-control/<instance>` stays, and remove names it: the database (users, the sidecar
registry) and `tunnel/ca.key`, the CA that signs every sidecar's client certificate. After that
remove the instance is no longer recorded, so a later `remove … --wipe` exits 2 and deletes
nothing. To delete the state, run `--wipe` instead of the plain remove (its dry run lists the
state directory).
