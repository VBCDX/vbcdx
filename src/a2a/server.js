// A2A cards HTTP server.
//
// A tiny read-only server, built on node:http with no framework and no new
// runtime dependency, that publishes the A2A agent cards. Routes:
//
//   GET /agents/<id>.json          the card for a loaded role (application/a2a+json)
//   GET /agents/  |  /agents/index.json   a JSON index of every loaded role's card
//   GET /.well-known/agent-card.json      a card describing this server
//   GET /skills/                   a JSON index of the skills catalogue
//   GET /skills/<category>/        a JSON index of one category's skills
//   GET /skills/<category>/<NAME>.MD      a skill document (text/markdown)
//   GET /skills/<document>.md      a top-level catalogue document (e.g. the context template)
//   GET /healthz                   liveness
//
// Everything else is 404. Non-GET/HEAD is 405. Neither the <id> path parameter
// nor the /skills segments are ever used as a filesystem path: <id> is matched
// against the loaded role-id allowlist and the /skills segments are resolved
// as keys in a manifest built from the loaded packs' skills trees, so path traversal cannot
// serve an arbitrary file — an unknown, encoded, or traversal segment simply
// misses the allowlist/manifest and 404s.

import http from "node:http";
import {
  getAgentCard,
  buildIndex,
  buildServerCard,
  A2A_MEDIA_TYPE,
} from "./card.js";
import { isKnownRole } from "../roles/index.js";
import {
  getSkillDoc,
  getTopLevelDoc,
  getCategoryIndex,
  buildCatalogueIndex,
  MARKDOWN_MEDIA_TYPE,
} from "../skills/catalogue.js";

const JSON_MEDIA_TYPE = "application/json";

// Matches /agents/<segment>.json with a single path segment. The segment is
// validated against the loaded role-id allowlist below; it is never a path.
const AGENT_CARD_RE = /^\/agents\/([^/]+)\.json$/;

// /skills routes. Two-segment form is a document (category + filename); the
// single-segment form is either a category index or a top-level document. Both
// captured segments are resolved as manifest KEYS, never as filesystem paths —
// see src/skills/catalogue.js for the traversal-safety rationale.
const SKILLS_DOC_RE = /^\/skills\/([^/]+)\/([^/]+)$/;
const SKILLS_SEG_RE = /^\/skills\/([^/]+)\/?$/;

function sendJson(res, status, body, contentType = JSON_MEDIA_TYPE, { headOnly = false } = {}) {
  const payload = JSON.stringify(body, null, 2) + "\n";
  const buf = Buffer.from(payload, "utf8");
  res.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  if (headOnly) res.end();
  else res.end(buf);
}

function sendMarkdown(res, status, text, { headOnly = false } = {}) {
  const buf = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "content-type": `${MARKDOWN_MEDIA_TYPE}; charset=utf-8`,
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  if (headOnly) res.end();
  else res.end(buf);
}

function notFound(res, headOnly) {
  sendJson(res, 404, { error: "not_found" }, JSON_MEDIA_TYPE, { headOnly });
}

// A Host value: a DNS name or IPv4 address, or a bracketed IPv6 address, with an optional port.
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::(\d{1,5}))?$/;
// ...whose port, when present, is a real one (1-65535): `:99999` is not reflected.
const isHost = (v) => {
  const m = HOST_RE.exec(v);
  return Boolean(m) && (m[1] === undefined || (Number(m[1]) >= 1 && Number(m[1]) <= 65535));
};
// A forwarded header may carry a comma-separated chain; the first entry is the client-facing one.
const firstValue = (v) => (typeof v === "string" ? v.split(",")[0].trim() : "");

/**
 * Resolve the public base URL used to build absolute card URLs. A configured
 * PUBLIC_BASE_URL (set on the deployment) always wins so the advertised URLs are
 * correct and resolvable; otherwise it is derived from the request so local runs
 * work, honoring x-forwarded-proto/host set by an edge proxy. Those headers are
 * client-controlled, so the scheme must be http or https and the host a plain host
 * name or address with an optional port; anything else falls back to
 * http and localhost rather than being reflected into the cards.
 */
