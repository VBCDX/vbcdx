# The general-use gate

Nothing in this repository names one deployment, and no first-party name is special-cased
outside the files that declare it. `scan.mjs` checks that on every pull request and every
push; a hit fails the job.

## What is scanned

- every tracked file (`git ls-files`): code, comments, tests, fixtures, CI and docs;
- every tracked path;
- a file that holds a NUL byte is not skipped: it is read byte for byte and checked against
  every pattern except the few short ones that only mean something in prose (a note names
  the file);
- a file that starts with a UTF-16 byte-order mark is read as that text, with every pattern,
  and as bytes as well, so the mark cannot hide plain text (a note names the file);
- for a pull request, the commit messages from the merge base with the base branch to the
  head (`--base`);
- for a push, the commit messages the head adds to its first parent (`--head-commit`): the
  one message of a squash, every merged commit of a merge, and the head's own message when
  it is a root commit. `--tree-only` scans no message.

A hit is printed as `path:line [class]` (line 0 is the path itself) or
`commit <id>:line [class]`. The matched text and the line are never printed.

Exit status: 0 clean, 1 hits or a refused list entry, 2 the scan could not be completed.
A scan that could not look (git failed, a file could not be read) is never a clean result.

## The classes

`person`, `internal-host`, `lane`, `vocabulary`, `tracker`, `lan-ip`, `ct-id`, `forge`,
`review-process` and `deploy-id`: the people, hosts, addresses, guest ids, team and account
names, working vocabulary, tracker and review references and private service addresses of
the deployment the code was first written in. The patterns are in `scan.mjs`, assembled
from fragments so the scanner matches none of them itself. `--self-test` checks every class
against its samples, a list of required names (deleting a class leaves one uncaught) and a
list of generic text that must stay clean.

A few rules read a line by the kind of file it is in. A code file is one whose name ends in
`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.rs`, `.go`, `.py`, `.java`, `.kt`, `.rb`,
`.php`, `.cs`, `.swift`, `.c`, `.h`, `.cc` or `.cpp`: that is the one list, and code under
another name (a `.txt`) is not on it. A commit message, a path, and a line of a file of any
other kind get every rule at its strictest. Each rule below that says "in a code file" or
"in a `.md` file" applies there and nowhere else.

These rules of the `tracker` class tell code and markup from prose:

- A short work-item id is a capital letter, a digit and an optional lower-case letter, as a
  whole word. The same shape is not an id when an opening parenthesis follows it (a call, an
  enum variant that carries a value), when `::` or `.` stands before it (a qualified name),
  or when it is an element inside a list of such tokens: an opening bracket or a comma
  before it, and after its own comma another such token. Both sides of the list rule are
  needed. A token that starts a sentence and is followed by a comma is an id, and so is one
  followed by a closing parenthesis.
- A `#` and a number is a reference unless it is a colour literal: three or four digits, as
  the last value of a CSS declaration (a lower-case property name, a colon, the value, a
  semicolon) or as the whole of a quoted string.
- In a code file, the shape of a short id is an identifier, not an id, where it stands as a
  value in a line of code. All three must hold. It is outside every comment and string
  literal the line shows (`//`, a block comment opened on the line, a line that starts with
  `*`, `#` in Python, Ruby and PHP, a literal between quotes; a double quote or a backquote
  left open runs to the end of the line). The code of the line shows a call (`name(`,
  `name!(`, `![`) or one of `==`, `!=`, `=>`, `->`, `::`, `&&`, `||`. And the token stands
  after `(`, `[`, `,`, `=`, `&` or `|` and before `)`, `]`, `,`, `;`, `{`, `}`, `=`, `&`,
  `|` or the end of the line. In a comment and in a string literal it is an id as anywhere
  else: the text of an error a user reads is checked.
- The path data of a drawing is not prose: inside the value of a `d="..."` attribute that
  holds nothing but path commands and numbers, the commands are no ids. That is so in any
  file. An `.svg` file is not exempt as a whole: its text, titles and comments are checked.
