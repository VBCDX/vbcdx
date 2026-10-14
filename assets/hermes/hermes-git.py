#!/usr/bin/env python3
"""hermes-git: clone org repos and open pull requests through your own fork.

Rendered by the VBCDX installer into Hermes profiles bound to Forgejo, with the role's git mode, the
token env key and the read-scope env key baked in. The token comes from @@TOKEN_ENV@@ in the environment;
the profile's terminal.env_passthrough forwards it into the terminal. A "read" profile names no other
credential: its forgejo MCP binding uses the same key, so nothing in the profile needs a
write-capable token. Read mode additionally requires the profile to DECLARE the token's scope in
@@SCOPE_ENV@@, and asks Forgejo itself whether the token may push to the repository; nothing is
cloned before the declaration and the token have been checked. The token never goes into a URL, argv
or .git/config, and git runs without the tracing environment that would log it.

  hermes-git clone OWNER/REPO [DIR]      fork OWNER/REPO to your account (once) and clone it:
                                         origin = OWNER/REPO (fetch only), fork = your fork.
                                         "fork" roles only.
  hermes-git clone --read-only OWNER/REPO [DIR]
                                         clone without forking; every push is refused.
                                         The only clone a "read" role may make. It refuses to start
                                         unless the profile declares @@SCOPE_ENV@@=read:repository, the
                                         token cannot read the account, and Forgejo refuses the token a
                                         push to the repository.
  hermes-git pr --title T [--body B] [--base BRANCH] [--head BRANCH]
                                         open a PR from YOUR_LOGIN:HEAD into OWNER/REPO.
                                         "fork" roles only.
  hermes-git whoami                      the account your token belongs to.
                                         "fork" roles only: a read token cannot read /user.
  hermes-git credential get              git credential helper (clone configures it)

Org repos take pull requests, not pushes: origin has no push URL, and a pre-push hook accepts
only the fork's push URL as checked at clone time. That hook is a guard rail against ACCIDENTAL
pushes and against URL rewrites in your git config (global, env, or scoped to the clone by
includeIf), not a permission. It does not stop a deliberate same-host rewrite that moves the fork
and every other URL on the host together, `git push --no-verify`, `core.hooksPath`, deleting the
hook, or a plain `git clone`. The real controls are server-side: the token's own scope (a
`read:repository` token, for roles mapped `read`) and branch protection on the org
repositories' default branches.
Work on a branch, `git push fork <branch>`, then `hermes-git pr`.
"""
import base64
import secrets
import http.client
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

FORGEJO_URL = "@@FORGEJO_URL@@".rstrip("/")
# "fork" roles use the role's own token; "read" roles a separate token scoped read:repository
# only, so the server refuses their writes whatever the client does. The key is baked in at render
# time, so a read render never names the role's write-capable token anywhere.
GIT_MODE = "@@GIT_MODE@@"
TOKEN_ENV = "@@TOKEN_ENV@@"
# Read mode's declared scope: the profile's .env must state the token is read:repository, and
# the profile's config.yaml forwards it here. It is the first gate; the push check against the
# repository (assert_cannot_push) is the second. Baked in at render time, like GIT_MODE and TOKEN_ENV,
# so a read render names exactly these keys and no other.
SCOPE_ENV = "@@SCOPE_ENV@@"
# The scope value itself is baked in from the renderer, one source of
# truth with the exported constant, not a second hard-coded literal that can drift.
READ_SCOPE = "@@READ_SCOPE@@"
PUSH_DISABLED = "PUSH-DISABLED--push-to-the-fork-remote-and-open-a-pr"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refused redirects: every request here carries the role's token.

    Following a 3xx would re-send Authorization to whichever host the response names, over whichever
    scheme it names. Returning None makes urllib raise HTTPError for the 3xx instead.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# The one opener used for every request: a redirect can never carry the token to another host.
OPENER = urllib.request.build_opener(NoRedirect)


def die(msg, code=1):
    print(f"hermes-git: {msg}", file=sys.stderr)
    sys.exit(code)


def token():
    t = os.environ.get(TOKEN_ENV, "").strip()
    if not t:
        what = "a Forgejo token scoped read:repository only" if GIT_MODE == "read" else "the role's Forgejo token"
        die(f"{TOKEN_ENV} is not set: the profile's config.yaml must list it under "
            f"terminal.env_passthrough and its .env must hold {what}")
    return t


