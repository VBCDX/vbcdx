import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "a2a-server.js");
const PACK = join(ROOT, "test", "fixtures", "agent-pack");

// Starts the real server, waits for its "listening on" line, stops it, and returns the line.
function listeningLine(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0", VBCDX_A2A_PACKS: PACK, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no listening line: ${out} ${err}`)); }, 10000);
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.startsWith("a2a-cards: listening on "));
      if (line) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(line);
      }
    });
    child.on("exit", (code) => {
      if (!out.includes("listening on")) { clearTimeout(timer); reject(new Error(`exited ${code}: ${err}`)); }
    });
  });
}

function canBind(host) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(0, host, () => s.close(() => resolve(true)));
  });
}

// The cards server needs no credentials, but it listens only on this host unless told
// otherwise: HOST picks the interface (the container image sets 0.0.0.0).
test("the A2A server listens on 127.0.0.1 unless HOST says otherwise", async () => {
  assert.match(await listeningLine({}), /^a2a-cards: listening on 127\.0\.0\.1:0 /);
  assert.match(await listeningLine({ HOST: "" }), /^a2a-cards: listening on 127\.0\.0\.1:0 /, "an empty HOST is unset");
  assert.match(await listeningLine({ HOST: "0.0.0.0" }), /^a2a-cards: listening on 0\.0\.0\.0:0 /);
  // "::" needs IPv6; a host without it can't bind there, which says nothing about the default.
  if (await canBind("::")) assert.match(await listeningLine({ HOST: "::" }), /^a2a-cards: listening on :::0 /);
});

// PUBLIC_BASE_URL is what a deployment sets so the cards advertise absolute HTTPS URLs;
// when it is unset or empty the listening line derives the base URL from the bound host and
// port, which is what a local run reports. The whole line is pinned, the count and pack name
// included (bin/a2a-server.js:44), so a line that names the wrong base cannot pass.
const SERVING = `, serving ${FIXTURE_IDS.length} roles from example-agents`;
test("the cards server advertises PUBLIC_BASE_URL when set and derives it otherwise", async () => {
  assert.equal(await listeningLine({ PUBLIC_BASE_URL: "https://agents.example" }),
    "a2a-cards: listening on 127.0.0.1:0 (base URL https://agents.example)" + SERVING);
  assert.equal(await listeningLine({ PUBLIC_BASE_URL: "" }),
    "a2a-cards: listening on 127.0.0.1:0 (base URL http://127.0.0.1:0)" + SERVING,
    "an empty PUBLIC_BASE_URL is unset");
});
