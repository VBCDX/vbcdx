"""LiteLLM web provider: search **and** page fetch through the gateway's search tools.

One backend with two capabilities, because a snippet cannot settle a disputed
claim — a split-brain verdict has to be adjudicated against the source, quoted:

* **search** — ``POST {LITELLM_SEARCH_BASE}/v1/search/{LITELLM_SEARCH_TOOL}`` with
  ``{"query", "max_results"}``, answered with ``{"results": [{"title", "url",
  "snippet"}]}``.
* **fetch** — ``GET`` a result's URL and return its readable text.

The gateway URL and the search tool name are the installer's
(``VBCDX_AGENTS_HERMES_WEB_SEARCH_URL`` / ``_TOOL``), rendered into this file when the
profile is written; ``LITELLM_SEARCH_BASE`` / ``LITELLM_SEARCH_TOOL`` in the profile's own
environment override them. There is no default for either: with no gateway configured a
search reports "not configured" and contacts no host.

The LiteLLM virtual key is read **by name** from the profile's own environment
(``HERMES_PROVIDER_API_KEY`` — the name the setup picker asks for, which therefore
wins — else the legacy ``LITELLM_SEARCH_API_KEY``). It is sent to the gateway and
nowhere else: it is never logged, never echoed into a tool result, never attached to
a fetched page, and never survives into an error message. Neither request follows a
redirect — a 3xx is reported and refused — so a ``Location`` header can never
re-send the key to another host. That refusal is the one already established for the
forgejo token in ``assets/hermes/hermes-git.py`` (``NoRedirect`` built into the one
opener). This provider is read-only — it issues search queries and page reads and
writes nothing anywhere.

Every failure returns its own visible error and never softens into "no results":
an unset key, an unconfigured gateway, an unknown or unconfigured search tool, HTTP 429, HTTP 500, a
redirect, a 200 body with no ``results`` field, an unreachable page and an empty
page all read differently. An HTTP error also carries the gateway's own
explanation when it supplies one, redacted and bounded. A role that reads "no
results" concludes "nothing contradicts this", which is the one wrong answer in a
tie break.

Selected with ``web.search_backend: litellm-search`` and
``web.extract_backend: litellm-search``.

Depends only on the public provider ABC (``agent.web_search_provider``), not on
Hermes' private ``plugins.web._common`` plumbing, so the repo's own test can
exercise this file for real.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import logging
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any, Dict, List, Tuple

from agent.web_search_provider import WebSearchProvider, get_provider_env

logger = logging.getLogger(__name__)

NAME = "litellm-search"
DISPLAY_NAME = "LiteLLM search"
KEY_ENV = "HERMES_PROVIDER_API_KEY"
# The name the hand-installed copy resolved. Kept as a fallback so a profile that has not been
# rendered with the advertised name yet keeps working; it never outranks the advertised name
# (see _key()).
LEGACY_KEY_ENV = "LITELLM_SEARCH_API_KEY"

# The gateway URL and the LiteLLM *search tool* name (a ``search_tool_name`` from the
# gateway's own config, so it differs per deployment), as the installer rendered them. Neither
# is a secret: the tool name is a gateway route, the key is what authenticates it. A copy that
# was never rendered still holds the placeholders, which count as unset.
CONFIGURED_BASE = "@@LITELLM_SEARCH_BASE@@"
CONFIGURED_TOOL = "@@LITELLM_SEARCH_TOOL@@"
SEARCH_LIMIT_CAP = 20  # every vendor behind the gateway caps max_results at 20
SEARCH_TIMEOUT = 20
FETCH_TIMEOUT = 20
FETCH_MAX_BYTES = 500_000
DETAIL_MAX_CHARS = 200
TITLE_MAX_CHARS = 300

_SKIP_TAGS = frozenset({"script", "style", "noscript", "template", "svg", "iframe"})
_BLOCK_TAGS = frozenset({
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
    "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
    "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
})
_HTML_SHAPE = re.compile(r"^\s*<(!doctype|html|head|body|div|p|span|a|meta|!--)", re.I)
_HTTP_URL = re.compile(r"^https?://", re.I)
_INLINE_SPACE = re.compile(r"[ \t\f\v\u00a0]+")
_BLANK_LINES = re.compile(r"\n[ \t]*\n[ \t]*\n+")


# ── requests: a redirect never carries the key to another host ───────────────
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every 3xx: the search request carries the LiteLLM key.

    ``urlopen`` follows redirects by default, and ``HTTPRedirectHandler`` re-issues the
    request with the same headers (it drops only ``Content-Length``/``Content-Type``) without
    confining the target to the original origin — or even to ``http(s)``. A gateway, or
    anything answering in front of one, could therefore name a third-party host in
    ``Location`` and be handed ``Authorization: Bearer <key>``. Returning ``None`` makes
    urllib raise ``HTTPError`` for the 3xx instead, so the redirect is never followed and the
    caller gets a visible error.

    The page fetch has its own opener (``_FETCH_OPENER``), which carries this handler too, for
    the same kind of reason: its URL is validated as ``http(s)`` once, up front, and a 3xx
    would move the request off the URL that was checked (to another scheme, host or private
    address). The cost is deliberate — a page that redirects is reported rather than silently
    followed.

    This is the same refusal already set for the forgejo token: ``NoRedirect`` built into one
    module-level opener in ``assets/hermes/hermes-git.py``.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# The search request's opener: a 3xx is never followed. The gateway may sit on a private
# address, so this one is not limited to public ones.
_OPENER = urllib.request.build_opener(_NoRedirect)


# ── page fetch: public addresses only, pinned to the address that was checked ──
class _FetchRefused(OSError):
    """Raised from inside the connection when the page's host is not a public address."""


