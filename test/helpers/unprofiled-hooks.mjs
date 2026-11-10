// The load hook for unprofiled-register.mjs: adds "bogus-server" to artifact.js's SERVICES.
const MARK = "export const SERVICES = Object.freeze({";

export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.endsWith("/src/service/artifact.js")) return r;
  const src = String(r.source);
  if (!src.includes(MARK)) throw new Error("unprofiled-hooks: SERVICES not found in artifact.js");
  return { ...r, source: src.replace(MARK, `${MARK}\n  "bogus-server": { package: "@vbcdx/bogus", binaries: ["bogus"], daemon: "bogus" },`) };
}