- Unicode names its two sets of control characters with a capital C and the digit 0 or 1.
  Those two names are no ids on a line that also writes a code point (`U+` and four to six
  hex digits). Alone, or next to the words that describe them only, they are ids.

The long forms of a reference (a repository's name and a number, a comment's id, a row of a
plan, a section mark) are checked in every file and in every place of a line.

`lan-ip` is an address of the deployment's networks. One of those networks lies inside a
private block of the standard (RFC 1918, the block with the `/16` prefix). In a `.md` file
that block, written as the whole block with its prefix length, is the standard's and not a
hit. The standard's other two private blocks are never one. An address inside the block,
the block with another prefix length, and the block in a file of any other kind are hits.

`secret-flag` is a command-line option that takes a secret as its value (its name ends in
`token`, `password`, `secret` or `key`, with no `-file` or `-stdin` after it): the value would
sit in the process list. It is checked in non-test files only. An option with `public` as
one of the words of its name (`--public-key`) takes a public key and is not one; `public`
inside a longer word does not count.

A test file is one in a test directory (`test/`, `tests/`, `testdata/`, `fixture/`,
`fixtures/`, `__tests__/`) that has no `src` directory above it, or one named as a test
anywhere (`*.test.js` and its `.mjs`, `.cjs` and `.ts` forms, `*_test.go`, `tests.rs`). So
`tests/x`, `crates/a/tests/x.rs` and `packages/p/test/x.js` are test files, and `src/test/x.js`
and `crates/a/src/tests/x.rs` are not: a directory of one of those names inside a source
tree is not exempt.

`first-party` is a second check. `first-party.txt` lists first-party names (a service, a
contract, a store) and the files that declare them. A name in any other non-test file is a
hit: a first-party entry reaches the code the way a third party's does.

```
name<TAB>text that names the entry
file<TAB>path of a declaring file, or a directory ending in /
```

An entry that no longer matches anything fails the gate.

`secret-shape` is a secret, by its shape: the first line of a key block, a token that begins
with a vendor's prefix, a header or a `name = value` pair that carries a credential, a URL
with a pass phrase in it. There are twenty-one shapes, each with a name, in `scan.mjs`
(`SECRET_SHAPES`), assembled from fragments like every other pattern. In a `name = value`
pair the key word (a pass word, a secret, a token, an API key and their kin) counts where it
starts the name or follows `_`, `-` or `.` in it, as in `DB_…`, `GITHUB_…` or `STRIPE_API_…`,
and a cloud vendor's `…_SECRET_ACCESS_KEY` counts whole; inside a longer word, or with more
of the name after it, it does not. A value that is a
placeholder (`<...>`, `[...]`, `***`, `REDACTED`, `${VAR}`, `$VAR`) is not a hit.

Five shapes say what they are not. Each exception is asked of one match, so a line with an
excepted match and another one is still a hit:

- **A `name = value` pair, in a code file:** an unquoted value that is an expression is no
  credential. It is names joined by dots that end in a call's `(` or in `::`, or two or more
  names joined by dots with nothing more of a value after them. A value is never read as
  code when a run of 20 or more base64 characters stands anywhere from its start to the end
  of the line. A quoted value is always a literal. In a settings file, a script, YAML, JSON
  and every other file the pair is read as before: there a value is unquoted by habit.
- **A `name = value` pair, in a `.json` file directly inside a directory named `seed`:** the
  value `demo-placeholder:` and one lower-case word of at most 24 letters, as the whole of a
  double-quoted value, is the placeholder of a demonstration's seed data. Any other value
  there, and that value in any other file, is a hit.
- **The key word of a credentials file, in a code file:** a line that is that word with a
  capital first letter, a type and at most a tag in backquotes is a field of a structure.
  The type is a slice of bytes, a pointer to a string, or one name with or without a
  package's name before it, and holds no run of 20 or more base64 characters. The word in
  lower case, as a credentials file writes it, is never a field, and neither is the line
  behind a machine or a login.