# Refused whatever the interpreter's ``is_global`` says. CPython corrected its
# special-address tables in 3.13, so on an older Python some of these read as global; and
# NAT64, 6to4 and Teredo carry an IPv4 address that a gateway or relay could route to a
# private host. Also the IPv4 special ranges an older table may miss.
_DENIED_NETWORKS = tuple(ipaddress.ip_network(n) for n in (
    "64:ff9b::/96",     # NAT64 well-known prefix (RFC 6052)
    "64:ff9b:1::/48",   # NAT64 local-use prefix (RFC 8215)
    "2002::/16",        # 6to4 (RFC 3056)
    "2001::/32",        # Teredo (RFC 4380)
    "192.0.0.0/24",     # IETF protocol assignments (RFC 6890)
    "198.18.0.0/15",    # benchmarking (RFC 2544)
    "240.0.0.0/4",      # reserved (RFC 1112)
))


def _address_allowed(ip: "ipaddress._BaseAddress") -> bool:
    """True for a globally routable unicast address.

    Refuses loopback, private (RFC 1918, ULA), link-local (cloud metadata at
    169.254.169.254), shared CGNAT, multicast, reserved and unspecified addresses, and the
    ranges in ``_DENIED_NETWORKS`` on every Python version. An IPv4-mapped IPv6 address is
    judged as the IPv4 address it carries.
    """
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if any(ip.version == net.version and ip in net for net in _DENIED_NETWORKS):
        return False
    return ip.is_global and not ip.is_multicast


def _public_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    """``socket.create_connection`` for the page fetch: resolve once, check, connect to that.

    Every address the name resolves to must be public, or the fetch is refused; the socket
    then connects to one of those checked addresses, so a second lookup (DNS rebinding)
    cannot move it. TLS still verifies the certificate against the host name, because the
    connection object keeps the name and only the socket is pinned.
    """
    host, port = address
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise OSError(f"cannot resolve {host}") from exc
    checked = []
    for family, socktype, proto, _canon, sockaddr in infos:
        ip = ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0])
        if not _address_allowed(ip):
            raise _FetchRefused(f"{host} resolves to {ip}, which is not a public address")
        checked.append((family, socktype, proto, sockaddr))
    last = None
    for family, socktype, proto, sockaddr in checked:
        sock = socket.socket(family, socktype, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            last = exc
            sock.close()
    raise last or OSError(f"cannot connect to {host}")


class _PublicHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = _public_connection


class _PublicHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = _public_connection


class _PublicHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_PublicHTTPConnection, req)


class _PublicHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_PublicHTTPSConnection, req, context=self._context)


# The page fetch's opener: no redirects, no proxy from the environment (a proxy would be
# the address checked instead of the page's), and only public destinations.
_FETCH_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _NoRedirect, _PublicHTTPHandler, _PublicHTTPSHandler)


