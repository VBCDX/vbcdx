// --enroll-token-stdin through the real fd 0: a child whose stdin is a pipe it has
// opened as a stream (libuv makes fd 0 O_NONBLOCK) is fed the token only after it says it is
// reading. One synchronous read of that stdin answers EAGAIN (the control); readEnrollToken must
// still return the token. This test uses only readEnrollToken, so it runs, and fails, on 0.2.13.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const INDEX = new URL("../src/service/index.js", import.meta.url).href;
const TOKEN = "vbx_enr_late7f3";

function lateStdin(mode) {
  const code = [
    `import { readFileSync } from "node:fs";`,
    `const { readEnrollToken } = await import(${JSON.stringify(INDEX)});`,
    // Opens fd 0 as a libuv pipe, which sets O_NONBLOCK on it, without reading from it.
    `process.stdin.pause();`,
    `process.stdout.write("ready\\n");`,
    `try {`,
    `  const t = process.argv[1] === "control" ? readFileSync(0) : readEnrollToken({ enrollTokenStdin: true }, {});`,
    `  process.stdout.write(JSON.stringify({ ok: true, match: t.toString().trim() === ${JSON.stringify(TOKEN)} }) + "\\n");`,
    `} catch (e) {`,
    `  process.stdout.write(JSON.stringify({ ok: false, code: e.code || null }) + "\\n");`,
    `}`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, mode], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    let fed = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the child didn't finish: ${JSON.stringify(out)}`));
    }, 20_000);
    // The child may have exited (the control) before the token is written.
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d) => {
      out += d;
      if (!fed && out.includes("ready\n")) {
        fed = true;
        setTimeout(() => child.stdin.end(`${TOKEN}\n`), 300);
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split("\n")[1];
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`the child printed ${JSON.stringify(out)}`));
      }
    });
  });
}

test("a token piped late into a non-blocking stdin is read, where one read of fd 0 fails", async () => {
  // The harness does reproduce the bug: one read of the same stdin answers EAGAIN.
  assert.deepEqual(await lateStdin("control"), { ok: false, code: "EAGAIN" });
  assert.deepEqual(await lateStdin("reader"), { ok: true, match: true });
});