def declared_read_scope():
    """Read mode's first gate: the profile DECLARES TOKEN_ENV's scope.

    Forgejo answers 403 to /user for a read:repository-only token *and* for a write:repository token
    that carries no user-group scope, so a 403 there never establishes read-only. The read role's
    .env must set SCOPE_ENV to READ_SCOPE; unset, blank or anything else refuses, naming the key and
    the value it wants. assert_cannot_push then checks the token itself against the repository.
    """
    declared = os.environ.get(SCOPE_ENV, "").strip()
    if declared != READ_SCOPE:
        said = repr(declared) if declared else "not set"
        die(f"{SCOPE_ENV} is {said}: a read-only clone proceeds only for a token declared scoped "
            f"{READ_SCOPE} only. Set {SCOPE_ENV}={READ_SCOPE} in the profile's .env (and list it "
            f"under terminal.env_passthrough in config.yaml)")
    return declared


def assert_read_token_scope():
    """Read mode, before the repository is looked up: the declaration and the /user probe.

    * the profile declares the token's scope (declared_read_scope); and
    * the /user probe finds nothing that disproves it. A 200 means the token can read the account -
      the role's own MCP token, or any broad token - so the clone is refused. A 200 that is not this
      API's user object is a proxy or captive portal answering, and is refused for that reason
      instead of being blamed on the token. A 401, a redirect, any other status, a timeout or
      a closed connection all leave the scope unestablished and refuse by name, never as a traceback
     .

    403 is what a read:repository-only token gets - and what a write:repository token without the
    user scope gets too, so it proves nothing here. The clone goes on to assert_cannot_push,
    which asks the repository itself.
    """
    token()
    if GIT_MODE == "read":
        declared_read_scope()
    req = urllib.request.Request(f"{FORGEJO_URL}/api/v1/user",
                                 headers={"Authorization": f"token {token()}", "Accept": "application/json"})
    raw = b""
    try:
        with OPENER.open(req, timeout=60) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 403:
            # Consistent with read:repository only, and equally with a write:repository token that
            # lacks the user scope: NOT evidence of the scope. assert_cannot_push decides.
            return
        if e.code == 401:
            die(f"GET /user: HTTP 401: {FORGEJO_URL} rejected {TOKEN_ENV}, so its scope cannot be "
                f"established. A read-only clone needs a Forgejo token scoped read:repository only")
        if 300 <= e.code < 400:
            die(f"GET /user: HTTP {e.code}: a redirect would send {TOKEN_ENV} to another host, so it "
                f"is refused before git runs")
        die(f"GET /user: HTTP {e.code}: cannot establish that {TOKEN_ENV} is scoped read:repository only")
    except TimeoutError:
        die(f"GET /user: timed out after 60s: cannot establish that {TOKEN_ENV} is scoped "
            f"read:repository only")
    except urllib.error.URLError as e:
        die(f"GET /user: {e.reason}")
    except (OSError, http.client.HTTPException) as e:
        # A closed connection or a malformed response: refuse by name, never a traceback.
        die(f"GET /user: {e.__class__.__name__}: {e}")
    try:
        user = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        user = None
    if isinstance(user, dict) and user.get("login"):
        die(f"{TOKEN_ENV} is not scoped read:repository only: it can read the account. A read-only "
            f"clone needs a separate Forgejo token scoped read:repository only, in the profile's .env")
    die(f"GET /user answered 200 with something that is not this API's user object (a proxy or a "
        f"captive portal in front of {FORGEJO_URL}?): the scope cannot be established, and {TOKEN_ENV} "
        f"is not the cause this time")


def control_status(full):
    """The push discovery answer for a deliberately invalid token: an int status, or why there is none.

    A working Forgejo rejects the credential (401), or hides the repository from it (404). The token
    sent is random and never valid, so this request carries nothing of the role's.
    """
    cred = base64.b64encode(f"hermes-git-read:invalid-{secrets.token_hex(20)}".encode()).decode()
    req = urllib.request.Request(f"{repo_url(full)}/info/refs?service=git-receive-pack",
                                 headers={"Authorization": f"Basic {cred}"})
    try:
        with OPENER.open(req, timeout=60):
            return "HTTP 200"
    except urllib.error.HTTPError as e:
        return e.code if e.code in (401, 404) else f"HTTP {e.code}"
    except TimeoutError:
        return "a timeout"
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        return e.__class__.__name__


