# A2A cards server.
#
# Publishes the public A2A agent cards (and the skills catalogue) of the agent
# packs it is given. The server has ZERO runtime dependencies — it uses only
# the Node built-in http module plus the packs' committed role and skill files —
# so there is no npm install step and no package registry is contacted at build
# time. It needs no credentials of any kind; none are copied into the image, set
# in ENV, or present in any layer.
#
# The packs come from the build context's packs/ directory, laid out as
# packs/<package name>/ (for example packs/@scope/agent-pack/, an extracted
# `npm pack` tarball or a checkout). They are copied to node_modules/, where the
# server finds every installed agent pack; or set VBCDX_A2A_PACKS at runtime to
# serve a subset. With no pack the server refuses to start.
#
# Base pinned by explicit version AND digest (Node 22 LTS on Alpine).
FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

ENV NODE_ENV=production
WORKDIR /app

# Copy only what the server needs to run. The installer's renderers/config, the
# tests, and node_modules are intentionally excluded (see .dockerignore); the
# explicit COPY list below is the real allowlist.
COPY package.json ./
COPY bin/a2a-server.js ./bin/a2a-server.js
COPY src/errors.js ./src/errors.js
COPY src/a2a ./src/a2a
COPY src/roles ./src/roles
COPY src/skills ./src/skills
COPY src/packs ./src/packs
COPY src/overlays ./src/overlays
COPY src/config/json.js ./src/config/json.js
COPY src/install/locate.js ./src/install/locate.js
COPY src/sources/lock.js ./src/sources/lock.js
COPY src/sources/config.js ./src/sources/config.js
COPY src/sources/tree.js ./src/sources/tree.js
# The pack and role schemas, read at runtime by src/packs/load.js.
COPY schema ./schema
# The agent packs to serve (runtime data, read through the pack declaration).
COPY packs ./node_modules

# Run as the image's built-in non-root user. The server only reads files.
USER node

# Documented default port. Override PORT / PUBLIC_BASE_URL at runtime.
ENV PORT=8080
EXPOSE 8080

# Liveness against the server's own health route (Node 22 has global fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/a2a-server.js"]
