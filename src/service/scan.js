// No secrets on argv (the service-CLI spec, Security notes).
//
// `vbcdx` scans its whole argv before parsing anything. A token pasted onto the command
// line is already in shell history and in /proc/<pid>/cmdline, so the only safe answer is
// to refuse, tell the user to revoke it, and never repeat it: the error names the prefix
// family and the argument's position, never the value.

import { configError } from "../errors.js";

// The token prefixes the spec lists, plus a Postgres DSN that carries a password.
export const SECRET_PREFIXES = Object.freeze([
  "kh_enr_", "kh_conn_", "kh_sc_", "kh_call_", "kh_live_",
  "dsp_agent_", "dsp_ws_", "dsp_enr_", "dsp_sc_", "dsp_call_", "dsp_inv_",
  "vbx_call_", "vbx_enr_", "au_rt_",
]);
// postgres:// or postgresql://, then userinfo with a password before the @.
const DSN_WITH_PASSWORD = /postgres(?:ql)?:\/\/[^\s/@:]*:[^\s/@]*@/i;

/** The first secret-shaped argument, as {index, kind}, or null. Checks anywhere in the
 *  argument (`--token=kh_live_…`, `x,kh_enr_…`), not only at its start. */
export function findSecretArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const prefix = SECRET_PREFIXES.find((p) => arg.includes(p));
    if (prefix) return { index: i, kind: prefix };
    if (DSN_WITH_PASSWORD.test(arg)) return { index: i, kind: "postgres:// with a password" };
  }
  return null;
}

/** Throw exit 2 if any argument looks like a secret. Called before any parsing or I/O. */
export function refuseSecretArgs(argv) {
  const hit = findSecretArg(argv);
  if (!hit) return;
  throw configError("A secret was passed on the command line; nothing was sent or written.", {
    lines: [
      `A secret was passed on the command line (argument ${hit.index + 1}, ${hit.kind}…); nothing was sent or written.`,
      "Revoke that token now: it is in your shell history and was visible to other processes.",
      "Then pass a new one by stdin (a hidden prompt on a terminal), a 0600 file, or a named environment variable.",
    ],
  });
}
