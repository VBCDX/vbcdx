# Installing the Keyhole server

Keyhole is a control-plane service. It holds the secrets agents' tools use. An agent's request
reaches it through the agent's sidecar, the control plane checks who the agent is, and then
forwards the request to Keyhole over a mutual-TLS link. `vbcdx install service keyhole-server`
installs the Keyhole server in that mode (control-plane mode), from its own signed release,
`@vbcdx/keyhole`.

This server, once, on the control plane's host, is all there is to install for Keyhole: agents'
sidecars carry their Keyhole calls over their tunnel with nothing added on the agent side.

In this version:

- it installs as root only, as a system service running as the user `vbcdx-keyhole`;
- it runs **on the control plane's host**: its link listener (`--link-listen`) is loopback only,
  because the control plane on the same host is the only thing that calls it;
- it signs people in with local accounts (`AUTH_MODE=local`); single sign-on is not set up here;
- it needs `@vbcdx/keyhole` **0.1.0-dev.2 or newer**, and refuses an older release: its `keyhole check`
  and `--env-file` are what the unit's pre-start gate runs. The enrolment example below needs
  **0.1.0-dev.10**, the first release that serves both routes its manifest declares (`granted-tools`
  arrives there), and this page's examples are validated against **0.1.0-dev.12**;
- the release is verified exactly as the sidecar's is, with the same pinned release key.

**It makes a new, empty Keyhole.** It never takes over a Keyhole that was installed another way,
and it never touches one: its data, its key-encryption key (KEK) and its unit stay as they are.
If an existing Keyhole already listens on the addresses you give, install refuses before it writes
anything. Stop that one first, or give this one other addresses.

## Before you start

You need, on the control plane's host:

1. **The control plane, `@vbcdx/sidecar` 0.1.0-dev.16 or newer, with its tunnel listener**
   (`--tunnel` and `--tunnel-name`; see [control-plane.md](control-plane.md)). Keyhole fetches the
   control plane's signing keys from the tunnel, and `vbcdx-control services add` (which links
   Keyhole) is in 0.1.0-dev.2 and later, but the `--manifest` and `--capability` flags that command
   needs are in 0.1.0-dev.16 and later: an older control plane answers with a usage error naming
   neither. A tool's private-address allowance (`keyhole tools private-allow`) only takes effect on
   agents' sidecars of 0.1.0-dev.4 or newer; older ones ignore it.
2. **The tunnel's name**, the `--tunnel-name` the control plane was installed with. The control
   plane's tunnel certificate names only that, so Keyhole must reach the tunnel by that name (or
   that IP address). Check what the installed control plane uses:

   ```sh
   sudo grep '^tunnel' /etc/vbcdx-control/default/control.toml
   # tunnel = "vbcdx+https://0.0.0.0:8443?auth=mtls"
   # tunnel_name = "cp.example.com"
   ```

   Here Keyhole's `--control-url` is `https://cp.example.com:8443`. That name must resolve to
   this host (an `/etc/hosts` line does). If the tunnel's name is an IP address, use it as is,
   as in `https://192.0.2.10:8443`. `https://127.0.0.1:8443` works only when the tunnel's name is
   `127.0.0.1`.
3. **The control plane's CA certificate.** It is public, but the control plane keeps it in its
   own private state directory, so make a readable copy as root:

   ```sh
   sudo install -m 0644 /var/lib/vbcdx-control/default/tunnel/ca.crt /root/control-ca.pem
   ```

4. **Two free loopback ports.** One is for the web app (`--listen`, default `127.0.0.1:8080`).
   The other is for the link the control plane calls (`--link-listen`, no default). The tunnel
   already holds its own port (8443 in control-plane.md), so the examples here use `127.0.0.1:8444`
   for the link. Check that both are free:

   ```sh
   ss -ltn | grep -E ':(8080|8444) '   # no output: both are free
   ```

## Install

Three names, one service. The installer calls the server `keyhole-server`. The control plane
registers it as `keyhole`, which is the name in `services add keyhole` and in the certificate
(`vbcdx:service/keyhole`). `vbcdx install service keyhole`, with no `-server`, is a usage error
that names `keyhole-server`.

```sh
sudo vbcdx install service keyhole-server --version 0.1.0-dev.12 \
  --link-listen 127.0.0.1:8444 --control-url https://<tunnel name>:8443 \
  --control-ca /root/control-ca.pem --dry-run   # review the plan
sudo vbcdx install service keyhole-server --version 0.1.0-dev.12 \
  --link-listen 127.0.0.1:8444 --control-url https://<tunnel name>:8443 \
  --control-ca /root/control-ca.pem
```

