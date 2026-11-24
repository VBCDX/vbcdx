// The A2A cards server's drain fail-safe (bin/a2a-server.js:47-51). server.close() stops
// accepting and destroys connections that are idle, but a connection that is still sending a
// request is not idle: close() waits for it, and its callback — which is what exits the process
// — never runs. So a client that sends a request and then stops makes a plain stop hang until
// that client goes away, which is what this test pins: the timer armed in shutdown() is the
// only thing that ends the process, which it does about five seconds after the signal, with
// status 0 and the shutdown line printed once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_PACK_DIR } from "./helpers/fixture-pack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "a2a-server.js");

// A port nothing is using: bind one on the loopback, take the number the kernel gave, close it.
// The server is spawned with that number rather than 0, because PORT is also what the listening
// line prints (bin/a2a-server.js:44): with PORT=0 the line ends in ":0" while listen(0) bound an
// ephemeral port, so a client that dials the printed number gets ECONNREFUSED (test/a2a-bin.test.js
// pins that printed ":0" for an unset PORT).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Starts the real server and resolves once it prints its listening line. A child that never
// listens is killed here, so a failed start cannot outlive the test.
function start(port) {
  const child = spawn(process.execPath, [BIN], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), VBCDX_A2A_PACKS: FIXTURE_PACK_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, out: "", err: "" };
  return new Promise((resolve, reject) => {
    const fail = (err) => { child.kill("SIGKILL"); reject(err); };
    const timer = setTimeout(() => fail(new Error(`no listening line: ${state.err}`)), 10000);
    child.stdout.on("data", (d) => {
      state.out += d;
      const line = state.out.split("\n").find((l) => l.startsWith("a2a-cards: listening on "));
      if (line) { clearTimeout(timer); resolve(state); }
    });
    child.stderr.on("data", (d) => { state.err += d; });
    child.on("exit", (code) => {
      if (!state.out.includes("listening on")) {
        clearTimeout(timer);
        fail(new Error(`exited ${code} before listening: ${state.err}`));
      }
    });
  });
}

// The exit status, or a rejection when the child is still running after `ms`.
function exitWithin(child, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`still running after ${ms} ms: the drain fail-safe did not fire`));
    }, ms);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

test("a client that stops sending cannot hold the server open past the drain fail-safe", async (t) => {
  const port = await freePort();
  const state = await start(port);
  const { child } = state;
  // Whatever the assertions do below, the child and the socket are gone when the test ends, so
  // a failed row reports and returns instead of holding the job open.
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => { child.kill("SIGKILL"); socket.destroy(); });
  // The line names the port that was actually bound, which is what the client dials below.
  assert.match(state.out, new RegExp(`^a2a-cards: listening on 127\\.0\\.0\\.1:${port} `, "m"), state.out);

  // A request that never ends: the headers stop short of the blank line that terminates them,
  // so the connection is still sending and close() waits for it. Nothing is read back either.
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const started = Date.now();
  child.kill("SIGTERM");
  const { code, signal } = await exitWithin(child, 15000);
  const elapsed = Date.now() - started;
  socket.destroy();

  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.deepEqual(state.out.split("\n").filter((l) => l.startsWith("a2a-cards: received ")),
    ["a2a-cards: received SIGTERM, shutting down"]);
  // close() had not returned — the connection was still sending — so only the timer ends it.
  assert.ok(elapsed >= 4500, `ended without waiting for the drain fail-safe: ${elapsed} ms`);
  assert.ok(elapsed < 10000, `the fail-safe did not fire at five seconds: ${elapsed} ms`);
});