def assert_cannot_push(full, upstream):
    """Read mode: ask Forgejo whether TOKEN_ENV may push to `full`, and refuse the clone if it may.

    The request is git's own push discovery, GET <repo>.git/info/refs?service=git-receive-pack,
    authenticated the way git authenticates (Basic, the token as the password). Nothing is written.
    Forgejo checks it against the token's scope at write level before anything else about the push
    (routers/web/repo/githttp.go httpBase -> CheckRepoScopedToken with AccessModeWrite): a token
    without write:repository gets 403, a token with it gets the receive-pack advertisement (200).

    Only that 403 accepts, and only once it is shown to come from the scope check: the same request
    is repeated with a deliberately invalid token, which a working Forgejo answers 401 (or 404). A
    proxy, WAF or gateway that answers 403 to the receive-pack path whatever the credential answers
    the invalid token 403 too, and then the token's 403 proves nothing, so the clone is refused by
    name. An archived repository answers 403 before the token is looked at, and a mirror answers 403
    after the scope check whatever the token, so on those the answer proves nothing and the clone is
    refused by name. A 401, a 404, a redirect, any other status, a 200 that is not a receive-pack
    advertisement, a timeout or a closed connection refuse by name too.
    """
    for flag, what in (("archived", "archived"), ("mirror", "a mirror")):
        if upstream.get(flag):
            die(f"{full} is {what}: Forgejo refuses every push to it whatever the token, so it cannot "
                f"show that {TOKEN_ENV} is unable to push. A read-only clone is refused here")
    cred = base64.b64encode(f"hermes-git-read:{token()}".encode()).decode()
    req = urllib.request.Request(f"{repo_url(full)}/info/refs?service=git-receive-pack",
                                 headers={"Authorization": f"Basic {cred}"})
    what = f"cannot establish that {TOKEN_ENV} is unable to push to {full}"
    try:
        with OPENER.open(req, timeout=60) as r:
            ctype = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        if e.code == 403:
            control = control_status(full)
            if control in (401, 404):
                return  # the 403 is the scope check's: the token's scope does not reach write:repository
            die(f"push check: HTTP 403 for {TOKEN_ENV}, and {control} for a deliberately invalid token: "
                f"something in front of {FORGEJO_URL} answers 403 whatever the credential, so the 403 "
                f"does not come from the token's scope and {what}")
        if e.code == 401:
            die(f"push check: HTTP 401: {FORGEJO_URL} rejected {TOKEN_ENV}, so {what}")
        if 300 <= e.code < 400:
            die(f"push check: HTTP {e.code}: a redirect would send {TOKEN_ENV} to another host, so it "
                f"is refused before git runs")
        die(f"push check: HTTP {e.code}: {what}")
    except TimeoutError:
        die(f"push check: timed out after 60s: {what}")
    except urllib.error.URLError as e:
        die(f"push check: {e.reason}: {what}")
    except (OSError, http.client.HTTPException) as e:
        die(f"push check: {e.__class__.__name__}: {e}: {what}")
    if ctype.split(";")[0].strip() == "application/x-git-receive-pack-advertisement":
        die(f"{TOKEN_ENV} can push to {full}: Forgejo accepted it for git-receive-pack, so it is not "
            f"scoped read:repository only, whatever {SCOPE_ENV} says. A read-only clone needs a "
            f"separate Forgejo token scoped read:repository only, in the profile's .env")
    die(f"push check: {FORGEJO_URL} answered 200 with something that is not a receive-pack "
        f"advertisement (a proxy in front of it?): {what}")


def api(method, path, body=None, ok=(200, 201, 202, 204)):
    """Forgejo API call; returns (status, json). Only statuses in `ok` and 404 return."""
    req = urllib.request.Request(
        f"{FORGEJO_URL}/api/v1{path}", method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"token {token()}", "Accept": "application/json",
                 "Content-Type": "application/json"})
    try:
        with OPENER.open(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        if e.code == 404:
            return 404, {}
        try:
            msg = json.loads(raw).get("message") or raw.decode()[:200]
        except ValueError:
            msg = raw.decode(errors="replace")[:200]
        die(f"{method} {path}: HTTP {e.code}: {msg}")
    except urllib.error.URLError as e:
        die(f"{method} {path}: {e.reason}")
    except (OSError, http.client.HTTPException) as e:
        die(f"{method} {path}: {e.__class__.__name__}: {e}")


def whoami():
    status, user = api("GET", "/user")
    if status != 200 or not user.get("login"):
        die("the token was not accepted by Forgejo")
    return user


# An exported GIT_DIR or GIT_WORK_TREE would point every call below at some other repository instead
# of the scratch repo, the clone or the cwd, so the push guard could check (and configure) the wrong
# repo. hermes-git always names its repository by cwd.
#
# git's tracing environment writes what git does to stderr, including HTTP requests and the
# credential-helper conversation, so it is dropped before git runs: the credential must not reach a
# log.
GIT_ENV = {k: v for k, v in os.environ.items()
           if k not in ("GIT_DIR", "GIT_WORK_TREE") and not k.startswith("GIT_TRACE") and k != "GIT_CURL_VERBOSE"}


def git(*args, cwd=None, check=True):
    r = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, env=GIT_ENV)
    if check and r.returncode != 0:
        die(f"git {' '.join(args)} failed: {(r.stderr or r.stdout).strip()}")
    return r.stdout.strip()