- **A signing tool's secret key** is found as a key, not by the name of its format. Three
  things are one: the comment line that starts a key file, where the line starts with it;
  that comment line inside a literal that goes on with base64 after its escaped line break
  (a key file written on one line); and the base64 of a secret key at its length of 212 characters,
  encrypted or not, alone or inside a literal. Prose, a comment, an error text or a format
  string that names the format is none, and neither is a public key or a signature.
- **A URL with a pass phrase:** the words `pass` and `password`, in any mix of capitals, as
  the whole pass phrase are the placeholder of an example. Any other phrase is a hit, the
  user's own name repeated as the phrase included.

The class is checked everywhere: source, tests, fixtures, paths and commit messages. A test file is
not exempt, unlike for `secret-flag`: a credential in a test is as much in the tree as one
in the source. A test that needs a value of such a shape assembles it at run time, or its
line is in `allow.txt` with the reason it is no credential. Only the place and the class are
printed, never the value and never which shape matched. For a commit message the place is
the commit's short id and the line's number. A path whose own name has such a shape is never
printed either, anywhere in the output: not for that hit, not as the place of another
class's hit in the file, not in a note, an error or the `--hashes` columns. What stands for
it is fixed text and the file's number in `git ls-files`, which someone who has the tree
can look up (`git ls-files | sed -n <number>p`) and nobody else can turn back into the name.
`--hashes` prints `-` where the hash would be, for every hit on such a file: the hash of a
path's own hit is the hash of the path. So a path with a secret's shape cannot be put in
`allow.txt`: it is renamed.

```
(a path whose name has a secret's shape: number 12 in git ls-files):0 [secret-shape]
```

`assembled` is a denied name put together from pieces on one line, so that the file holds no
literal for the classes above to find. Two things are read as joining: two string literals
with a `+` between them, and the string literals of a list that the line joins with nothing
between its items (`[...].join("")`, `[...].concat()`, `"".join([...])`, `concat!(...)`,
`Join([]string{...}, "")`). Those seams are closed up and the line is read again; a name
that is there only then is a hit. Strings that only stand next to each other (the items of
a list, the arguments of a call, a list joined with a separator) are not joined and are not
closed up. Only names are looked for, not options and not secrets, and only with the
patterns that mean something outside prose. The gate's five shared files (`README.md`,
`gate.mjs`, `scan.mjs`, `scan.test.mjs`, `verify-dir.mjs`) are not checked: their patterns
and samples are written that way on purpose. Every other file under `ci/general-use/`, the
repository's own lists included, is. A test that asserts the product
refuses a denied word, and builds the word so, is allowed by its line in `allow.txt`.

## Exceptions

`allow.txt`, one line per exception:

```
path<TAB>class<TAB>sha256 of the stripped line<TAB>reason
```

- One entry allows one line of one file for one class. A wildcard or a directory is refused.
- The reason says why the line is general, in words that stand on their own. It may start
  with `expires YYYY-MM-DD: `; after that day the entry is refused.
- An entry that matches no line any more fails the gate, so the list cannot rot.
- `node ci/general-use/scan.mjs --tree-only --hashes` prints the first three columns of
  every hit. It is a local aid: where a CI variable is set (`CI`, `GITHUB_ACTIONS`,
  `FORGEJO_ACTIONS`, `GITEA_ACTIONS`) it is refused with status 2, because a line's hash in a
  job log lets a reader test guesses of the line against it.

Generic data is a fair exception: private address ranges in a test of an address filter,
documentation addresses, licence text. A name of the deployment is not: reword the line.

A change to `allow.txt` or `first-party.txt` is reviewed as a major change, and the pull
request says why each added line is there.

## Running it

```
node ci/general-use/verify-dir.mjs                 # the directory is the pinned copy
node ci/general-use/scan.mjs --self-test           # the rule set checks itself
node --test ci/general-use/scan.test.mjs           # the gate's own tests (needs git)
node ci/general-use/scan.mjs --base origin/main    # tree + commit messages of the branch
node ci/general-use/scan.mjs --head-commit         # tree + the messages the head commit adds
node ci/general-use/scan.mjs --tree-only           # tree only
node ci/general-use/gate.mjs --base origin/main    # what a pull request's job runs (below)
```

## On a pull request, the base branch decides

