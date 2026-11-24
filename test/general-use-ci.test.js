// The general-use gate runs, and cannot be switched off quietly: the CI workflow starts it on
// every pull request and on every push to main, and the job runs the scan, the directory check,
// the self-test and the gate's tests, with nothing that would let a failure pass. The pull
// request's scan is one script that starts the base branch's gate.mjs: it is pinned here as a
// whole, so any change to it is noticed. The scans are the first commands of the job: the
// other three run the pull request's own code, and nothing of it may run before the base
// branch's gate has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = readFileSync(join(ROOT, ".forgejo", "workflows", "ci.yml"), "utf8");

/** The pull request step's script, exactly (ci/general-use/README.md). */
export const PR_STEP = [
  "set -euo pipefail",
  'GATE="ci/general-use/gate.mjs"',
  'LISTED="$(git ls-tree --name-only "origin/$BASE_REF" -- "$GATE")"',
  'if [ -n "$LISTED" ]; then',
  '  BASE_COPY="$(mktemp -d)"',
  "  trap 'rm -rf -- \"$BASE_COPY\"' EXIT",
  '  git show "origin/$BASE_REF:$GATE" > "$BASE_COPY/gate.mjs"',
  '  node "$BASE_COPY/gate.mjs" --base "origin/$BASE_REF"',
  "else",
  '  echo "general-use: origin/$BASE_REF has no $GATE yet: this tree\'s copy runs the gate"',
  '  node "$GATE" --base "origin/$BASE_REF"',
  "fi",
].join("\n");
const PUSH_STEP = "node ci/general-use/scan.mjs --head-commit";

/** Every reason the workflow does not run the gate as it must. Empty means it does. */
export function gateProblems(text) {
  const wf = parse(text);
  const out = [];
  const on = wf.on && typeof wf.on === "object" && !Array.isArray(wf.on) ? wf.on : {};
  if (!("pull_request" in on)) out.push("no pull_request trigger");
  else if (on.pull_request !== null) out.push("the pull_request trigger is filtered");
  if (!("push" in on)) out.push("no push trigger");
  else if (!(on.push && Array.isArray(on.push.branches) && on.push.branches.includes("main"))) out.push("the push trigger does not name main");
  else if (Object.keys(on.push).some((k) => k !== "branches")) out.push("the push trigger is filtered by more than branches");
  const job = wf.jobs && wf.jobs["general-use"];
  if (!job) return [...out, "no general-use job"];
  for (const k of ["if", "continue-on-error", "needs", "strategy"]) if (k in job) out.push(`the job has ${k}`);
  const steps = job.steps || [];
  const runs = steps.map((s) => (typeof s.run === "string" ? s.run.trim() : ""));
  const at = (cmd) => runs.indexOf(cmd);
  const checks = ["node ci/general-use/verify-dir.mjs", "node ci/general-use/scan.mjs --self-test", "node --test ci/general-use/scan.test.mjs"];
  const order = [PR_STEP, PUSH_STEP, ...checks];
  for (const cmd of order) if (at(cmd) === -1) out.push(cmd === PR_STEP ? "no step runs exactly the pinned pull request script" : `no step runs exactly: ${cmd}`);
  if (order.every((c) => at(c) !== -1) && order.some((c, i) => i > 0 && at(c) < at(order[i - 1]))) out.push("the steps are out of order");
  // Before the scans: the checkout and the Node set-up, and no command at all.
  const firstScan = Math.min(...[PR_STEP, PUSH_STEP].map(at).filter((i) => i !== -1), steps.length);
  for (const s of steps.slice(0, firstScan)) {
    if (!(typeof s.uses === "string" && /^actions\/(checkout|setup-node)@/.test(s.uses)) || "run" in s) out.push("a step other than the checkout and the Node set-up comes before the scans");
  }
  if (at(PR_STEP) !== -1 && at(PUSH_STEP) !== -1 && at(PUSH_STEP) - at(PR_STEP) !== 1) out.push("the two scans are not next to each other, the pull request's first");
  for (const s of steps) {
    if ("continue-on-error" in s) out.push("a step has continue-on-error");
    // The pinned script is the one step that may hold several lines: it is compared whole.
    const run = typeof s.run === "string" ? s.run.trim() : "";
    if (run !== PR_STEP && /\|\||;|\n|&&|\bexit\b/.test(run)) out.push("a step's command could mask a failure");
  }
  const pr = steps[at(PR_STEP)] || {};
  const push = steps[at(PUSH_STEP)] || {};
  if (pr.if !== "github.event_name == 'pull_request'") out.push("the pull request scan has another condition");
  if (!(pr.env && pr.env.BASE_REF === "${{ github.base_ref }}")) out.push("the base is not the pull request's base branch");
  if (push.if !== "github.event_name != 'pull_request'") out.push("the push scan has another condition");
  for (const cmd of checks) if ("if" in (steps[at(cmd)] || {})) out.push("a check step is conditional");
  const checkout = steps.find((s) => typeof s.uses === "string" && /(^|\/)checkout@/.test(s.uses)) || {};
  if (!(checkout.with && checkout.with["fetch-depth"] === 0)) out.push("the checkout is shallow: the commit range could not be found");
  return out;
}

test("the CI workflow runs the general-use gate on pull requests and on pushes to main", () => {
  assert.deepEqual(gateProblems(TEXT), []);
});

