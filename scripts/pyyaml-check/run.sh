#!/bin/sh
# Checks src/fs/pyyaml.js against real PyYAML, the parser Hermes loads config.yaml
# with: SafeLoader (Web UI) and libyaml's CSafeLoader (agent). Needs
# python3 with PyYAML (compiled with libyaml) and node; not part of `npm test`.
#
# For a corpus of ~7000 curated and random scalars (as values and as keys) and typed
# values (int, float, big int, inf/nan, date, datetime), dumped by PyYAML with and
# without allow_unicode:
#   each:    every PyYAML dump parses to what both PyYAML loaders read, or is refused
#   1 parse: parsePy reads a whole dump as PyYAML does
#   2 edit:  a document written back in place loads in PyYAML to the original
#   3 fresh: strings and numbers written by stringifyPy load in PyYAML as written
# Every line must report 0 mismatches / 0 wrong values.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
cd "$work"
for seed in ${SEEDS:-1 2 3}; do
  echo "## seed $seed"
  python3 "$here/gen.py" "$seed"
  python3 "$here/each.py"
  node "$here/each.mjs" | grep -E "^(v|k):"
  node "$here/roundtrip.mjs"
  python3 "$here/compare.py"
done
echo "work files: $work"