A pull request can edit every file of its own tree: the scanner, the lists of exceptions and
the workflow that starts them. So its job does not start the scanner from its tree. The CI
step takes `gate.mjs` from the base branch (`git show`) into a temporary directory and
starts it there. `gate.mjs` then

1. copies `ci/general-use/` as the base branch has it into a temporary directory, and has
   that copy's `verify-dir.mjs` confirm the copy is its own pinned set. A copy that is not
   is not run: status 2;
2. has the copy's `verify-dir.mjs` check the tree's own `ci/general-use/` as well: a copy
   that changes its own check, or what its `SOURCE` says, is still read by the check the
   base branch has. A refusal fails: status 1;
3. compares the workflow directories at the head with the base branch's (below): an
   entry added, removed or changed in mode or type, or an edit to what the base's bytes
   protect, fails: status 1. Any other edit to a workflow is printed as a notice;
4. runs the copy's `scan.mjs` against the pull request's tree and commit messages, with the
   copy's `allow.txt` and `first-party.txt` (`--lists`);
5. runs the tree's own `scan.mjs` the same way, with the tree's lists.

Both scans are given the base as the commit it resolved to in step 1, not as the text the
step was started with.

All of it must pass. A pull request that weakens a rule in its own scanner, allows its own
hit in its own `allow.txt`, or drops a name from its own `first-party.txt` is still judged
by the base branch's rules and lists; one that adds a rule must itself satisfy it. Status:
0 when everything is clean, 1 when a run found hits or a comparison failed, 2 when a run
could not complete. The log names every file of `ci/general-use/` the branch changes.

```
set -euo pipefail
GATE="ci/general-use/gate.mjs"
LISTED="$(git ls-tree --name-only "origin/$BASE_REF" -- "$GATE")"
if [ -n "$LISTED" ]; then
  BASE_COPY="$(mktemp -d)"
  trap 'rm -rf -- "$BASE_COPY"' EXIT
  git show "origin/$BASE_REF:$GATE" > "$BASE_COPY/gate.mjs"
  node "$BASE_COPY/gate.mjs" --base "origin/$BASE_REF"
else
  echo "general-use: origin/$BASE_REF has no $GATE yet: this tree's copy runs the gate"
  node "$GATE" --base "origin/$BASE_REF"
fi
```

What follows from that:

- A pull request cannot pass by its own exception. A new entry in `allow.txt`, or a new
  name or file in `first-party.txt`, does not count in the base branch's run, so the line it
  is for fails there. An exception is merged by the forge's administrative path, by
  someone who may merge with this check failing, after review. The
  list alone cannot go first either: an entry that matches nothing fails the tree's own run.
- Removing is free: an entry of the base branch's lists that matches nothing in the pull
  request's tree is not reported as stale in the base branch's run. The tree's own run still
  holds the tree's own lists to that rule.
- A rule cannot be loosened and relied on in one pull request: text that only the loosened
  rule passes fails the base branch's run. Loosen the rule first, then add the text.
- The self-test, the tests and `verify-dir.mjs` run from the pull request's tree: they test
  the change, they do not gate the tree. In the job they come after the two scans, so that
  no code of the pull request has run when the base branch's gate starts.

### The workflows are the pull request's own

