// The minisign public keys a service release must be signed with (the service-CLI spec, npm shipping).
//
// Pinned in the installer's own source, never taken from the release, an environment
// variable or a flag: a release that ships its own key proves nothing. Each key is added
// (and removed) by a reviewed PR; with none, every install fails closed (exit 5).
export const RELEASE_KEYS = Object.freeze([
  // DEV release key 1 (key id 93226C4C92D7E33C): the releases published so far are signed with
  // it. It stays until nothing live needs it, then a reviewed PR removes it.
  "RWQ849eSTGwikxhwcRqPpuACfXMuTCJ4CJzvVDdC5atdTp0ZoeC23oTN",
  // DEV release key 3 (key id 17624991E82371C7): vbcdx-core, Keyhole and Dispatch sign with it
  // from their next tags. The two overlap so that a release signed by either installs while the
  // services switch. (DEV key 2, 7D5C2CEF9DD5C7D1, was never usable and never signed anything,
  // so it is no longer trusted.) Before any public npmjs release a fresh release key replaces both.
  "RWTHcSPokUliF6d2l3YdaFadHPLP85gvPsaLDo+66LQ5AleMffYib9Iq",
]);
