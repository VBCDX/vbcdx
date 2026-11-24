# Accepted risks

These are known weaknesses that this release ships with on purpose. Each one says what an attacker
can do, why it is accepted for now, what limits or reveals it, what would make it unacceptable,
and how it is closed. They are already in the design docs; this page collects them in one place.

The risks that cross components are on this page in each VBCDX repository (vbcdx, vbcdx-core,
keyhole, dispatch). A risk that is in one component only is listed only in that component's
repository. Each risk names the component it is in.

If something listed under "What makes it unacceptable" is true of your deployment, treat the risk
as open: don't rely on the premise.

## A compromised control plane can obtain any granted tool key

**Component:** the control plane (vbcdx-control) and Keyhole's resolve path. It affects every
service that calls a tool through a sidecar.

**What an attacker can do.** Someone who controls the control plane (its process, its service user
or its host) can obtain the clear value of any tool key that is granted in the organizations
Keyhole accepts that control plane for. They can do it at any time, even with no sidecar online.
Keyhole seals each value to a request key that the asker sends with the request. The control plane
vouches for which sidecar is asking, and the request key is not yet bound to that sidecar. So a
control plane that lies can name a sidecar and a principal, send a request key of its own, and open
the reply. It can also swap the request key on a real sidecar's request. A sidecar certificate
can't prevent this, because the control plane is also the tunnel's certificate authority.

**What still holds.** An honest control plane only relays sealed values, so a value is not in its
memory, logs or traces. A relay that changes a tool's definition on the way can't point a key at
another address or tool: the value doesn't open. Keyhole still refuses an agent it doesn't hold as
active in the organization, whatever the control plane asserts.

**Why it is accepted.** The fix needs a key for each sidecar that an organization's administrator
registers in Keyhole directly, outside the control plane, and a new seal format that binds the
request key to it. That adds a Keyhole step to every sidecar enrollment and a format change in two
components at once. This release assumes that one operator runs both the control plane and
Keyhole, and its security docs list the control plane among the things you trust.

**What limits or reveals it.**
- Keyhole writes an audit record for every value it releases, before it releases it, in its own
  store, which the control plane's service user can't write. It releases nothing if that record
  can't be written. The record says who the value was for, which sidecar was named, and the tool
  and slot.
- Each sidecar logs every tool call it makes, at the default log level: the organization, the
  tool, the slot and the time. A release in Keyhole's audit log that the named sidecar's log
  doesn't show is how you would see a control plane asking on its own. This doesn't reveal a
  request key swapped on a call the sidecar really made: both logs then agree. Only the fix under
  "How it is closed" stops that.
- If the control plane and Keyhole run on the same host, root on that host can read Keyhole's keys
  and its store directly, so these records don't help against root there. Keep the control-plane
  host as closely held as the Keyhole host.

**What makes it unacceptable.** Any one of these:
1. The control plane is run by a party other than Keyhole's operator (a hosted or multi-tenant
   control plane).
2. One Keyhole serves more than one control plane.
3. Keyhole's resolve audit becomes optional or best-effort, or a value can be released without its
   audit record.

**How it is closed.** A later release registers a key for each sidecar in Keyhole and binds every
request key to it. A control plane that swaps the request key, or sends one of its own, then gets a
reply it can't open.