The forge reads its workflows from the first of three directories that exists:
`.forgejo/workflows`, `.gitea/workflows`, `.github/workflows`. For a pull request from a
trusted author it runs the workflows of the pull request's head, its changes included
([Forgejo: which workflow files are used](https://forgejo.org/docs/latest/user/actions/security-pull-request/#which-workflow-files-are-used)).
So a check that such a workflow starts cannot be the control over a change to that same
workflow: a pull request that edits the gate's job, or adds a step ahead of it, also decides
what the gate is. A change to a workflow is reviewed through the forge's protection of the
workflow path (the next section). What `gate.mjs` checks here is a tripwire for an honest
edit, not a control.

It lists all three directories with `git ls-tree -r`, at the base branch's commit and at
the head: for every path its mode, its type and its object id. Then, for every path:

- an entry only one side has, or whose mode or type differs (a file added, removed,
  renamed or moved, a mode changed, a directory turned into a link or a file), is named
  and the status is 1;
- a file whose bytes differ is cut, from the **base's** bytes only, into what it keeps: the
  text up to its one `jobs:` line (the name and the triggers), and, in the file that names
  `ci/general-use/gate.mjs`, the whole job that names it, from its key line to the next
  job. The head must start with that text, have `jobs:` once and no other key at the start
  of a line after it, and hold the gate's job once, whole, with nothing added to its end.
  The head's text is only searched for those bytes, never parsed. If it does not hold
  them, the file is named and the status is 1. A base file that cannot be cut that way (no
  single `jobs:` line, jobs indented by anything but spaces, the gate named outside a job)
  passes only unchanged;
- across all three directories, the number of times the workflows name
  `ci/general-use/gate.mjs`, and the gate's job by its id and by its own `name:` (both as
  the base has them), must be the base's. A line whose first mark is `#` is not counted:
  it is a comment, or text in a block scalar, and neither is a job's key or name. A `#`
  later on a line is not cut at. A job added, renamed or removed around the gate, or a
  second job that reports under the gate's name, changes one of the counts. A difference
  sets the status 1. If a base file that names `gate.mjs` cannot be cut, the gate's job is
  not known, and no edit to a workflow passes;
- any other edit is printed as a notice, and passes.

No object id and no text of a file is printed. The comparison is with the base branch as it
is now, not with the commit the branch was cut from: after the gate's job changes on the
base branch, an open pull request fails until it is rebased on, or merged with, the new
base.

What it cannot see is a pull request whose workflow does not start the base branch's
`gate.mjs` at all: one that removes, disables or reorders the step, removes or disables the
job, or stops the workflow from running. Then no gate runs and nothing compares anything.
A base with no workflow in any of the three directories has nothing to cut: the first
workflow a pull request adds is a difference.

Two bases cannot give all of that, and the log says which applies:

- The base has no checker at all (the pull request that first adds the directory): there is
  nothing to compare with, and the tree's own copy decides.
- The base's checker predates this step (it has `scan.mjs` and no `gate.mjs`): the CI step
  starts the tree's `gate.mjs`, which verifies and runs the base's scanner first, with the
  tree's lists, since that scanner cannot be told to read others, and makes neither of the
  comparisons of steps 2 and 3.
  This is the case once per repository, in the pull request that brings `gate.mjs`.

## What the code stops, and what only the forge's protection stops

The code stops, whenever the base branch's `gate.mjs` runs on a pull request:

- a name of one deployment in a tracked file, in a path or in a commit message of the
  branch, by the base branch's rules and by the tree's own;
- a scanner weakened in the pull request: the base branch's copy still scans;
- an exception the pull request gives itself: a line added to `allow.txt`, a name dropped
  from `first-party.txt` or a declaring file added to it. The base branch's lists decide;
- a base branch whose copy of this directory is not its own pinned set, or, where the CI
  names the repository, says `canonical` in a repository that is not the owning one: it is
  not run, and the job fails;
- as a tripwire for an honest edit, not as a control: a workflow entry added, removed,
  renamed or changed in mode or type, and an edit to the gate's own job, the triggers or
  the number of times the workflows name the gate (above);
- a pull request whose own `ci/general-use/` the base branch's `verify-dir.mjs` refuses: a
  pinned file that does not match the list, a `SOURCE` that names another source than the
  owning repository, or one that says `canonical` where the CI names another
  repository or none;
- a file name, a ref or an argument made to look like a line of the log or a command to the
  CI runner: it is printed with its control characters escaped, and a path at the start of
  a line never starts with a runner command.

Only the forge's protection stops the following; this directory cannot, since in each case
its code does not run, or the code that runs is the one under change:

- A pull request that removes, disables or reorders the step that starts `gate.mjs`, or
  whose job or workflow does not run. The workflow file is read from the pull request. The
  forge must protect the workflow path: a change to it is merged only by those who may, and
  the job is a required check.
- Any change under the directories the forge reads workflows from. The workflow that runs
  is the pull request's own, so what it checks is what the pull request says it checks: a
  job that reports under the gate's name, written in a way the counts above do not see, or
  any other job's edit. The forge's protection of the workflow path reviews every such
  change, and the gate's notice names each edited file.
- A push to the default branch. There is no base to take a checker from: the tree's own
  copy decides (`--head-commit`). The branch must take changes only by a merged pull
  request or by an administrator.
- A base that has no gate yet, or one that predates this step (the two cases above). The
  pull request that brings the gate is reviewed as what it is.
- A pull request to a branch other than the default one. The base branch's copy decides,
  and such a branch may carry any copy: it needs the default branch's protection to be
  trusted the same way.
- A `SOURCE` whose tag and commit are not the owning repository's: a tag that does not
  exist there, a tag that was moved, or a commit of a fork, together with sums that match
  the files. `verify-dir.mjs` checks, offline, that the first line names the owning
  repository, the tag is a release tag in form, the commit is a commit id in form, and the record is the
  local list. That the tag resolves to that commit in that repository needs the network:
  until a check does that, the reviewer of a copy does.
- A pull request that changes this directory's own files and keeps them consistent: the
  scanner, the lists' form, `verify-dir.mjs`, `gate.mjs`, with `SHA256SUMS` regenerated (and,
  in a copy, the record in `SOURCE`). The base branch's copy is what runs, and it checks the
  tree's directory, so an inconsistent change is refused; a consistent one is not, while it
  is a pull request. The log names each changed file, and once merged that copy is the base
  that the next run verifies and runs.

