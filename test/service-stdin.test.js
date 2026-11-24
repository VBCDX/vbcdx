// --enroll-token-stdin's reader: fd 0 is read to EOF in a bounded loop. A
// non-blocking stdin that has nothing yet (EAGAIN) is tried again until the token arrives, up to a
// deadline; more than a token is never read; an EOF error ends the read; anything else is passed on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readEnrollToken, readStdinBounded, STDIN_WAIT_MS } from "../src/service/index.js";

const TOKEN_MAX = 4096;

// A scripted fd 0 on a fake clock. Each step is "again" (EAGAIN), "wouldblock", "eof" or "eio"
// (that error), a chunk of data, or 0 (end of input). The last step repeats, and a loop that
// would never stop fails the test instead of hanging it.
function fakeIo(steps) {
  let i = 0;
  const io = {
    t: 0,
    reads: 0,
    sleeps: 0,
    now: () => io.t,
    sleep: (ms) => {
      io.sleeps += 1;
      io.t += ms;
    },
    read: (buf, off, len) => {
      io.reads += 1;
      if (io.reads > 10_000) throw new Error("runaway read loop");
      const s = steps[Math.min(i++, steps.length - 1)];
      const codes = { again: "EAGAIN", wouldblock: "EWOULDBLOCK", eof: "EOF", eio: "EIO" };
      if (codes[s]) throw Object.assign(new Error(`${codes[s]}: read`), { code: codes[s] });
      if (s === 0) return 0;
      const chunk = Buffer.from(s);
      const n = Math.min(len, chunk.length);
      chunk.copy(buf, off, 0, n);
      return n;
    },
  };
  return io;
}

test("a non-blocking stdin with nothing yet is tried again until the token and EOF arrive", () => {
  const io = fakeIo(["again", "again", "wouldblock", "vbx_enr_ab", "cd\n", 0]);
  assert.equal(readStdinBounded(TOKEN_MAX, io).toString(), "vbx_enr_abcd\n");
  assert.equal(io.sleeps, 3, "one wait per empty read");
  // EAGAIN between chunks doesn't end the read early.
  const mid = fakeIo(["vbx_enr_", "again", "tail", 0]);
  assert.equal(readStdinBounded(TOKEN_MAX, mid).toString(), "vbx_enr_tail");
});

test("a stdin that never delivers is refused at the deadline, and names no bytes", () => {
  const io = fakeIo(["again"]);
  assert.throws(() => readStdinBounded(TOKEN_MAX, io), (e) => {
    assert.match(e.message, new RegExp(`^No enrollment token arrived on stdin within ${STDIN_WAIT_MS / 1000} s; nothing was written\\.$`));
    return true;
  });
  assert.ok(io.t >= STDIN_WAIT_MS && io.t < STDIN_WAIT_MS + 1000, `gave up at ${io.t} ms`);
  // Data that has arrived doesn't extend the wait for the rest forever.
  const partial = fakeIo(["vbx_enr_a", "again"]);
  assert.throws(() => readStdinBounded(TOKEN_MAX, partial), /No enrollment token arrived on stdin/);
});

test("more than a token is read only up to one byte past the limit, then refused", () => {
  const io = fakeIo([Buffer.alloc(1000, "a")]);
  const out = readStdinBounded(TOKEN_MAX, io);
  assert.equal(out.length, TOKEN_MAX + 1);
  assert.ok(io.reads <= 5, `read ${io.reads} times`);
  assert.throws(() => readEnrollToken({ enrollTokenStdin: true }, {}, () => out), /stdin is larger than an enrollment token/);
});

test("an EOF error ends the read; any other error is passed on", () => {
  assert.equal(readStdinBounded(TOKEN_MAX, fakeIo(["vbx_enr_x", "eof"])).toString(), "vbx_enr_x");
  assert.throws(() => readStdinBounded(TOKEN_MAX, fakeIo(["eio"])), (e) => e.code === "EIO");
  // The default reader is the bounded one: the token it returns is the one stdin carried.
  const io = fakeIo(["vbx_enr_ok7f3\n", 0]);
  const t = readEnrollToken({ enrollTokenStdin: true }, {}, () => readStdinBounded(TOKEN_MAX, io));
  assert.equal(t.toString(), "vbx_enr_ok7f3");
});
