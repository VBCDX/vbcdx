# What this protects

This page says which secrets VBCDX holds, where each one lives, who can read it, how to cut
access off, and what this release does not protect against. It describes the installed services:
the sidecar on each agent host, the control plane, Keyhole and Dispatch. How to install them is in
[sidecar.md](sidecar.md), [control-plane.md](control-plane.md),
[keyhole-server.md](keyhole-server.md) and [dispatch-server.md](dispatch-server.md).

## The secrets and where they live

| Secret | Where | Who can read it |
|---|---|---|
| A tool's key (an API key a tool call needs) | `keyhole.db` in Keyhole's state directory, sealed with the instance's key-encryption key (KEK) | the Keyhole server, which opens it in memory only to seal it to a request. Nobody holds it in the clear at rest |
| The KEK | `kek` in Keyhole's state directory (`/var/lib/vbcdx-keyhole/<instance>`, 0700 `vbcdx-keyhole`, files 0600) | the `vbcdx-keyhole` user and root on the Keyhole host |
| A tool's key during a call | the sidecar's memory on the agent host, for that one call | the sidecar process (its user) and root on that host, during the call |
| Your signed-in session (CLI) | `~/.vbcdx/credentials/services/<instance>/session.json`, 0600 | you and root on that host. The control plane keeps only a hash of it |
| The sidecar's TCP caller token | `caller.token` in the sidecar's state directory, 0600 | the sidecar's user and root. The sidecar keeps only a hash to compare against |
| Link keys (each service's mTLS key for the control-plane link) | `link.key` in each service's state directory (0700, the service's user) | that service's user and root on its host |
| The control plane's state | `/var/lib/vbcdx-control/<instance>` (`control.db`, SQLite: users' password hashes, session hashes, the sidecar and service registry), 0700 `vbcdx-control`, files 0600 | the `vbcdx-control` user and root on the control-plane host |
| Dispatch's webhook secrets | Dispatch's database, sealed with `SESSION_SECRET` if it is set, otherwise with `webhook.key` in Dispatch's state directory (`/var/lib/vbcdx-dispatch/<instance>`, 0700 `vbcdx-dispatch`, files 0600) | the `vbcdx-dispatch` user and root on the Dispatch host |
| Dispatch's messages | `dispatch.db` and `nats/` in Dispatch's state directory, **not encrypted at rest** | the `vbcdx-dispatch` user and root on the Dispatch host |
| The tunnel CA key | `tunnel/ca.key` in the control plane's state directory (`tunnel/` 0700, files 0600) | the `vbcdx-control` user and root on the control-plane host. It signs every sidecar's client certificate, so whoever holds it can make a certificate the tunnel accepts for an enrolled sidecar's identity. Acting as a user still needs that user's session or password |
| A sidecar's tunnel credentials | `tunnel/` in the sidecar's state directory (0700, files 0600): `tunnel.key` and `tunnel.crt` (its client key and certificate), `control-ca.crt`, `sidecar-id`, and `grant.x25519` (an X25519 private key) | the sidecar's user and root on that host. Whoever holds `tunnel.key` with its certificate can connect to the control plane as that sidecar until it is revoked. The sidecar refuses to start with wider modes or another owner |

Settings files (`*.toml`, `*.env` under `/etc/vbcdx…`) are 0640, root and the service's group. The
installer writes no secret into them. A secret you add there yourself (Dispatch's `SESSION_SECRET`,
a database URL with a password) is readable by the service's group. An
enrollment token is written to a 0600 file and never printed. Passwords are read from stdin or from
a 0600 file, never from the command line.

## How a tool's key travels

When an agent calls a tool that needs a key, the agent never sees the key:

1. The agent calls the sidecar on its own host.
2. The sidecar asks Keyhole, over its tunnel to the control plane, for the key. It sends a public key
   it made for this one request.
3. Keyhole seals the key to that request key and sends it back. The seal also binds the tag, the
   request id, the tool, the slot, the tool's version and a digest of the tool's whole definition
   (its address, actions, slot placement, timeout and private-address allowance).
4. The sidecar rebuilds that binding from the definition it is about to use, opens the key only if
   it matches, makes the call itself and passes back the service's reply.

So a relay on the way, the control plane included, can't redirect a key to another address or
tool: a changed definition doesn't open. The key is not written to disk, not put in a log, and not
returned on the agent's socket. Nothing is cached in this version: every call asks Keyhole again.
Details: [VBCDX/vbcdx-core `docs/tool-calls.md`](https://github.com/VBCDX/vbcdx-core/blob/main/docs/tool-calls.md)
and [VBCDX/keyhole `docs/resolve.md`](https://github.com/VBCDX/keyhole/blob/main/docs/resolve.md).

## What you trust

- **Root on each host.** Root (and the service's own user) on a host can read every secret that host
  holds: the KEK on the Keyhole host, the tunnel CA key on the control-plane host, the session file,
  the tunnel credentials and a key in memory during a call on the agent host. Nothing here defends
  against a compromised root.
- **The tunnel CA on the control-plane host.** It decides which sidecars the tunnel accepts. Keep
  that host as closely held as the Keyhole host.
- **The control plane** checks every session and forwards requests. It never sees a tool's key in
  the clear, and it can't redirect one (above), but it decides who is signed in and who is a member.
- **The installer's own inputs.** The integrations file decides which programs start for a stdio
  service, so the installer reads it only when no one but its owner can change it: a regular file
  (not a symlink), owned by you or root, writable by no one else, and its own directory not
  writable by others unless that directory is sticky. Directories above it aren't checked, nor who
  owns its directory. Otherwise it stops with exit 2.

## Cutting access off

| To stop | Do | Takes effect |
|---|---|---|
| a session that may have leaked | `vbcdx config service sidecar auth logout` (signs the session out on the control plane; deleting the file alone doesn't) | at once |
| a sidecar (a lost or compromised agent host) | `vbcdx-control sidecars revoke <id> --yes` on the control-plane host | at once: its open links are closed (idle or not), its sessions end, and new requests are refused. A request already in flight is cut after at most 250 ms |
| a service (Keyhole or Dispatch) | `vbcdx-control services revoke <name> --yes` | at once: its open link is closed and new forwarded requests are refused. A request already in flight is cut after at most 250 ms |
| one member of an organization | `vbcdx config service sidecar users suspend …` (an org admin) | their next request in that organization is refused |
| a service on a host, for good | `sudo vbcdx remove service <name> --wipe`: it deletes the state too (keys, databases, the KEK, the tunnel CA key). Use `--wipe` **in place of** a plain remove: a plain remove keeps the state, and a later `--wipe` then exits 2 and deletes nothing | at once, on that host |
| a service on a host, for now | `sudo vbcdx service <name> stop` | at once, on that host; its state stays |

A session also ends by itself after 12 hours, and it is bound to the sidecar it was made on.

The control plane logs one line per routed request that reaches it through the tunnel: the peer
(the sidecar's id or the service's name), the method, the route template and the status. It never
logs a path's values, a query, a header value, a body or a token. A request to an unknown route, a
ping or an enrollment isn't logged; a request refused because its peer is revoked is. So the
control plane alone can show what a sidecar did on its routes, including the refusals after its
revoke.

## What this release doesn't protect against

- **A compromised root on any host.** See "What you trust".
- **A service that echoes its request headers.** The key reaches the tool's service and nothing
  else, but a service that sends its request headers back in its reply would hand the key to
  whoever made the call. Grant only tools whose service doesn't do that.
- **Dispatch messages aren't encrypted at rest.** The `vbcdx-dispatch` user and root on the Dispatch
  host can read them. Only its webhook secrets and sign-in cookie are sealed.
- **A plain remove leaves the keys on disk.** `vbcdx remove service <name>` without `--wipe` keeps
  the state directory: the control plane's `control.db` and `tunnel/ca.key`, Keyhole's `kek` and
  `keyhole.db`, Dispatch's database, messages and `webhook.key`, and the link keys. A later `remove … --wipe` exits 2 and deletes nothing. Delete them
  by hand, as root, or use `--wipe` from the start.
- **A tampered Keyhole reply costs one DNS lookup.** The sidecar resolves the tool's host before it
  opens the key, so a reply that fails at the seal has already caused one lookup. It still fails
  closed: no key is opened and no call is made.
- **The sealed key's `ttl` isn't bound by the seal.** That is safe while nothing is cached, which is
  the case in this version.
- **The bundled SQLite.** The control plane (`vbcdx-control`, which ships in the `@vbcdx/sidecar`
  package) is built with SQLite 3.46.0, under a time-boxed advisory exception (RUSTSEC-2026-0459,
  until 2026-11-23). The sidecar binary contains no SQLite, and Keyhole and Dispatch bundle 3.54.1,
  which the advisory doesn't affect. The advisory concerns a
  database or its write-ahead log written by a less trusted party. Each daemon opens only its own
  database, in a state directory it refuses unless that directory is owned by the service's user and
  closed to everyone else, so a crafted file needs that user or root already. A newer SQLite comes
  with a dependency update that isn't in this release.