def helper_command():
    """The credential helper line, scoped to the Forgejo origin (never a bare credential.helper)."""
    me = os.path.abspath(sys.argv[0])
    return "!" + " ".join(shlex.quote(x) for x in (sys.executable, me, "credential"))


def repo_url(full_name):
    return f"{FORGEJO_URL}/{full_name}.git"


def split_repo(arg):
    parts = arg.strip("/").split("/")
    if len(parts) != 2 or not all(parts):
        die(f"expected OWNER/REPO, got {arg!r}", 2)
    return parts


def cmd_clone_read_only(args):
    """A clone that cannot push: no fork, origin's push URL disabled, a hook that refuses every push."""
    if not args or len(args) > 2:
        die("usage: hermes-git clone --read-only OWNER/REPO [DIR]", 2)
    owner, name = split_repo(args[0])
    dest = args[1] if len(args) == 2 else name
    # Fail closed before anything is cloned unless the token is the narrow read token: a clone that
    # cannot push is only as good as the token it uses. The credential helper still needs no
    # account lookup (it sends a fixed username); this check is a deliberate /user probe.
    assert_read_token_scope()
    # The repo lookup works with a read:repository token.
    status, upstream = api("GET", f"/repos/{owner}/{name}")
    if status == 404:
        die(f"{owner}/{name} not found, or your account cannot read it")
    full = upstream.get("full_name") or f"{owner}/{name}"
    # The positive check: Forgejo itself must refuse this token a push to this repository.
    assert_cannot_push(full, upstream)
    helper = helper_command()
    key = f"credential.{FORGEJO_URL}.helper"
    git("-c", f"{key}={helper}", "clone", "--", repo_url(full), dest)
    git("config", key, helper, cwd=dest)
    git("remote", "set-url", "--push", "origin", PUSH_DISABLED, cwd=dest)
    git("config", "hermes.origin", full, cwd=dest)
    git("config", "hermes.readonly", "true", cwd=dest)
    hooks = git("rev-parse", "--git-path", "hooks", cwd=dest)
    hook = os.path.join(dest, hooks) if not os.path.isabs(hooks) else hooks
    try:
        os.makedirs(hook, exist_ok=True)
        with open(os.path.join(hook, "pre-push"), "w") as f:
            f.write("#!/bin/sh\n"
                    "# hermes-git: a read-only clone. Nothing is pushed from here.\n"
                    "echo \"hermes-git: refused push: this is a read-only clone\" >&2\n"
                    "exit 1\n")
        os.chmod(os.path.join(hook, "pre-push"), 0o755)
    except OSError as e:
        die(f"could not install the pre-push hook in {hook}: {e}")
    print(f"cloned {full} into {dest} (read-only: no fork, pushes refused)")