export function resolveBaseUrl(req, configuredBaseUrl) {
  if (configuredBaseUrl) return configuredBaseUrl;
  const headers = req.headers || {};
  const rawHost = firstValue(headers["x-forwarded-host"]) || firstValue(headers.host);
  const host = isHost(rawHost) ? rawHost : "localhost";
  const rawProto = firstValue(headers["x-forwarded-proto"]).toLowerCase();
  const proto = rawProto === "https" || rawProto === "http" ? rawProto : "http";
  return `${proto}://${host}`;
}

/**
 * Build the (req, res) request handler. `configuredBaseUrl` is optional; when
 * absent the base URL is derived per request.
 */
export function createRequestHandler({ configuredBaseUrl } = {}) {
  return function handle(req, res) {
    const method = req.method || "GET";
    const headOnly = method === "HEAD";
    if (method !== "GET" && !headOnly) {
      res.writeHead(405, { "content-type": `${JSON_MEDIA_TYPE}; charset=utf-8`, allow: "GET, HEAD" });
      res.end(headOnly ? undefined : JSON.stringify({ error: "method_not_allowed" }) + "\n");
      return;
    }

    // Parse only the pathname; ignore query string. A malformed URL 404s.
    let pathname;
    try {
      pathname = new URL(req.url, "http://placeholder").pathname;
    } catch {
      return notFound(res, headOnly);
    }

    const baseUrl = resolveBaseUrl(req, configuredBaseUrl);

    if (pathname === "/healthz") {
      return sendJson(res, 200, { status: "ok" }, JSON_MEDIA_TYPE, { headOnly });
    }

    if (pathname === "/.well-known/agent-card.json") {
      return sendJson(res, 200, buildServerCard(baseUrl), A2A_MEDIA_TYPE, { headOnly });
    }

    if (pathname === "/agents" || pathname === "/agents/" || pathname === "/agents/index.json") {
      return sendJson(res, 200, buildIndex(baseUrl), JSON_MEDIA_TYPE, { headOnly });
    }

    const cardMatch = AGENT_CARD_RE.exec(pathname);
    if (cardMatch) {
      // Decode the captured segment defensively; a malformed escape 404s. The
      // decoded value is checked against the loaded role-id allowlist and is never
      // touched as a filesystem path.
      let id;
      try {
        id = decodeURIComponent(cardMatch[1]);
      } catch {
        return notFound(res, headOnly);
      }
      if (!isKnownRole(id)) return notFound(res, headOnly);
      const card = getAgentCard(id, baseUrl);
      if (!card) return notFound(res, headOnly);
      return sendJson(res, 200, card, A2A_MEDIA_TYPE, { headOnly });
    }

    // Skills catalogue. The manifest lookups treat every segment as a
    // key, so an encoded/traversal/wrong-case segment 404s instead of reaching a file.
    if (pathname === "/skills" || pathname === "/skills/") {
      return sendJson(res, 200, buildCatalogueIndex(baseUrl), JSON_MEDIA_TYPE, { headOnly });
    }

    const skillDocMatch = SKILLS_DOC_RE.exec(pathname);
    if (skillDocMatch) {
      let category, file;
      try {
        category = decodeURIComponent(skillDocMatch[1]);
        file = decodeURIComponent(skillDocMatch[2]);
      } catch {
        return notFound(res, headOnly);
      }
      const doc = getSkillDoc(category, file);
      if (!doc) return notFound(res, headOnly);
      return sendMarkdown(res, 200, doc.content, { headOnly });
    }

    const skillSegMatch = SKILLS_SEG_RE.exec(pathname);
    if (skillSegMatch) {
      let seg;
      try {
        seg = decodeURIComponent(skillSegMatch[1]);
      } catch {
        return notFound(res, headOnly);
      }
      // A known category slug lists that category; otherwise try a top-level
      // document (e.g. the context template). Miss on both is a 404.
      const index = getCategoryIndex(seg, baseUrl);
      if (index) return sendJson(res, 200, index, JSON_MEDIA_TYPE, { headOnly });
      const doc = getTopLevelDoc(seg);
      if (doc) return sendMarkdown(res, 200, doc.content, { headOnly });
      return notFound(res, headOnly);
    }

    return notFound(res, headOnly);
  };
}

/**
 * Create (but do not start) an http.Server. Callers listen and manage lifecycle.
 */
export function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}
