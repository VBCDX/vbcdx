# Installing the Dispatch server

Dispatch is a control-plane service: agents' requests reach it through their sidecar, the
control plane checks who they are, and it forwards them to Dispatch over a mutual-TLS link.
`vbcdx install service dispatch-server` installs the Dispatch server in that mode (control-plane mode),
from its own signed release, `@vbcdx/dispatch`.

This server is all there is to install for Dispatch: agents' sidecars carry their Dispatch
calls over their tunnel with nothing added on the agent side.

In this version:

- it installs as root only, as a system service running as the user `vbcdx-dispatch`;
- it runs in control-plane mode only: `--link-listen` and `--control-url` are required;
- the release is verified exactly as the sidecar's is (the same pinned release key).

## Install

You need the control plane's tunnel listener address (`vbcdx-control` with `--tunnel`; see
[control-plane.md](control-plane.md)) and the address the control plane will dial this
server's link on. Pick a link port that nothing else uses. On a host that also runs the control
plane, its tunnel already holds its port (8443 in control-plane.md), so the examples here use
8444. Install refuses a `--listen` or `--link-listen` something already listens on, before it
writes anything.

Three names, one service: the installer calls the server `dispatch-server`, while the control
plane registers it as `dispatch` (`services add dispatch`, the name in the certificate,
`vbcdx:service/dispatch`). `vbcdx install service dispatch` (no `-server`) is a usage error that
names `dispatch-server`.

`--version` names a version of `@vbcdx/dispatch`. See what is published, and which version each
dist-tag points at, with `npm view @vbcdx/dispatch versions dist-tags`.

```sh
sudo vbcdx install service dispatch-server --version <version> \
  --link-listen 0.0.0.0:8444 --control-url https://<control host>:<tunnel port> --dry-run   # review the plan
sudo vbcdx install service dispatch-server --version <version> \
  --link-listen 0.0.0.0:8444 --control-url https://<control host>:<tunnel port>
```

| Flag | Meaning | Default |
|------|---------|---------|
| `--link-listen <host>:<port>` | where the link listener binds; the control plane dials it | required |
| `--control-url https://<host>:<port>` | the control plane's tunnel listener, for its key set | required |
| `--listen <host>:<port>` | the web app and API | `127.0.0.1:8080` |
| `--public-url <url>` | the URL people open; `https` unless loopback | `http://<--listen>` |
| `--service-cert <file>` | the link certificate from `vbcdx-control services add dispatch` | none |

The first install makes the link key and its certificate request, as `vbcdx-dispatch`, in the
state directory. The key never leaves it. The unit is installed but **not started** yet, and
install prints the next step (`next:`, the `services add dispatch` command below).

## The link certificate

1. Copy `/var/lib/vbcdx-dispatch/default/link.csr` (a request, not a secret) to the control host,
   for example to `/var/lib/vbcdx-control/default/dispatch.csr`, readable by `vbcdx-control`. Then
   run, there, with the address the control plane dials this host's `--link-listen` on, plus
   Dispatch's link path `/vbcdx/v1` (the control plane forwards each request to `<url>/<path>`):

   ```sh
   sudo runuser -u vbcdx-control -- /usr/local/lib/vbcdx/control-plane/current/vbcdx-control \
     services add dispatch --url https://<this host>:8444/vbcdx/v1 \
     --csr /var/lib/vbcdx-control/default/dispatch.csr \
     --cert-out /var/lib/vbcdx-control/default/dispatch.crt \
     --instance default --instance-dir /etc/vbcdx-control/default
   ```

   On the same host the copy is still needed: the CSR's directory is 0700 `vbcdx-dispatch` (the
   table below), so `vbcdx-control` can't read it in place. Copy it as root into the control
   plane's state directory, then run the command above:

   ```sh
   sudo install -m 0644 -o vbcdx-control -g vbcdx-control \
     /var/lib/vbcdx-dispatch/default/link.csr /var/lib/vbcdx-control/default/dispatch.csr
   ```

2. Copy `dispatch.crt` back (or use it in place on the same host), then run the same install again with it:

   ```sh
   sudo vbcdx install service dispatch-server --version <version> \
     --service-cert /var/lib/vbcdx-control/default/dispatch.crt
   ```

   The other settings (`--listen`, `--link-listen`, `--control-url`, `--public-url`) are kept from
   what is installed, as for every service. A flag you give changes only its own setting.

   The certificate is written next to the key (0600, `vbcdx-dispatch`), then the installed
   `dispatch check` runs as that user. It checks that the certificate names the Dispatch service,
   chains to the control plane's CA and fits the key. Only then does the unit start. A certificate
   it refuses is taken out again, and nothing starts.

   `dispatch.crt` holds the service certificate, then the control plane's CA. That CA is the only
   root Dispatch trusts, for both directions of the link: the control plane's calls into
   `--link-listen` (it must present the `vbcdx:control` client certificate), and Dispatch's own
   HTTPS to `--control-url` for the control plane's keys. The system CA store is never used, so
   `--control-url` needs no pin.

A replaced certificate (after `services add dispatch --replace`) goes in the same way and
restarts the unit.

What install puts down (instance `default`; `--instance <name>` for another):

| What | Where | Mode, owner |
|------|-------|-------------|
| user and group | `vbcdx-dispatch` (system, no login shell) | |
| binary | `/usr/local/lib/vbcdx/dispatch-server/<version>/dispatch` | 0755 root |
| settings | `/etc/vbcdx-dispatch/default/dispatch.env` (the unit's `EnvironmentFile=`) | 0640 root:vbcdx-dispatch |
| state: the database, the message store, `link.key`, `link.csr`, `link.crt` | `/var/lib/vbcdx-dispatch/default` | 0700 vbcdx-dispatch |
| unit | `/etc/systemd/system/vbcdx-dispatch-server-default.service` | 0644 |

`dispatch.env` holds no secret. The unit runs `dispatch check` before every start, then
`dispatch serve`, with the same hardening as the sidecar's unit.

## Check it

```sh
sudo vbcdx doctor --service dispatch-server
```

It checks the binary, the settings file, the state directory, `link.key` (0600), `link.crt`,
the installed `dispatch check` (run as `vbcdx-dispatch`) and the unit. It exits 0 when all pass
and 5 when one fails, naming it.

## Upgrade and remove

Run install with the new `--version`: the settings, key and certificate stay. An older version is
refused unless you pass `--allow-downgrade`.

```sh
sudo vbcdx remove service dispatch-server          # the unit, settings and binary; state stays
sudo vbcdx remove service dispatch-server --wipe   # in place of the line above: also the state (database, key, certificate)
```

Choose one. After a plain remove the instance is no longer recorded, so a later `--wipe` exits 2
and deletes nothing; remove names the state directory it keeps.

Revoke the link on the control host too:

```sh
sudo runuser -u vbcdx-control -- /usr/local/lib/vbcdx/control-plane/current/vbcdx-control \
  services revoke dispatch --yes --instance default --instance-dir /etc/vbcdx-control/default
```