The dry run prints the plan, including the line `signature: key …`. That's the release key the
release was verified with. Nothing is written.

| Flag | Meaning | Default |
|------|---------|---------|
| `--link-listen 127.0.0.1:<port>` | where the link listener binds; the control plane on this host calls it. Loopback only (`127.x.x.x` or `[::1]`), and not the `--listen` address | required |
| `--control-url https://<host>:<port>` | the control plane's tunnel listener, by its tunnel name (above), for its signing keys | required |
| `--control-ca <file>` | the control plane's CA certificate (PEM, certificates only; a file holding a private key is refused) | required on the first install |
| `--listen <host>:<port>` | the web app and API | `127.0.0.1:8080` |
| `--public-url <url>` | the URL people open; `https` unless loopback | `http://<--listen>` |
| `--service-cert <file>` | the link certificate from `vbcdx-control services add keyhole` | none |

To serve the web app beyond this host, put an HTTPS reverse proxy in front and keep `--listen` on
loopback, with `--public-url https://…`. A `--listen` on a network address also needs
`--expose-on-network --i-understand-network-exposure`.

The first install does three things as `vbcdx-keyhole`, in the state directory:

1. It makes the **KEK**, the key every stored secret is sealed with. It is made **once**. A later
   install, upgrade or certificate re-run never replaces it.
2. It makes the link key.
3. It makes the link key's certificate request.

Neither key ever leaves the state directory. The unit is installed but **not started** yet, and
install prints the next step.

## The link certificate

1. Register Keyhole with the control plane, on this host. The CSR is a request, not a secret.
   Copy it where `vbcdx-control` can read it, and install Keyhole's manifest beside it: a release
   ships the binary and its checksums, not a manifest, and enrolment reads one.

   Keyhole's manifest is the suite's own, exactly as the control plane compiles it
   (`schema/examples/manifest-keyhole.json` in `vbcdx-core`): the two routes Keyhole serves at its
   root, and no agent routes. It is this, byte for byte:

   ```json
   {
     "schema_version": 1,
     "name": "keyhole",
     "sidecar_prefix": null,
     "routes": [
       {
         "op": "keyhole.resolve",
         "method": "POST",
         "path": "orgs/{org}/resolve",
         "agent": false
       },
       {
         "op": "keyhole.granted-tools",
         "method": "POST",
         "path": "orgs/{org}/granted-tools",
         "agent": false
       }
     ]
   }
   ```

   Save it as `/root/keyhole.manifest.json`; the manifest copy below reads from that path, and if you
   keep it somewhere else, use that path there instead. In a checkout of `VBCDX/vbcdx`,
   `docs/manifests/keyhole.json` already holds these bytes.

   ```sh
   sudo install -o vbcdx-control -g vbcdx-control -m 0644 /var/lib/vbcdx-keyhole/default/link.csr \
     /var/lib/vbcdx-control/default/keyhole.csr
   sudo install -o vbcdx-control -g vbcdx-control -m 0644 /root/keyhole.manifest.json \
     /var/lib/vbcdx-control/default/keyhole.manifest.json
   sudo runuser -u vbcdx-control -- /usr/local/lib/vbcdx/control-plane/current/vbcdx-control \
     services add keyhole --url https://127.0.0.1:8444 \
     --csr /var/lib/vbcdx-control/default/keyhole.csr \
     --cert-out /var/lib/vbcdx-control/default/keyhole.crt \
     --manifest /var/lib/vbcdx-control/default/keyhole.manifest.json \
     --capability resolver \
     --instance default --instance-dir /etc/vbcdx-control/default
   ```

   `--capability resolver` is the operator's grant, not part of the manifest: the control plane
   forwards sealed-value resolves only to the service the operator grants `resolver`, and these
   two routes are that contract's. Without the flag it refuses this manifest (`… is a resolver
   route and keyhole is not the resolver`).

   The `--url` is `https://` plus this install's `--link-listen`, with no path: Keyhole serves its
   routes at the root. If the control plane already has a `keyhole` service, for example from an
   earlier Keyhole on this host, add `--replace`. The control plane then calls this one.