# ── configuration, by name only ──────────────────────────────────────────────
def _key() -> str:
    """The profile's own LiteLLM virtual key. Read by name; the value is never rendered.

    ``HERMES_PROVIDER_API_KEY`` wins, and that is the deliberate decision (review O2): it is
    the name this plugin's manifest advertises and the only name ``get_setup_schema()``
    prompts for, so the key the picker asks the operator for must never be shadowed by a stale
    value under some other name. ``LITELLM_SEARCH_API_KEY`` — what the hand-installed copy
    resolved — stays accepted as a **fallback**, for a profile not yet rendered with the
    advertised name. Both are named in the prompt and in the module docstring, in this order.
    """
    return get_provider_env(KEY_ENV) or get_provider_env(LEGACY_KEY_ENV)


def _rendered(value: str) -> str:
    return "" if value.startswith("@@") else value


def _base() -> str:
    return (get_provider_env("LITELLM_SEARCH_BASE") or _rendered(CONFIGURED_BASE)).rstrip("/")


def _tool() -> str:
    return get_provider_env("LITELLM_SEARCH_TOOL") or _rendered(CONFIGURED_TOOL)


# The installer's own rules for the values it renders (SEARCH_TOOL_RE and validateServiceUrl
# in src/config/config.js). An override in the profile's .env wins over the rendered value,
# so it is held to the same rules: the tool is one path segment, the base is http(s) with
# no credentials in it. Where Python's parsing is looser than JS `new URL()` / a JS regex,
# the gap is closed explicitly: `re.fullmatch` rejects a trailing newline (Python's
# `$` matches before one; JS `$` does not), an embedded space/control character in the
# authority is rejected (JS `new URL()` throws; `urlsplit` tolerates it), and an
# out-of-range port is rejected (JS throws; `urlsplit().port` raises).
_TOOL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_CONTROL_OR_SPACE = re.compile(r"[\x00-\x20\x7f]")


def _config_problem(base: str, tool: str) -> str:
    if not _TOOL_NAME.fullmatch(tool):
        return "LiteLLM search tool name is invalid: it must be one name of letters, digits, '.', '_' or '-'"
    return _base_problem(base)


def _base_problem(base: str) -> str:
    # JS `new URL()` trims surrounding whitespace but rejects it inside: match that
    # (strip the ends, then reject any space/control character that remains).
    stripped = base.strip()
    if _CONTROL_OR_SPACE.search(stripped):
        return "LiteLLM search base is invalid: it must be an absolute http(s) URL with no spaces or control characters"
    try:
        parts = urllib.parse.urlsplit(stripped)
    except ValueError:
        parts = None
    if parts is None or parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return "LiteLLM search base is invalid: it must be an absolute http(s) URL"
    if parts.username is not None or parts.password is not None:
        return "LiteLLM search base is invalid: it must not embed credentials"
    try:
        parts.port  # raises ValueError for a non-numeric or out-of-range port (JS throws too)
    except ValueError:
        return "LiteLLM search base is invalid: its port is not a valid port number"
    return ""


def _redact(text: str) -> str:
    """Flatten gateway-supplied detail so a credential can never ride out inside an error.

    Both key names are scrubbed, not only the one in force: a body echoed back by the gateway
    may quote either.
    """
    for name in (KEY_ENV, LEGACY_KEY_ENV):
        value = get_provider_env(name)
        if value:
            text = text.replace(value, "<redacted>")
    return " ".join(text.split())[:DETAIL_MAX_CHARS]


def _http_detail(exc: urllib.error.HTTPError) -> str:
    """``": <detail>"`` for an HTTP error the gateway explains, or ``""`` when it does not.

    A gateway answering ``500`` with ``{"error": "Unknown search tool: X"}`` must not read as
    a bare status code: the body is where the cause is, and Required 7 wants a failure that
    says what happened rather than only that something did. The read is bounded and every
    byte of it goes through :func:`_redact`, so this cannot become a way for a credential to
    ride out inside an error message.
    """
    try:
        raw = exc.read(DETAIL_MAX_CHARS * 8)
    except Exception:  # noqa: BLE001 — an unreadable error body is simply no detail
        return ""
    body = raw.decode("utf-8", errors="replace").strip()
    if not body:
        return ""
    try:
        data = json.loads(body)
    except ValueError:
        detail = body  # a plain-text error body: the text itself is the explanation
    else:
        detail = ""
        if isinstance(data, dict):
            for field in ("error", "detail", "message"):
                value = data.get(field)
                if isinstance(value, str) and value:
                    detail = value
                    break
    detail = _redact(detail)
    return f": {detail}" if detail else ""


# ── result shapes (the documented contract of agent.web_search_provider) ─────
def _search_ok(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"success": True, "data": {"web": rows}}


