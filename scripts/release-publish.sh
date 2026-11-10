#!/usr/bin/env bash
# Publishes this package (@vbcdx/vbcdx) to the test registry users install from, on a v* tag push
# whose name is v<package.json version>:
#   scripts/release-publish.sh        (env: NPM_TEST_REGISTRY, NPM_TEST_REGISTRY_TOKEN, GITHUB_*)
# The registry and the token come from the CI environment only. The URL is never printed (it could
# carry credentials); the log names the host. The token is never written down: npm's config names
# the variable.
set -euo pipefail
fail() { echo "release-publish: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."

[ "${GITHUB_EVENT_NAME:-}" = push ] && [[ ${GITHUB_REF:-} == refs/tags/v* ]] \
  || fail "only a v* tag push is published (event ${GITHUB_EVENT_NAME:-none})"
version=$(node -p 'require("./package.json").version')
[ "${GITHUB_REF#refs/tags/}" = "v$version" ] || fail "the tag is not v$version (package.json's version)"
# package.json's publishConfig can name a registry that npm would use; only the variable decides here.
node -e '
  const pc = require("./package.json").publishConfig || {};
  const keys = Object.keys(pc).filter((k) => k === "registry" || k.endsWith(":registry"));
  if (keys.length) { console.error(keys.join(", ")); process.exit(1); }
' || fail "package.json's publishConfig names a registry; remove it (the registry comes from NPM_TEST_REGISTRY)"

registry=${NPM_TEST_REGISTRY:-}
[ -n "$registry" ] || fail "NPM_TEST_REGISTRY is not set"
[[ $registry == https://*/ ]] || fail "NPM_TEST_REGISTRY must be an https URL ending in /"
authority=${registry#https://}; authority=${authority%%/*}
[[ $authority != *@* ]] || fail "NPM_TEST_REGISTRY must not carry credentials in the URL"
# Compare host names the way a resolver would: case-insensitive, any port dropped, then an optional
# trailing dot (so "Registry.npmjs.org.:443" is still npmjs).
host=${authority,,}
[[ $host =~ ^[a-z0-9.-]+(:[0-9]+)?$ ]] || fail "NPM_TEST_REGISTRY's host is not a plain ASCII host name"
# The URL goes into the npmrc, where npm expands ${...}: the path may hold plain path characters only.
path=${registry#https://"$authority"}
[[ $path =~ ^/[A-Za-z0-9._~/-]*$ ]] || fail "NPM_TEST_REGISTRY's path has characters outside a plain URL path"
name=${host%%:*}; name=${name%.}
# The public registries are a separate, explicitly approved release step, so they can't be the test registry.
case $name in
  registry.npmjs.org|registry.yarnpkg.com|npm.pkg.github.com) fail "NPM_TEST_REGISTRY names a public registry; publishing there is a separate, approved release step";;
esac
[ -n "${NPM_TEST_REGISTRY_TOKEN:-}" ] || fail "the NPM_TEST_REGISTRY_TOKEN secret is empty"
# One line of printable ASCII, so the token can't add lines to the npmrc it is expanded into.
[[ $NPM_TEST_REGISTRY_TOKEN =~ ^[[:graph:]]+$ ]] || fail "the NPM_TEST_REGISTRY_TOKEN secret is not one line of printable characters"

# Every release is published as `next`. `latest` moves only after the published package passes
# its security scan, a separate step done by hand (`npm dist-tag add @vbcdx/vbcdx@<v> latest`),
# so a tag can never make an unscanned package the default install.
tag=next

umask 077
conf=$(mktemp -d)
trap 'rm -rf "$conf"' EXIT
chmod 0700 "$conf"
# npm takes a scoped package's registry from `@scope:registry` before `--registry`, and a project
# .npmrc outranks --userconfig, so the scope is also given on the command line. The userconfig holds
# only this registry's token line; npm expands ${NPM_TEST_REGISTRY_TOKEN} from the environment.
{
  printf '@vbcdx:registry=%s\n' "$registry"
  printf '//%s:_authToken=${NPM_TEST_REGISTRY_TOKEN}\n' "${registry#https://}"
} > "$conf/npmrc"
npm publish . --registry "$registry" "--@vbcdx:registry=$registry" --userconfig "$conf/npmrc" --tag "$tag"
echo "release-publish: @vbcdx/vbcdx@$version published to $host as $tag"