def cmd_clone(args):
    if args[:1] == ["--read-only"]:
        return cmd_clone_read_only(args[1:])
    if GIT_MODE == "read":
        die("your role clones read-only: hermes-git clone --read-only OWNER/REPO [DIR]", 2)
    if not args or len(args) > 2:
        die("usage: hermes-git clone OWNER/REPO [DIR]", 2)
    owner, name = split_repo(args[0])
    dest = args[1] if len(args) == 2 else name
    login = whoami()["login"]
    status, upstream = api("GET", f"/repos/{owner}/{name}")
    if status == 404:
        die(f"{owner}/{name} not found, or your account cannot read it")
    full = upstream.get("full_name") or f"{owner}/{name}"
    if login.lower() == owner.lower():
        die(f"{full} belongs to your own account: clone it with plain git")
    status, fork = api("GET", f"/repos/{login}/{name}")
    if status == 404:
        api("POST", f"/repos/{owner}/{name}/forks", {})
        for _ in range(30):  # a fork may take a moment to appear
            status, fork = api("GET", f"/repos/{login}/{name}")
            if status == 200:
                break
            time.sleep(1)
        else:
            die(f"forked {full}, but {login}/{name} did not appear")
        print(f"forked {full} -> {login}/{name}")
    parent = (fork.get("parent") or {}).get("full_name", "")
    if not fork.get("fork") or parent.lower() != full.lower():
        die(f"{login}/{name} exists but is not a fork of {full}; rename or remove it first")
    helper = helper_command()
    key = f"credential.{FORGEJO_URL}.helper"
    fork_url = repo_url(f"{login}/{name}")
    # What the fork's push URL must resolve to. A whole-host rewrite (a mirror, a test harness) moves
    # every URL on the host the same way, so resolve a canary URL on the same host and swap the
    # fork's owner/repo into its result. `remote get-url --push` applies insteadOf AND pushInsteadOf
    #. This first pass runs in a throwaway repo, so a rewrite
    # already in effect (global or env config) is refused before anything is created.
    canary = "hermes-git-canary/canary.git"

    def push_urls(repo):
        """{"fork": ..., "canary": ...}: both push URLs as git resolves them in `repo`."""
        try:  # the add is inside the try, so the canary remote never outlives this call
            git("remote", "add", "hermes-git-canary", f"{FORGEJO_URL}/{canary}", cwd=repo)
            return {"fork": git("remote", "get-url", "--push", "fork", cwd=repo),
                    "canary": git("remote", "get-url", "--push", "hermes-git-canary", cwd=repo)}
        finally:
            git("remote", "remove", "hermes-git-canary", cwd=repo, check=False)

    def rewritten(pre):
        return (f"your git config rewrites the push URL of {fork_url} to {pre}; the push guard could not "
                "tell your fork from another repository. Remove that url.*.insteadOf / url.*.pushInsteadOf "
                "rule (or the includeIf that brings it in) and clone again")

    with tempfile.TemporaryDirectory(prefix="hermes-git-check-") as probe:
        git("init", "-q", probe)
        git("remote", "add", "fork", fork_url, cwd=probe)
        urls = push_urls(probe)
    pre, host = urls["fork"], urls["canary"]
    expected = host[: -len(canary)] + f"{login}/{name}.git" if host.endswith(canary) else None
    if pre != expected:
        die(rewritten(pre))
    # "--": a DIR starting with "-" is a directory name, never a git option such as --upload-pack
    #.
    git("-c", f"{key}={helper}", "clone", "--", repo_url(full), dest)
    git("config", key, helper, cwd=dest)
    git("remote", "set-url", "--push", "origin", PUSH_DISABLED, cwd=dest)
    git("config", "hermes.origin", full, cwd=dest)
    git("config", "hermes.fork", f"{login}/{name}", cwd=dest)
    git("config", "user.name", login, cwd=dest)
    git("config", "user.email", f"{login}@users.noreply.{urllib.parse.urlsplit(FORGEJO_URL).hostname}", cwd=dest)
    # The hook goes in BEFORE the fork remote exists, so a failed install never leaves a clone with a
    # usable, unguarded fork remote.
    hooks = git("rev-parse", "--git-path", "hooks", cwd=dest)
    hook = os.path.join(dest, hooks) if not os.path.isabs(hooks) else hooks
    try:
        os.makedirs(hook, exist_ok=True)
        with open(os.path.join(hook, "pre-push"), "w") as f:
            # $2 is the URL git is about to push to, after insteadOf/pushInsteadOf expansion. It must
            # equal `expected`, baked in here, never a value re-read from config the pusher can change
            #.
            f.write("#!/bin/sh\n"
                    "# hermes-git: org repos take pull requests, not pushes. Push to the fork remote.\n"
                    "# A guard against accidental pushes; --no-verify or core.hooksPath bypass it.\n"
                    f"want={shlex.quote(fork_url)}\n"
                    f"expected={shlex.quote(expected)}\n"
                    "refuse() { echo \"hermes-git: refused push: $1\" >&2; exit 1; }\n"
                    "[ \"$(git config --get remote.fork.url)\" = \"$want\" ] || refuse \"the fork remote no longer points at $want\"\n"
                    "[ -z \"$(git config --get-all remote.fork.pushurl)\" ] || refuse \"the fork remote has a separate push URL; remove it with: git config --unset-all remote.fork.pushurl\"\n"
                    "now=\"$(git remote get-url --push fork)\"\n"
                    "[ \"$now\" = \"$expected\" ] || refuse \"the fork remote now resolves to $now, not $expected (a url.insteadOf rule?)\"\n"
                    "[ \"$2\" = \"$expected\" ] && exit 0\n"
                    "refuse \"to $2: push to the fork remote ($want), then run hermes-git pr\"\n")
        os.chmod(os.path.join(hook, "pre-push"), 0o755)
    except OSError as e:  # a clean error, not a traceback
        die(f"could not install the pre-push hook in {hook}: {e}")
    git("remote", "add", "fork", fork_url, cwd=dest)
    # Second pass, IN the clone: config scoped to the clone's location or remotes (includeIf "gitdir:…",
    # "hasconfig:remote.*.url:…") is invisible to the throwaway repo above.
    # The fork must resolve to the same `expected` here too; otherwise the fork remote is removed
    # again, so the refused clone has no remote to push to. Config scoped to a branch
    # (includeIf "onbranch:…") is invisible to both passes, since the clone sits on the default
    # branch; the hook catches it at push time, when the fork no longer resolves to `expected`.
    now = push_urls(dest)["fork"]
    if now != expected:
        git("remote", "remove", "fork", cwd=dest, check=False)
        die(rewritten(now) + f". {dest} was cloned but has no fork remote")
    print(f"cloned {full} into {dest}\n"
          f"  origin = {full} (fetch only)\n  fork   = {login}/{name} (push here)\n"
          f"next: git switch -c <branch>; commit; git push fork <branch>; hermes-git pr --title ...")