// The first line of a step of the job, and a change that moves one step to stand before another.
const STEP = {
  pr: "      - name: Scan the tree and the pull request's commit messages",
  push: "      - name: Scan the tree and the head commit's message (a push)",
  verify: "      - name: The gate's directory is the pinned copy",
  selfTest: "      - name: The rule set checks itself",
  tests: "      - name: The gate's own tests",
};
function move(text, step, before) {
  const from = text.indexOf(step);
  const end = text.indexOf("\n\n", from) + 2;
  assert.ok(from !== -1 && end > 1, "the step to move was found");
  const block = text.slice(from, end);
  const rest = text.slice(0, from) + text.slice(end);
  assert.ok(rest.includes(before), "the step to move it before was found");
  return rest.replace(before, block + before);
}

// Each change must be noticed: the gate would otherwise stop running, or stop failing.
const changes = [
  ["the push trigger is removed", (t) => t.replace("  push:\n    branches: [main]\n", ""), /no push trigger/],
  ["the pull_request trigger is removed", (t) => t.replace("  pull_request:\n", ""), /no pull_request trigger/],
  ["pushes are limited to tags", (t) => t.replace("  push:\n    branches: [main]\n", '  push:\n    tags: ["v*"]\n'), /does not name main/],
  ["pushes are also filtered by path", (t) => t.replace("    branches: [main]\n", "    branches: [main]\n    paths: [src/**]\n"), /more than branches/],
  ["pull requests are filtered by path", (t) => t.replace("  pull_request:\n", "  pull_request:\n    paths: [src/**]\n"), /pull_request trigger is filtered/],
  ["the job is removed", (t) => t.replace("  general-use:\n", "  general-use-off:\n"), /no general-use job/],
  ["the job is conditional", (t) => t.replace("  general-use:\n", "  general-use:\n    if: false\n"), /the job has if/],
  ["the job may fail", (t) => t.replace("  general-use:\n", "  general-use:\n    continue-on-error: true\n"), /the job has continue-on-error/],
  ["the self-test is dropped", (t) => t.replace("run: node ci/general-use/scan.mjs --self-test\n", "run: echo skipped\n"), /--self-test/],
  ["the directory check is dropped", (t) => t.replace("run: node ci/general-use/verify-dir.mjs\n", "run: echo skipped\n"), /verify-dir/],
  ["the gate's tests are dropped", (t) => t.replace("run: node --test ci/general-use/scan.test.mjs\n", "run: echo skipped\n"), /scan\.test\.mjs/],
  ["the push scan's failure is swallowed", (t) => t.replace("run: node ci/general-use/scan.mjs --head-commit\n", "run: node ci/general-use/scan.mjs --head-commit || true\n"), /--head-commit/],
  ["the push scan is tree-only again", (t) => t.replace("run: node ci/general-use/scan.mjs --head-commit\n", "run: node ci/general-use/scan.mjs --tree-only\n"), /--head-commit/],
  ["commit messages only warn", (t) => t.replace('node "$BASE_COPY/gate.mjs" --base "origin/$BASE_REF"\n', 'node "$BASE_COPY/gate.mjs" --base "origin/$BASE_REF" --commit-messages warn\n'), /pinned pull request script/],
  ["the pull request's own gate runs although the base has one", (t) => t.replace('node "$BASE_COPY/gate.mjs" --base', 'node "$GATE" --base'), /pinned pull request script/],
  ["the pull request scan's failure is swallowed", (t) => t.replace('node "$BASE_COPY/gate.mjs" --base "origin/$BASE_REF"\n', 'node "$BASE_COPY/gate.mjs" --base "origin/$BASE_REF" || true\n'), /pinned pull request script/],
  ["the script no longer stops on an error", (t) => t.replace("set -euo pipefail\n          GATE=", "GATE="), /pinned pull request script/],
  ["the range is the branch against itself", (t) => t.replace("BASE_REF: ${{ github.base_ref }}", "BASE_REF: ${{ github.head_ref }}"), /base branch/],
  ["the push scan never runs", (t) => t.replace("if: github.event_name != 'pull_request'", "if: false"), /push scan has another condition/],
  ["the pull request scan never runs", (t) => t.replace("        if: github.event_name == 'pull_request'\n        env:", "        if: false\n        env:"), /pull request scan has another condition/],
  ["the pull request's code runs before the base gate", (t) => move(t, STEP.verify, STEP.pr), /out of order/],
  ["the pull request's tests run before the base gate", (t) => move(t, STEP.tests, STEP.pr), /out of order/],
  ["the pull request's code runs between the two scans", (t) => move(t, STEP.selfTest, STEP.push), /out of order/],
  ["another command runs before the scans", (t) => t.replace(STEP.pr, `      - run: echo ready\n\n${STEP.pr}`), /a step other than the checkout and the Node set-up comes before the scans/],
  ["another action runs before the scans", (t) => t.replace(STEP.pr, `      - uses: example/prepare@v1\n\n${STEP.pr}`), /a step other than the checkout and the Node set-up comes before the scans/],
  ["a command is attached to the checkout step", (t) => t.replace("          fetch-depth: 0\n", "          fetch-depth: 0\n        run: echo early\n"), /a step other than the checkout and the Node set-up comes before the scans/],
  ["a command runs between the two scans", (t) => t.replace(STEP.push, `      - run: echo between\n\n${STEP.push}`), /not next to each other/],
  ["an action runs between the two scans", (t) => t.replace(STEP.push, `      - uses: example/prepare@v1\n\n${STEP.push}`), /not next to each other/],
  ["the checkout is shallow", (t) => t.replace("          fetch-depth: 0\n", ""), /shallow/],
];
for (const [what, change, want] of changes) {
  test(`the workflow check notices when ${what}`, () => {
    const changed = change(TEXT);
    assert.notEqual(changed, TEXT, "the change applied");
    assert.ok(gateProblems(changed).some((p) => want.test(p)), JSON.stringify(gateProblems(changed)));
  });
}