def _search_fail(error: str) -> Dict[str, Any]:
    return {"success": False, "error": error}


def _page_ok(url: str, title: str, content: str) -> Dict[str, Any]:
    return {
        "url": url, "title": title, "content": content, "raw_content": content,
        "metadata": {"sourceURL": url, "title": title},
    }


def _page_error(url: str, error: str) -> Dict[str, Any]:
    return {"url": url, "title": "", "content": "", "error": error}


# ── fetch: HTML to readable text ─────────────────────────────────────────────
class _ReadableText(HTMLParser):
    """Readable text from an HTML page: drops script/style/svg, breaks on block tags."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._parts: List[str] = []
        self._skipped = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in _SKIP_TAGS:
            self._skipped += 1
        elif tag == "title":
            self._in_title = True
        elif tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: Any) -> None:
        if tag in _BLOCK_TAGS and not self._skipped:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self._skipped = max(0, self._skipped - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skipped:
            return
        if self._in_title:
            self.title += data
        self._parts.append(data)

    def text(self) -> str:
        spaced = _INLINE_SPACE.sub(" ", "".join(self._parts))
        lines = [line.strip() for line in spaced.split("\n")]
        return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def _readable(body: str, content_type: str) -> Tuple[str, str]:
    """``(title, text)`` for an HTML or plain-text response body."""
    if "html" in content_type or _HTML_SHAPE.match(body):
        parser = _ReadableText()
        parser.feed(body)
        parser.close()
        title = " ".join(parser.title.split())[:TITLE_MAX_CHARS]
        return title, parser.text()
    return "", body.strip()


def _fetch_one(url: str) -> Dict[str, Any]:
    """Read one URL and return its readable text.

    The gateway key is deliberately **not** sent here: it authenticates the
    gateway, not the page, and a fetched host must never see it. The URL is
    validated as ``http(s)`` once, up front, and redirects are refused rather than
    followed, so a 3xx cannot move the request off the URL that was validated (or
    onto another scheme or a private address). The host must resolve to public
    addresses only, and the connection goes to the address that was checked.
    """
    if not _HTTP_URL.match(url):
        return _page_error(url, "fetch refused: only http:// and https:// URLs can be fetched")
    request = urllib.request.Request(url, method="GET", headers={
        "User-Agent": "hermes-litellm-search (Hermes Agent web extract)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    })
    try:
        with _FETCH_OPENER.open(request, timeout=FETCH_TIMEOUT) as response:
            raw = response.read(FETCH_MAX_BYTES + 1)
            charset = response.headers.get_content_charset() or "utf-8"
            content_type = (response.headers.get("Content-Type") or "").lower()
    except urllib.error.HTTPError as exc:
        # A blocked (403) and a missing (404) page must not read alike, and the same
        # refusal the search request uses applies here: a 3xx is reported, never followed.
        if 300 <= exc.code < 400:
            return _page_error(
                url, f"fetch HTTP {exc.code}: a redirect would move the fetch off the URL "
                     f"that was checked, so it is refused"
            )
        return _page_error(url, f"fetch HTTP {exc.code}")
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, _FetchRefused):
            return _page_error(url, f"fetch refused: {exc.reason}")
        return _page_error(url, f"fetch failed: {type(exc).__name__}")
    except _FetchRefused as exc:
        return _page_error(url, f"fetch refused: {exc}")
    except Exception as exc:  # noqa: BLE001 — a per-URL failure is data, never a raise
        return _page_error(url, f"fetch failed: {type(exc).__name__}")
    if not raw.strip():
        return _page_error(url, "fetch returned an empty body")
    truncated = len(raw) > FETCH_MAX_BYTES
    try:
        body = raw[:FETCH_MAX_BYTES].decode(charset, errors="replace")
    except LookupError:  # an advertised charset Python does not know
        body = raw[:FETCH_MAX_BYTES].decode("utf-8", errors="replace")
    title, text = _readable(body, content_type)
    if not text:
        return _page_error(url, "fetch found no readable text in the response")
    content = text + ("\n\n[truncated at %d bytes]" % FETCH_MAX_BYTES if truncated else "")
    return _page_ok(url, title or url, content)


class LiteLLMSearchProvider(WebSearchProvider):
    """Search and page fetch through the gateway's LiteLLM search tools."""

    name = property(lambda self: NAME)
    display_name = property(lambda self: DISPLAY_NAME)

    def is_available(self) -> bool:
        return bool(_key())

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        key = _key()
        if not key:
            return _search_fail(
                "no LiteLLM key (%s / %s)" % (KEY_ENV, LEGACY_KEY_ENV)
            )
        base, tool = _base(), _tool()
        if not base or not tool:
            # Never fall back to a built-in host: there is none, and guessing one would send
            # the key somewhere the operator did not choose.
            return _search_fail(
                "LiteLLM search is not configured: set VBCDX_AGENTS_HERMES_WEB_SEARCH_URL and "
                "VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL in the installer config and re-run it "
                "(or LITELLM_SEARCH_BASE and LITELLM_SEARCH_TOOL in this profile's .env)"
            )
        problem = _config_problem(base, tool)
        if problem:
            return _search_fail(problem)
        try:
            count = max(1, min(int(limit), SEARCH_LIMIT_CAP))
        except (TypeError, ValueError, OverflowError):  # OverflowError: an infinite limit
            count = 5
        body = json.dumps({"query": query, "max_results": count}).encode()
        request = urllib.request.Request(
            f"{base}/v1/search/{tool}", data=body, method="POST",
            headers={
                "Authorization": f"Bearer {key}",  # to the gateway only
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "hermes-litellm-search",
            },
        )
        try:
            with _OPENER.open(request, timeout=SEARCH_TIMEOUT) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            # 401/403 (key refused at the gateway), 429 (rate limit) and 5xx (gateway or
            # provider failure) each keep their own status in the message, and a gateway that
            # explains itself keeps its explanation (redacted): a 500 that says why must not
            # read as a bare status.
            if 300 <= exc.code < 400:
                # Never followed: this request carries the gateway key, and a redirect
                # could point a re-issued request (with its Authorization header) at
                # another host. Any 3xx is refused, named for what it is — including a
                # 3xx with no usable Location, where "to another host" would be inexact.
                return _search_fail(
                    f"LiteLLM search HTTP {exc.code} ({tool}): the request carries the gateway "
                    f"key, so a redirect is refused rather than followed"
                )
            return _search_fail(f"LiteLLM search HTTP {exc.code} ({tool}){_http_detail(exc)}")
        except Exception as exc:  # noqa: BLE001 — report, never raise into the agent
            return _search_fail(f"LiteLLM search failed ({tool}): {type(exc).__name__}")
        try:
            data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        except ValueError:
            return _search_fail(f"LiteLLM search returned a non-JSON body ({tool})")
        if not isinstance(data, dict):
            return _search_fail(f"LiteLLM search returned an unexpected body ({tool})")
        problem = data.get("error") or data.get("detail")
        if problem and "results" not in data:
            # e.g. an unknown or unconfigured search tool, reported inside a 200.
            return _search_fail(f"LiteLLM search error ({tool}): {_redact(str(problem))}")
        results = data.get("results")
        if not isinstance(results, list):
            # A provider layer with no result list must never read as "no results".
            return _search_fail(f"LiteLLM search returned no results field ({tool})")
        rows: List[Dict[str, Any]] = []
        for raw_result in results:
            if not isinstance(raw_result, dict):
                continue
            rows.append({
                "title": str(raw_result.get("title", "")),
                "url": str(raw_result.get("url", "")),
                "description": str(raw_result.get("snippet", "")),
                "position": len(rows) + 1,
            })
            if len(rows) == count:
                break
        logger.info("LiteLLM search %s: %d result(s)", tool, len(rows))
        return _search_ok(rows)

    def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        """Read each URL; per-URL failures are entries with ``error``, never a raise."""
        logger.info("LiteLLM fetch: %d URL(s)", len(urls))
        return [_fetch_one(url) for url in urls]

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": DISPLAY_NAME,
            "badge": "gateway",
            "tag": "Search and page fetch through a LiteLLM gateway's search tools, with the profile's own LiteLLM key.",
            # Both names are given, in precedence order: the picker must ask for the key that
            # actually wins (review O2). Only the advertised name is prompted for — the legacy
            # name is a fallback for a profile that still carries the hand-installed copy's.
            "env_vars": [{
                "key": KEY_ENV,
                "prompt": f"LiteLLM virtual key ({KEY_ENV}; the legacy {LEGACY_KEY_ENV} is only a fallback)",
                # Only a base that passes the installer's rules: never one carrying credentials.
                **({"url": _base()} if _base() and not _base_problem(_base()) else {}),
            }],
        }


def register(ctx: Any) -> None:
    ctx.register_web_search_provider(LiteLLMSearchProvider())