def cmd_pr(args):
    opts = {"--title": None, "--body": "", "--base": None, "--head": None}
    it = iter(args)
    for a in it:
        if a not in opts:
            die(f"unknown option {a!r}; usage: hermes-git pr --title T [--body B] [--base BRANCH] [--head BRANCH]", 2)
        opts[a] = next(it, None)
        if opts[a] is None:
            die(f"{a} needs a value", 2)
    if not opts["--title"]:
        die("--title is required", 2)
    if git("config", "--get", "hermes.readonly", check=False) == "true":
        die("this is a read-only clone: pull requests come from a role that clones through its fork")
    origin = git("config", "--get", "hermes.origin", check=False)
    fork = git("config", "--get", "hermes.fork", check=False)
    if not origin or not fork:
        die("run this inside a repository cloned with hermes-git clone")
    head = opts["--head"] or git("rev-parse", "--abbrev-ref", "HEAD")
    if head == "HEAD":
        die("detached HEAD: pass --head BRANCH")
    login = fork.split("/")[0]
    status, _ = api("GET", f"/repos/{fork}/branches/{urllib.parse.quote(head, safe='')}")
    if status == 404:
        die(f"branch {head} is not on your fork yet: git push fork {head}")
    base = opts["--base"]
    if not base:
        _, repo = api("GET", f"/repos/{origin}")
        base = repo.get("default_branch") or "main"
    _, pr = api("POST", f"/repos/{origin}/pulls",
                {"head": f"{login}:{head}", "base": base, "title": opts["--title"], "body": opts["--body"]})
    print(pr.get("html_url") or f"opened PR #{pr.get('number')} on {origin}")


def cmd_credential(args):
    if args[:1] != ["get"]:
        return  # store/erase: nothing is stored
    attrs = {}
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            break
        k, _, v = line.partition("=")
        attrs[k] = v
    want = urllib.parse.urlsplit(FORGEJO_URL)
    if attrs.get("protocol") != want.scheme or attrs.get("host") != want.netloc:
        return  # not the Forgejo origin: answer nothing
    t = token()
    # A read token cannot look up its account; Forgejo takes an access token as the password with
    # any username, so the read mode sends a fixed one.
    user = attrs.get("username") or ("hermes-git-read" if GIT_MODE == "read" else whoami()["login"])
    sys.stdout.write(f"username={user}\npassword={t}\n")


def main():
    cmd, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if cmd == "clone":
        cmd_clone(args)
    elif cmd == "pr":
        cmd_pr(args)
    elif cmd == "whoami":
        if GIT_MODE == "read":
            die('whoami is for "fork" roles: a read:repository token cannot read the account', 2)
        print(whoami()["login"])
    elif cmd == "credential":
        cmd_credential(args)
    else:
        print(__doc__.strip())
        sys.exit(0 if cmd in ("-h", "--help", "help") else 2)


if __name__ == "__main__":
    main()
