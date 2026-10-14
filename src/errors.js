// Exit-code taxonomy (spec section 10).
//
// The installer never uses a bare process.exit with an ad-hoc number. Every
// failure raises an InstallerError carrying one of these codes, and the CLI
// entrypoint maps the raised code to the process exit status. Deterministic
// first-failed-phase precedence is enforced by validating in phase order:
// CLI/config (2) -> credentials (3) -> filesystem safety (4) ->
// generated-content/scope/dependency (5) -> native subprocess (6).
//
//   0  requested writes / staging completed
//   2  CLI or configuration syntax, unsupported values, invalid paths,
//      or invalid role selection
//   3  credential validation
//   4  filesystem safety, permissions, ownership, lock, or write failure
//   5  generated-content conflict, unsupported native scope, or known
//      dependency / harness incompatibility
//   6  native subprocess failure or timeout

export const EXIT = Object.freeze({
  OK: 0,
  CONFIG: 2,
  CREDENTIAL: 3,
  FILESYSTEM: 4,
  CONFLICT: 5,
  SUBPROCESS: 6,
});

export class InstallerError extends Error {
  /**
   * @param {number} code   one of EXIT.*
   * @param {string} message actionable, secret-free message
   * @param {object} [details] optional structured, secret-free context. `details.lines`
   *   is the message's own line layout (a headline, then one line per item), so a CLI
   *   can escape the values in each line without collapsing the layout.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const configError = (m, d) => new InstallerError(EXIT.CONFIG, m, d);
export const credentialError = (m, d) => new InstallerError(EXIT.CREDENTIAL, m, d);
export const filesystemError = (m, d) => new InstallerError(EXIT.FILESYSTEM, m, d);
export const conflictError = (m, d) => new InstallerError(EXIT.CONFLICT, m, d);
export const subprocessError = (m, d) => new InstallerError(EXIT.SUBPROCESS, m, d);