## On a push

A push has no base branch. `--head-commit` scans the tree and the messages the head adds to
its first parent. A forge that squashes a pull request appends the pull request's number to
the subject, in parentheses, after a space. Exactly that is not scanned: one such number at
the very end of the head commit's first line. A second number before it is not the forge's
and is scanned, and so is a number anywhere else in the subject, one with no space before
it, one in the body, or one in another commit of the range. `--base` (a pull request's
range) takes nothing off.

## One copy in every repository

The scanner is the same bytes wherever it runs. `SHA256SUMS` pins the five shared files:
`README.md`, `gate.mjs`, `scan.mjs`, `scan.test.mjs` and `verify-dir.mjs`. Three files belong
to each repository and are not pinned: `allow.txt`, `first-party.txt` and `SOURCE`.

`SOURCE` names where the shared files came from. In the repository that owns them it is the
one word `canonical`, and only there. Where the CI variable `GITHUB_REPOSITORY` is set,
`verify-dir.mjs` refuses `canonical` unless the variable names the owning repository
(`CANONICAL_REPOSITORY` in `verify-dir.mjs`, compared without regard to case), and prints
the repository it checked. Where the variable is empty or not set, a CI job (`CI`,
`GITHUB_ACTIONS`, `FORGEJO_ACTIONS` or `GITEA_ACTIONS` is set) is refused too: a job that
cannot say which repository it runs in cannot make the claim. Only a local run, with none
of those set, is accepted, and a note says the repository was not checked. On the owning
repository's forge the runner sets `GITHUB_REPOSITORY` to `VBCDX/vbcdx`: each job's log
has the line `SOURCE is canonical, checked against GITHUB_REPOSITORY VBCDX/vbcdx`.

In every other repository `SOURCE` is exactly this, line by line:

```
VBCDX/vbcdx
<the release tag the files were copied at: vX.Y.Z, or vX.Y.Z-suffix>
<the 40-hex commit id of that tag>

<the lines of that commit's SHA256SUMS>
```

The first line is the owning repository as owner/name (`CANONICAL_REPOSITORY` in
`verify-dir.mjs`), byte for byte, with no host: another owner or name, another case, a
slash, a `.git`, a space or a host in front is another source, and is refused (status 1).
The earlier first line, the URL `https://github.com/VBCDX/vbcdx.git` (`LEGACY_URL`), is still
read, exactly, with a note: a copy whose base branch's `verify-dir.mjs` still asks for the URL
takes the new files with that line first, and moves to the name in its next pull request.
Every other spelling of the URL is refused. The second line is a release tag in form,
the third a commit id in form; a `SOURCE` that is neither `canonical` nor these lines in
this order (the earlier form that began with the commit id included) cannot be checked
(status 2).