2. Run the same install again with the certificate:

   ```sh
   sudo vbcdx install service keyhole-server --version 0.1.0-dev.12 \
     --service-cert /var/lib/vbcdx-control/default/keyhole.crt
   ```

   Install keeps the other settings (`--listen`, `--link-listen`, `--control-url`,
   `--public-url` and the control CA) from what is installed, as it does for every service. A flag
   you give changes only its own setting.

   The certificate is written next to the key (0600, owned by `vbcdx-keyhole`). Then the installed
   `keyhole check` runs as that user, against the unit's settings file. It checks:
   - that the certificate names the Keyhole service and fits the key;
   - the key's and the KEK's modes and owner;
   - the control CA;
   - the control URL.

   Only then does the unit start. A certificate it refuses is taken out again, and nothing starts.

A replaced certificate (after `services add keyhole --replace`) goes in the same way and restarts
the unit. The certificate lasts 30 days, so renew it before then.

What install puts down (instance `default`; `--instance <name>` for another):

| What | Where | Mode, owner |
|------|-------|-------------|
| user and group | `vbcdx-keyhole` (system, no login shell) | |
| binary | `/usr/local/lib/vbcdx/keyhole-server/<version>/keyhole` | 0755 root |
| settings | `/etc/vbcdx-keyhole/default/keyhole.env` (the unit's `EnvironmentFile=`) | 0640 root:vbcdx-keyhole |
| the control CA | `/etc/vbcdx-keyhole/default/control-ca.pem` | 0640 root:vbcdx-keyhole |
| state: `keyhole.db`, `kek`, `link.key`, `link.csr`, `link.crt` | `/var/lib/vbcdx-keyhole/default` | 0700 vbcdx-keyhole; files 0600 |
| unit | `/etc/systemd/system/vbcdx-keyhole-server-default.service` | 0644 |

`keyhole.env` holds no secret. The unit runs `keyhole check` before every start, then
`keyhole serve`. It has the same hardening as the Dispatch server's unit, and `UMask=0077`.

## The first account, and Keyhole's own commands

Keyhole's admin commands run as `vbcdx-keyhole`, with the unit's settings
(`keyhole --env-file <settings> <command>`; `--env-file` comes before the command). Create the
first local account like this; it prompts for a password of 12 or more characters:

```sh
sudo runuser -u vbcdx-keyhole -- /usr/local/lib/vbcdx/keyhole-server/current/keyhole \
  --env-file /etc/vbcdx-keyhole/default/keyhole.env user create --email you@example.com --name "Your Name"
```

Then open `--public-url` and sign in.

**The rows you load and the keys you put must use the control plane's own org id** (`org_…`, not
its slug): the control plane asserts that id on every request, and Keyhole finds nothing under any
other. Keyhole's `docs/local-store.md`, "The org id", says how to read it.

Every other Keyhole command takes the same prefix, and the
keyhole repository documents them (at the tag you installed, e.g. `v0.1.0-dev.12`):

- `load --file` and `keys put` (a stored key's value, on standard input): `docs/local-store.md`.
  `keys put` needs `--kek-file /var/lib/vbcdx-keyhole/default/kek`. Don't run `kek generate`:
  install made this instance's KEK, and a new one couldn't open what is stored.
- `grants disable|enable`, `members add|remove` and `tools private-allow`: `docs/resolve.md`.
- `user create`: the README. `keyhole help` lists every command.

## Check it

```sh
sudo vbcdx doctor --service keyhole-server
```

It checks:
- the binary;
- both installed files;
- the state directory;
- `link.key` (0600);
- the KEK (0600);
- `link.crt`;
- the installed `keyhole check`, run as `vbcdx-keyhole`;
- the unit.

It exits 0 when all pass and 5 when one fails, naming it.

## Back up, upgrade and remove

The KEK and `keyhole.db` belong together: a database without its KEK can't be opened. Back them up
together, both 0600, and somewhere only root can read. The state directory has both.

Run install with the new `--version` to upgrade. The settings, the KEK, the keys and the
certificate stay. An older version is refused unless you pass `--allow-downgrade`.

If the KEK is missing on an instance that has already run (its `keyhole.db` or link key is
there), install stops and changes nothing. A new KEK couldn't open what is stored. Put the KEK back
from your backup, or start the instance over with `remove --wipe`.

```sh
sudo vbcdx remove service keyhole-server          # the unit, settings, control CA and binary; state stays
sudo vbcdx remove service keyhole-server --wipe   # also the state: the database, the KEK, the keys and certificate
```

`--wipe` deletes the KEK, so every secret stored in this Keyhole is gone for good.

Revoke the link on the control plane too:

```sh
sudo runuser -u vbcdx-control -- /usr/local/lib/vbcdx/control-plane/current/vbcdx-control \
  services revoke keyhole --yes --instance default --instance-dir /etc/vbcdx-control/default
```
