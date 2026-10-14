# packs/

Build context for the A2A cards image (see `Dockerfile`). Put the agent packs the
image should serve here, laid out as `packs/<package name>/`, for example
`packs/@scope/agent-pack/` holding an extracted `npm pack` tarball. The directory
is copied to the image's `node_modules/`, where the server finds every agent pack
(a package with `vbcdx-pack.json` at its root). Nothing here is committed except
this file.