A copy taken at a commit that has no release tag yet writes, on the second line, a commit
pin instead of a tag: `vX.Y.Z-commit.<the 40-hex commit id>`, where `X.Y.Z` is the release
the commit will become. It names no tag, so it claims nothing about one; it is a release
tag in form, so a base whose `verify-dir.mjs` predates it still reads it. `verify-dir.mjs`
refuses (status 1) a pin whose id is not the third line's, in full. That the commit is the
owning repository's, and the files are that commit's, is for the reviewer of the copy to
compare (`git archive <commit> ci/general-use`, in the owning repository on the forge it is
hosted on); the copy moves to the real tag once there
is one.

`verify-dir.mjs` refuses the directory (status 1) if a pinned file is missing or changed, if
a file is there that is not listed, if `SOURCE` is missing, or, in a copy, if `SOURCE` names
another source or the local `SHA256SUMS` is not byte for byte the list `SOURCE` records. So
a copy whose scanner was edited fails, and so does one whose scanner was edited and whose
`SHA256SUMS` was regenerated to match. The check is offline: nothing is fetched. What it
cannot see is a record that was itself rewritten, or a tag and a commit that are not the
owning repository's, so a change to `SOURCE` is reviewed against the owning repository at
the tag it names.

To take a new version into another repository: copy the five shared files and `SHA256SUMS`
unchanged, write `SOURCE`, and fix or allow-list what the new rules find, in one pull
request (byte-identical files, never an edit in place):

```
(cd ci/general-use && { echo VBCDX/vbcdx; echo <tag>; echo <commit>; echo; cat SHA256SUMS; } > SOURCE)
```

Different rules in two repositories then show as a `SHA256SUMS` mismatch, never as a silent
difference.

To change the rules in the owning repository: edit, then regenerate the list with

```
(cd ci/general-use && sha256sum README.md gate.mjs scan.mjs scan.test.mjs verify-dir.mjs > SHA256SUMS)
```

## Limits

- An allow-list entry is bound to a file, a class and the hash of the line, not to a line
  number: it passes that line wherever it stands in the file, and every other line of the
  file with the same text. That keeps an entry valid when lines move, and it means an entry
  for a common line allows each copy of it in that file.
- UTF-16 is read as text only where the file starts with a byte-order mark. A UTF-16 or
  UTF-32 file without one holds NUL bytes and is scanned as bytes: a name written in it is
  not matched. The note that names the file is the signal to look at it.
- A colour literal and a reference of three or four digits look the same. The scanner takes
  the number for a colour after a lower-case word and a colon when a semicolon follows, and
  alone in quotes: a reference written exactly like that is not reported.
- The short-id rule reads one line. Outside a code file, a code name that stands alone
  before a comma, a closing parenthesis or the end of a line (an enum variant with no value,
  the last argument of a call) still has the shape of a work-item id and is reported:
  allow-list the line, or give the name another shape. In a code file the same holds for a
  name after a word (`return`), at the start of a line, or on a line with no call and no
  two-character operator.
- In a code file, what is a comment or a string literal is told from the one line. The
  inner lines of a block comment that do not start with `*`, and of a literal that runs over
  several lines, show no mark: a short id there is reported unless the line also looks like
  code (a call or an operator, and the id between brackets, commas or operators), and then
  it is not. Text of a page written between tags in a `.tsx` or `.jsx` file is the same
  case. A single quote left open on a line is read as no literal (an apostrophe, a
  lifetime), so what follows it is read as code.
- A short id written inside the path data of a `d="..."` attribute is not reported, and
  neither is one on a line with a Unicode code point when it has the name of a control set.
- In a code file, a `name = value` pair with an unquoted value made of short dotted names is
  read as an expression: a credential written that way, unquoted, in a comment or in text
  embedded in code, with no part of 20 characters or more, is not reported. The same value
  in a settings file, a script or a data file is.
