#!/usr/bin/env node
// `npm run lint`: a syntax check of every JavaScript file the package ships or tests,
// with no dependency. Each file is parsed by `node --check`; the first failure is printed
// and the run exits non-zero.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['bin', 'src', 'test', 'scripts'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === 'vendor') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(c|m)?js$/.test(name)) files.push(p);
  }
};
for (const r of roots) {
  try {
    walk(r);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stderr.write(r.stderr);
  }
}
process.stdout.write(`lint: ${files.length} files checked, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