- In a code file, a line that holds only the key word of a credentials file with a capital
  first letter and a value of the shape of one name (under 20 characters) is read as a
  field and its type, and is not reported. In lower case, or with a machine or a login
  before it, it is: so a field of that name written in lower case is reported too.
- A signing tool's secret key in a form other than the three above (its base64 split over
  lines, or re-encoded) is not found. The name of the format in prose no longer is a hit.
- In a URL the placeholder words are not reported as a pass phrase, also where one of them
  really is the pass phrase.
- In a `.json` file of a `seed` directory, a value made of the placeholder prefix and one
  short lower-case word is not reported, whatever the word.
- In a `.md` file the standard private block with the `/16` prefix is not reported; an
  address written inside it is.
- An option with the word `public` in its name is not reported as one that takes a secret,
  whatever comes after that word.
- A test directory is told by its name and by having no `src` directory above it, not by
  what it holds. A product file placed in such a directory is exempt from `secret-flag` and
  `first-party` like a test: review is the control. Tests kept under a `src` directory are
  not exempt unless the file is named as a test, or the lines are in `allow.txt`. No test is
  exempt from `secret-shape` or `assembled`.
- Commit author and committer names are not scanned.
- A secret is found by its shape, not by its value: one with no prefix, no key word before
  it and no header around it is not found, and a made-up value with the shape is. The
  shapes were written for text people post; in source they also match a made-up connection
  string, a canary and a vendor's documented example, which is what `allow.txt` is for.
- A path with a secret's shape is kept out of the scanner's own lines. `gate.mjs` names the
  files of `ci/general-use/` and the workflow entries a branch changes, by path: a file of
  that kind with such a name would be named there. Such a file cannot be allowed by
  `allow.txt` in a useful way either, since the entry would hold the path: rename it.
- The placeholders are told by how they begin, and not every shape knows every one. Of the
  eight forms a value is replaced by (`<R>`, `<V len=N>`, `<redacted>`, `***`, `${VAR}`,
  `$VAR`, `{file:...}`, `{env:...}`), each put where the value stands in nine kinds of line,
  7 of the 72 combinations are still a hit: after the key word of a credentials file, alone
  or behind its machine and login, `${VAR}`, `{file:...}` and `{env:...}` are (6), and so is
  `{env:...}` where a URL's pass phrase stands (1). Write `<redacted>` or `***` there.
- `assembled` is not looked for in a file that holds a NUL byte: such a file is scanned as
  bytes for the names themselves, and its lines are not read for joins.
- `assembled` reads one line, and only literals the line itself joins. A name built over
  several lines, from variables, with a template, or by a function is not found.
- `assembled` skips the gate's five shared files by their paths, not by their content: a
  pull request that edits one of them and regenerates `SHA256SUMS` can put a joined name
  there that this class does not see. That is a change to the gate's own files (see *What
  the code stops*), named in the log and reviewed as one; a name written out in full is still
  found there by its own class.
- On a push, the messages scanned are those the head adds to its first parent. Commits
  pushed together without a merge (several fast-forwarded commits) are covered by the pull
  request's scan, not by the push's.
- A forge that merges with a merge commit, not a squash, writes the pull request's number
  inside the subject, not at its end: that subject is reported on the push.
- `SOURCE` names the owning repository, a tag (or a commit pin) and a commit. That
  the tag exists there and points at that commit, or that a pinned commit is the owning
  repository's, is not something an offline check can see: the reviewer of the copy checks
  it.
- Until the copies have moved to the name, `verify-dir.mjs` also reads the earlier first
  line, the URL `https://github.com/VBCDX/vbcdx.git`, exactly, with a note: it is how a copy
  moves without its base branch's check refusing it. Every other spelling of it is refused.
  A later change of the shared files stops reading it.
- A workflow edit that keeps the gate's job, the text before `jobs:` and the counts passes
  with a notice: step (b) is a tripwire, and what such an edit does is for the forge's
  protection of the workflow path to review. An edit it cannot cut (no single `jobs:`
  line, jobs not indented by spaces) is refused even where it is harmless.

No network is used, and no dependency beyond Node 22 and git.
