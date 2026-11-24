#!/usr/bin/env node
// The general-use gate: nothing in the repository names one deployment, and no first-party
// name is special-cased outside the files that declare it.
//
// It scans every tracked file (comments, tests, fixtures, CI and docs included), every
// tracked path and, for a pull request, the commit messages of its range. A hit is printed
// as `path:line [class]` and nothing else: the matched text and the line are never printed,
// so a secret that shares a line with a hit cannot reach the job log.
//
// Every deny pattern is assembled from fragments, so this file never matches its own rules
// and can sit in a tree that is scanned by them.
//
// Exit status: 0 clean, 1 hits (or a refused or stale allow-list entry), 2 the scan could
// not be completed (git failed, a file could not be read, a bad argument). A scan that
// could not look is never reported as clean.
//
// On a pull request this file is not started directly: gate.mjs, taken from the base branch,
// runs the base branch's copy of it and then this one, and both must pass.
//
// Node built-ins only. No network.
import { readFileSync, lstatSync, readlinkSync, existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const j = (...parts) => parts.join("");
const re = (flags, ...parts) => new RegExp(j(...parts), flags);

// ---------------------------------------------------------------------------------------
// Where a line stands. A few rules read a line differently by the kind of file it is in.
// The path is given by the scan of a tracked file only: a commit message, a path, and a
// line given with no path get every rule at its strictest.
// ---------------------------------------------------------------------------------------

// The files whose lines are program code, by the extension of their name. This is the one
// list: a file of code under another name (a `.txt`) is not on it and is read strictly.
const CODE_EXTENSIONS = new Set(["js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "go", "py", "java", "kt", "rb", "php", "cs", "swift", "c", "h", "cc", "cpp"]);
// Of those, the ones in which `#` starts a comment.
const HASH_COMMENT_EXTENSIONS = new Set(["py", "rb", "php"]);
const extensionOf = (path) => {
  if (typeof path !== "string") return "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
};
export const isCodePath = (path) => CODE_EXTENSIONS.has(extensionOf(path));
const isMarkdownPath = (path) => extensionOf(path) === "md";

// True when a match of the pattern on the line is not excepted. Every match is asked, the
// ones that overlap an excepted match too: a line with one excepted match and one that is
// not is a hit.
const GLOBAL_COPY = new Map();
function someMatch(pattern, line, excepted) {
  let all = GLOBAL_COPY.get(pattern);
  if (!all) GLOBAL_COPY.set(pattern, (all = new RegExp(pattern.source, `${pattern.flags}g`)));
  all.lastIndex = 0;
  for (let m; (m = all.exec(line)); all.lastIndex = m.index + 1) if (!excepted(m)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------
// Deny classes. Each: an id (the `[class]` printed and the class column of allow.txt), the
// patterns, and samples every one of which must be caught by this class (the self-test).
// ---------------------------------------------------------------------------------------

// Two-or-three character tokens that are generic technology names, not ids of work items.
// The list is part of the one shared rule set; it is not configurable per repository.
const GENERIC_SHORT = new Set(["V8", "S3", "K8s"]);

const SECRET_WORD = "(?:token|password|passwd|secret|key|apikey)";

// A capital letter, a digit and an optional lower-case letter, as a whole token. Not inside
// a longer word or number, a path, a dotted version, hex or base64.
const SHORT_ID = re("g", "(?<![\\w./#$@%&=+:~^\\\\'\"<>\\[{|*-])", "[A-Z]\\d[a-z]?", "(?![\\w/=+:~^\\\\'\">\\]}|*-]|\\.\\w)");
// A page size, a heading level or a quarter is followed or preceded by its noun.
const SHORT_ID_NOUN_AFTER = /^\s?(?:paper|pages?|sheets?|size|sized|landscape|portrait|headings?|tags?|titles?|\d{4}\b)/i;
// A token inside a list of such tokens is a code name (an enum variant, a type parameter),
// not a work item: an opening bracket or a comma stands before it, and its own comma is
// followed by another such token. Both sides are needed. A token that starts a sentence and
// is followed by a comma is a hit, and so is one in parentheses with a word after its comma.
const SHORT_ID_LIST_BEFORE = /[(\[,]\s*$/;
const SHORT_ID_LIST_AFTER = /^,\s*[A-Z]\d[a-z]?(?!\w)/;

// A pattern for prose: too short to mean anything in the bytes of a binary file, where it
// is not applied. Every other pattern is applied to binary files too, so a file cannot be
// kept out of the scan by putting a NUL byte in it.
const prose = (pattern) => ({ test: (line) => pattern.test(line), prose: true });

// A bare `#N` in prose. A colour literal isn't one: three or four digits, as the last value
// of a CSS declaration (a lower-case property name, a colon, the value, a semicolon) or as
// the whole of a quoted string. Every other form is, an issue number after a capitalised
// word and a colon, in parentheses or of another length included.
const BARE_REF = re("g", "(?<![\\w&/])", "#\\d{1,4}\\b");
const CSS_DECLARATION_BEFORE = /(?:^|[\s;{"'])[a-z-]+\s*:[^:;{}]*$/;

function bareRefHit(line) {
  BARE_REF.lastIndex = 0;
  for (let m; (m = BARE_REF.exec(line)); ) {
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + m[0].length);
    const digits = m[0].length - 1;
    if (digits === 3 || digits === 4) {
      if (after.startsWith(";") && CSS_DECLARATION_BEFORE.test(before)) continue;
      const quote = before.slice(-1);
      if ((quote === '"' || quote === "'") && after.startsWith(quote)) continue;
    }
    return true;
  }
  return false;
}

// The two sets of control characters of Unicode have names of this shape. They are those
// sets, and no work item, on a line that also writes a code point (`U+` and its hex digits).
const UNICODE_SET_NAMES = new Set([j("C", "0"), j("C", "1")]);
const CODE_POINT = /\bU\+[0-9A-Fa-f]{4,6}\b/;

// The path data of a drawing: the value of a `d="..."` attribute that holds nothing but
// path commands and numbers. Its commands have the shape of a short id and are none.
const PATH_DATA_ATTRIBUTE = /(?<![\w-])d=(["'])([^"']*)\1/g;
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE\s,.+-]*$/;
function inPathData(line, index) {
  for (const m of line.matchAll(PATH_DATA_ATTRIBUTE)) {
    const start = m.index + m[0].length - m[2].length - 1;
    if (index >= start && index < start + m[2].length && PATH_DATA.test(m[2])) return true;
  }
  return false;
}

// What stands in for a character of a comment or a string literal in the code of a line. It
// is a character no value stands after: a comment and a literal start with their own mark,
// so a token inside one always has this before it.
const NOT_CODE = '"';
/**
 * A line of a code file with every character of a comment or a string literal replaced, as
 * far as the one line shows: a `//` comment (a `#` one where the language has it), a block
 * comment opened on the line, a line of a block comment that starts with `*`, and a literal
 * between two quotes of one kind. A double quote or a backquote that is not closed on the
 * line opens a literal to the end of the line; a single quote that is not closed is no
 * literal (an apostrophe, a lifetime). What is in doubt is read as not code.
 */
function codeOf(line, extension) {
  const blank = (from, to) => NOT_CODE.repeat(to - from);
  if (/^\s*\*(?:\s|\/|$)/.test(line)) return blank(0, line.length);
  let out = "";
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    const two = line.slice(i, i + 2);
    if (two === "//" || (c === "#" && HASH_COMMENT_EXTENSIONS.has(extension))) return out + blank(i, line.length);
    if (two === "/*") {
      const close = line.indexOf("*/", i + 2);
      const end = close === -1 ? line.length : close + 2;
      out += blank(i, end);
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      let end = i + 1;
      while (end < line.length && line[end] !== c) end += line[end] === "\\" ? 2 : 1;
      if (end >= line.length && c === "'") {
        out += c;
        i += 1;
      } else {
        end = Math.min(end + 1, line.length);
        out += blank(i, end);
        i = end;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}
// A line of code, and no line of prose inside a comment or a literal that runs over several
// lines (which one line cannot show): it holds a call or an operator of two characters.
const CODE_EVIDENCE = /[A-Za-z_]\w*!?\(|!\[|==|!=|=>|->|::|&&|\|\|/;
// Where a value stands in code: after an opening bracket, a comma or an operator, and before
// a closing bracket, a comma, a semicolon, an operator or the end of the line. A word before
// it or after it makes it a word of a sentence.
const VALUE_BEFORE = /[(\[,=&|]\s*$/;
const VALUE_AFTER = /^\s*(?:[)\],;{}=&|]|$)/;
/** In a line of a code file: the token at `index` is an identifier used as a value, not a word of a comment, a literal or a sentence. */
function bareIdentifier(code, index, length) {
  if (!CODE_EVIDENCE.test(code.replaceAll(NOT_CODE, " "))) return false;
  return VALUE_BEFORE.test(code.slice(0, index)) && VALUE_AFTER.test(code.slice(index + length));
}

function shortIdHit(line, path) {
  const code = isCodePath(path) ? codeOf(line, extensionOf(path)) : null;
  SHORT_ID.lastIndex = 0;
  for (let m; (m = SHORT_ID.exec(line)); ) {
    if (GENERIC_SHORT.has(m[0])) continue;
    const after = line.slice(m.index + m[0].length);
    if (SHORT_ID_NOUN_AFTER.test(after)) continue;
    // A call, or a variant that carries a value. A closing parenthesis after it changes nothing.
    if (after.startsWith("(")) continue;
    if (SHORT_ID_LIST_AFTER.test(after) && SHORT_ID_LIST_BEFORE.test(line.slice(0, m.index))) continue;
    if (UNICODE_SET_NAMES.has(m[0]) && CODE_POINT.test(line)) continue;
    if (inPathData(line, m.index)) continue;
    if (code !== null && bareIdentifier(code, m.index, m[0].length)) continue;
    return true;
  }
  return false;
}

// The shapes of secrets: a key block's first line, a token with a vendor's prefix, a header
// or a key=value pair that carries a credential. A match says a secret may be in the tree;
// which shape matched is not printed, only the class. Each shape has a name (for the tests)
// and a sample, and like every pattern here it is assembled from fragments. A value that is
// a placeholder (<...>, [...], ***, REDACTED, ${VAR}, $VAR) is not one.
const NOT_A_PLACEHOLDER = "(?!<|\\[|\\*\\*\\*|REDACTED|\\$\\{?)";
const CREDENTIAL = "[A-Za-z0-9+/=._~-]";
// Filler for the samples: letters and digits, of the length a shape asks for.
const filler = (n) => "Zq7Xw2Lm9Tn4Rb8Vc1Yd6Hf3Kj5Pg0SsAa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8".slice(0, n);

// What a secret's shape is not. Each of these is asked of one match, in one kind of file or
// one context; none of them takes a shape out of a file.

// The base64 of a signing tool's secret key: 158 bytes (three two-byte marks, a salt of 32,
// two limits of 8, a key id of 8, the key of 64 and a checksum of 32), so 212 characters
// with one `=` at the end. The first eight say whether the key is encrypted.
const MINISIGN_SECRET_BASE64 = 4 * Math.ceil((2 + 2 + 2 + 32 + 8 + 8 + 8 + 64 + 32) / 3);

// A run of base64 characters as long as this is a value, whatever stands around it: nothing
// that holds one is read as code.
const LONG_RUN = /[A-Za-z0-9+/=_-]{20,}/;
// A name in code: a letter or an underscore first.
const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";
const MEMBER_CHAIN = re("", "^", IDENTIFIER, "(?:\\.", IDENTIFIER, ")*");
// The characters a credential is written in, and the quotes: what follows a member access
// that is the whole of a value is none of them.
const VALUE_GOES_ON = /^[A-Za-z0-9+/=._~"'`-]/;
/**
 * An unquoted value, from its first character to the end of the line, is an expression of a
 * program and no credential: names joined by dots, then a call's parenthesis or `::`; or two
 * or more names joined by dots and nothing more of the value after them.
 */
function isCodeExpression(value) {
  if (LONG_RUN.test(value)) return false;
  const chain = MEMBER_CHAIN.exec(value);
  if (chain === null) return false;
  const after = value.slice(chain[0].length);
  if (after.startsWith("(") || after.startsWith("::")) return true;
  return chain[0].includes(".") && !VALUE_GOES_ON.test(after);
}

// The value a demonstration's seed data writes where a secret would be: the fixed prefix and
// one short lower-case word, as the whole of a quoted value, in a `.json` file of a `seed` directory.
const SEED_PLACEHOLDER = re("", "^demo-place", "holder:[a-z]{1,24}\"");
const isSeedPath = (path) => typeof path === "string" && /(?:^|\/)seed\/[^/]+\.json$/.test(path);

// A field of a structure and its type, in code: the field's name with its capital (the key
// word of a credentials file is written in lower case), then a type that is one of the two
// forms below or a name (with a package's name before it, or without) with no long run in
// it, then a tag in backquotes or nothing.
const TYPE_FORMS = new Set(["[]byte", "*string"]);
const TYPE_NAME = re("", "^", IDENTIFIER, "(?:\\.", IDENTIFIER, ")?$");
const TYPED_FIELD = re("", "^\\s*Pass", "word\\s+(\\S+)(?:\\s+`[^`]*`)?\\s*$");
function isTypedField(line) {
  const field = TYPED_FIELD.exec(line);
  return field !== null && !LONG_RUN.test(field[1]) && (TYPE_FORMS.has(field[1]) || TYPE_NAME.test(field[1]));
}

// The words that stand where a pass phrase would in the address of an example.
const PLACEHOLDER_PASS_WORDS = new Set([j("pa", "ss"), j("pass", "word")]);
export const SECRET_SHAPES = [
  { name: "pem_private", pattern: re("", "-----BEGIN [A-Z0-9 ]*PRIV", "ATE KEY(?: BLOCK)?-----"), sample: j("-----BEGIN RSA PRIV", "ATE KEY-----") },
  { name: "pgp_private", pattern: re("", "-----BEGIN PGP PRIV", "ATE KEY BLOCK-----"), sample: j("-----BEGIN PGP PRIV", "ATE KEY BLOCK-----") },
  {
    // A key, not the name of its format: the first line of a key file (the line starts with
    // it); that line inside a literal that goes on with base64 after its line break (a key
    // file written on one line: a literal that ends at the line break, or goes on with a
    // place for a value, only builds the header); or the base64 of a secret key, encrypted
    // or not, at its length. Whatever stands before the
    // key does not matter: in a one-line literal it is the letter of a line break.
    name: "minisign_secret",
    pattern: re(
      "i",
      "^\\s*untrusted comment: mini", "sign (?:encrypted )?sec", "ret key(?:\\s.*)?\\s*$",
      "|untrusted comment: mini", "sign (?:encrypted )?sec", "ret key\\\\n[A-Za-z0-9+/]",
      "|R", "W(?:RTY0", "Iy|QAAE", "Iy)[A-Za-z0-9+/]{", String(MINISIGN_SECRET_BASE64 - 9), "}=(?![A-Za-z0-9+/=])",
    ),
    sample: j("untrusted comment: mini", "sign encrypted sec", "ret key"),
  },
  { name: "openssh_private", pattern: re("", "-----BEGIN OPENSSH PRIV", "ATE KEY-----"), sample: j("-----BEGIN OPENSSH PRIV", "ATE KEY-----") },
  { name: "openai_like", pattern: re("", "\\bs", "k-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}"), sample: j("s", "k-proj-", filler(24)) },
  { name: "stripe_live", pattern: re("", "\\b(?:sk|rk)_li", "ve_[A-Za-z0-9]{16,}"), sample: j("rk_li", "ve_", filler(20)) },
  { name: "vbcdx_token", pattern: re("", "\\bvb", "x_(?:ses|tok|enr)_[A-Za-z0-9]{16,}"), sample: j("vb", "x_enr_", filler(20)) },
  { name: "slack", pattern: re("", "\\bxo", "x[abposr]-[A-Za-z0-9-]{10,}"), sample: j("xo", "xb-", "1234567890-", filler(10)) },
  { name: "github", pattern: re("", "\\b(?:gh", "p|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\\bgithub", "_pat_[A-Za-z0-9_]{40,}"), sample: j("gh", "p_", filler(36)) },
  { name: "gitlab", pattern: re("", "\\bgl", "pat-[A-Za-z0-9_-]{20,}"), sample: j("gl", "pat-", filler(22)) },
  { name: "npm", pattern: re("", "\\bnp", "m_[A-Za-z0-9]{36}\\b"), sample: j("np", "m_", filler(36)) },
  { name: "aws_akid", pattern: re("", "\\b(?:AK", "IA|AS", "IA)[0-9A-Z]{16}\\b"), sample: j("AK", "IA", "ABCDEFGHIJ234567") },
  { name: "google_api", pattern: re("", "\\bAI", "za[0-9A-Za-z_-]{35}\\b"), sample: j("AI", "za", filler(35)) },
  { name: "coolify_token", pattern: re("", "\\b\\d{1,6}\\|", "[A-Za-z0-9]{40,}\\b"), sample: j("12", "|", filler(40)) },
  { name: "jwt", pattern: re("", "\\bey", "J[A-Za-z0-9_-]{10,}\\.ey", "J[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"), sample: j("ey", "J", filler(12), ".ey", "J", filler(12), ".", filler(12)) },
  { name: "auth_header", pattern: re("i", "\\bauthori", "zation\\s*:\\s*(?:bearer|token|basic)\\s+", NOT_A_PLACEHOLDER, CREDENTIAL, "{12,}"), sample: j("Authori", "zation: Bearer ", filler(20)) },
  { name: "x_api_key", pattern: re("i", "\\b(?:x-api-", "key|x-litellm-api-", "key|api-", "key)\\s*:\\s*", NOT_A_PLACEHOLDER, CREDENTIAL, "{12,}"), sample: j("x-api-", "key: ", filler(16)) },
  {
    name: "url_userinfo",
    pattern: re("i", "\\b[a-z][a-z0-9+.-]*://[^/\\s:@]+:(?!<|\\*\\*\\*|\\$\\{?)([^/\\s@]{4,})@"),
    except: (m) => PLACEHOLDER_PASS_WORDS.has(m[1].toLowerCase()),
    sample: j("https://someone:", "pa55-word@", "example.invalid/"),
  },
  {
    name: "netrc_password",
    pattern: re("i", "^\\s*(?:machine\\s+\\S+\\s+)?(?:login\\s+\\S+\\s+)?pass", "word\\s+(?!<|\\*\\*\\*)\\S{6,}"),
    except: (m, line, path) => isCodePath(path) && isTypedField(line),
    sample: j("machine example.invalid login someone pass", "word ", filler(10)),
  },
  {
    name: "kv_secret",
    pattern: re(
      "i",
      // The key word starts the name or follows a separator in it (`_`, `-`, `.`): the word boundary
      // of a regular expression does not see the one in NAME_WORD. Inside a longer word it is no key word.
      "(?<![A-Za-z0-9])(?:pass", "word|passwd|sec", "ret_access_key|sec", "ret|client_sec", "ret|api_?key|access_tok", "en|refresh_tok", "en|private_key|tok", "en|kek)[\"']?\\s*[:=]\\s*([\"']?)",
      "(?!<|\\[|\\*\\*\\*|REDACTED|\\$\\{?|xxx)(", CREDENTIAL, "{16,})",
    ),
    except: (m, line, path) => {
      const value = line.slice(m.index + m[0].length - m[2].length);
      return (isSeedPath(path) && m[1] === '"' && SEED_PLACEHOLDER.test(value)) || (isCodePath(path) && m[1] === "" && isCodeExpression(value));
    },
    sample: j("client_sec", "ret = \"", filler(20), "\""),
  },
  { name: "cloudflare_access_secret", pattern: re("", "\\bcf", "ast_[A-Za-z0-9]{48}\\b"), sample: j("cf", "ast_", filler(48)) },
];

const shapeHit = (shape, line, path) => (shape.except ? someMatch(shape.pattern, line, (m) => shape.except(m, line, path)) : shape.pattern.test(line));

/**
 * The names of the secret shapes a line matches (for the tests and for a local look: never
 * printed by the scan). `path` is the file the line is in, when it is a line of a tracked file.
 */
export const shapesOf = (line, { path } = {}) => SECRET_SHAPES.filter((shape) => shapeHit(shape, line, path)).map((shape) => shape.name);

// An address of the deployment's networks. In a page of documentation (`.md`) the standard
// private block that one of them is written inside, as the whole block and nothing else, is
// the block of the standard and no address of a deployment.
const LAN_ADDRESS = re("", "192\\.168", "\\.(?:40|0|25|5)\\.\\d+|\\b10\\.20", "\\.20\\.\\d+");
const STANDARD_BLOCK = j("192.168", ".0.0/16");
const isStandardBlock = (line, index) => line.startsWith(STANDARD_BLOCK, index) && !/[\d.]/.test(line[index - 1] ?? "") && !/\d/.test(line[index + STANDARD_BLOCK.length] ?? "");

// An option whose name has the word `public` in it takes a public key, which is no secret.
const NOT_PUBLIC = "(?!(?:[a-z0-9]+-)*public-)";

export const CLASSES = [
  {
    id: "person",
    patterns: [
      prose(re("", "\\bT", "y\\b")),
      re("i", "tya", "bonil"),
      re("i", "\\bwai", "son\\b"),
      re("", "/home/", "ty\\b"),
      re("i", "ty\\.abo", "nil"),
    ],
    samples: [j("ask T", "y first"), j("tya", "bonil"), j("/home/", "ty/x"), j("wai", "son"), j("ty.abo", "nil@example.invalid")],
  },
  {
    id: "internal-host",
    patterns: [
      re("i", "tam", "tam"),
      re("", "\\bpv", "e[1-9]\\b"),
      re("", "/mnt", "/pve"),
      re("i", "\\bceph", "fs\\b"),
      re("i", "codi", "-sdm"),
      re("i", "witchy", "roo"),
      re("i", "\\bai", "-001\\b"),
      re("i", "hermes", "AI"),
      re("", "hermes", "\\d\\d"),
      re("", "\\bapps", "-0\\d"),
      re("", "\\bai", "-tools\\b"),
    ],
    samples: [
      j("git.", "tam", "tam", ".co"), j("on pv", "e9"), j("/mnt", "/pve/x"), j("the Ceph", "FS store"),
      j("codi", "-sdm.com"), j("witchy", "roo.com"), j("ai", "-001"), j("hermes", "AI"), j("hermes", "02"), j("apps", "-002"), j("ai", "-tools"),
    ],
  },
  {
    id: "lane",
    patterns: [
      re(
        "",
        "\\b(?:se", "c-(?:net|arch)|de", "v-(?:keyhole|hc|trading|dispatch|caddy)|cra", "zy-ivan|pv", "e-(?:ops|agent)",
        "|op", "s-(?:mcp|forgejo)|p", "m-coordinator[\\w-]*|human", "-interface|lea", "d-(?:he", "rd|trading)|pv", "e9-verifier)\\b",
      ),
      re("i", "pve", "-agent"),
      re("", "\\bfork", " [A-D]\\b"),
      re("i", "circle", "-q"),
      re("", "\\bCODER", "_AGENT\\b|FORGEJO_(?:USER|PASS)", "_[A-Z]"),
    ],
    samples: [
      j("se", "c-net"), j("de", "v-hc"), j("cra", "zy-ivan"), j("pve", "-agent"), j("op", "s-forgejo"),
      j("lea", "d-he", "rd"), j("fork", " B"), j("circle", "-q"), j("CODER", "_AGENT"),
    ],
  },
  {
    id: "vocabulary",
    patterns: [re("i", "\\bhe", "rd\\w*|he", "rdr")],
    samples: [j("he", "rd mode"), j("the He", "rd's board"), j("he", "rdr")],
  },
  {
    id: "tracker",
    patterns: [
      re("", "\\b(?:dispatch|vbcdx|keyhole|vbcdx-core|development|homelab-docs|core|installer|DEV|DAP|FP|CP)", "#\\d"),
      re("", "infra", "structure/[\\w.-]+"),
      re("i", "hermes", "-cluster"),
      { test: bareRefHit, prose: true },
      re("", "\\bc1", "\\d{5}\\b"),
      re("", "\\bE9", "\\.\\d\\b"),
      prose(re("", "\\bQ", "\\d+\\b")),
      prose(re("", "§", "\\s?\\d")),
      { test: shortIdHit, prose: true },
    ],
    samples: [
      j("see core#", "12"), j("DAP#", "118"), j("infra", "structure/caddy"), j("hermes", "-cluster"), j("see #", "43"),
      j("Refs #", "7"), j("comment c1", "23456"), j("row E9", ".3"), j("waits on Q", "5"), j("spec §", "7"),
      j("card A", "1 is done"), j("(C", "1)"), j("B", "2b, then E", "2c"),
      j("fixed: #", "12"), j("(see #", "12)"), j('"#', '12 is open"'),
      j("Refs: #", "12;"), j("Refs: #", "123;"), j('"#', '12"'),
      j("B", "2b, then more"), j("(C", "1, pending)"), j("done: B", "2b, C", "3]"),
    ],
  },
  {
    id: "lan-ip",
    patterns: [{ test: (line, path) => someMatch(LAN_ADDRESS, line, (m) => isMarkdownPath(path) && isStandardBlock(line, m.index)) }],
    samples: [j("192.168", ".40.9"), j("192.168", ".0.9"), j("10.20", ".20.9")],
  },
  {
    id: "ct-id",
    patterns: [re("", "\\b(?:C", "T|V", "M) ?\\d{3,4}\\b")],
    samples: [j("C", "T 123"), j("V", "M1234")],
  },
  {
    id: "forge",
    patterns: [re("i", "git\\.", "tam|npm\\.", "tam"), re("", "/api/packages", "/VBCDX"), re("i", "verd", "accio")],
    samples: [j("https://git.", "tam", "tam.co/x"), j("npm.", "tam", "tam.co"), j("/api/packages", "/VBCDX/npm/"), j("verd", "accio")],
  },
  {
    id: "review-process",
    patterns: [
      re("", "IVAN", " VERDICT|ivan_state", "_mark|audit", "\\.sh|\\[agent", "-update\\]"),
      re("i", "reward", "-hack"),
      // A reference to one review of one change: its number, its round or its finding.
      re("i", "\\bPR re", "view\\b|\\bre", "view (?:c?\\d{3,}\\b|findings? \\d)|\\bro", "und [2-9]\\b"),
    ],
    samples: [
      j("IVAN", " VERDICT"), j("ivan_state", "_mark"), j("[agent", "-update]"), j("reward", "-hack"),
      j("(PR re", "view)"), j("re", "view 4538"), j("re", "view finding 2"), j("Ro", "und 3, item 1"),
    ],
  },
  {
    id: "deploy-id",
    patterns: [re("", "\\b(?=[a-z0-9]{24}\\b)(?=[a-z0-9]*[g-z])", "(?=[a-z0-9]*\\d)[a-z0-9]{24}\\b")],
    samples: [j("s171azawtq", "ablhu5nmfv8l4m")],
  },
  {
    // A command-line option that takes a secret as its value: the value would sit in the
    // process list and the shell history. An option that takes a file, or reads standard
    // input, is the way (its name ends in -file or -stdin, so it is not matched). Source
    // only: a test may pass such an option to show it is refused.
    id: "secret-flag",
    sourceOnly: true,
    patterns: [
      re("", "[\"']--", NOT_PUBLIC, "(?:[a-z0-9]+-)*", SECRET_WORD, "[\"']"),
      re("", "\\blong\\s*(?:=\\s*|\\(\\s*)\"", NOT_PUBLIC, "(?:[a-z0-9]+-)*", SECRET_WORD, "\""),
      re("", "\\bflag\\.(?:String|StringVar)\\(\\s*(?:&[\\w.]+,\\s*)?\"", NOT_PUBLIC, "(?:[a-z0-9]+-)*", SECRET_WORD, "\""),
    ],
    samples: [
      j('opts.add("--', 'token")'), j("'--api-", "key'"), j('#[arg(long = "', 'password")]'), j('.long("client-', 'secret")'),
      j('flag.String("', 'token", "", "the token")'), j('flag.StringVar(&cfg.Key, "api-', 'key", "", "")'),
    ],
  },
  {
    // A secret, by its shape. Everywhere: source, tests, paths and commit messages. A test
    // that needs a value of such a shape either assembles it, or its line is in allow.txt.
    id: "secret-shape",
    patterns: SECRET_SHAPES.map((shape) => ({ test: (line, path) => shapeHit(shape, line, path) })),
    samples: SECRET_SHAPES.map((shape) => shape.sample),
  },
];

// The names the requirement lists, written independently of CLASSES (and from fragments):
// every one must be caught, and deleting any class must leave at least one uncaught.
export const REQUIRED = [
  j("tya", "bonil"), j("ask T", "y"), j("/home/", "ty"),
  j("tam", "tam"), j("pv", "e5"), j("ai", "-001"), j("hermes", "AI"), j("hermes", "01"), j("hermes", "02"),
  j("pve", "-agent"), j("fork", " A"), j("fork", " D"), j("circle", "-q"), j("se", "c-net"), j("de", "v-keyhole"),
  j("the he", "rd"), j("He", "rd mode"),
  j("infra", "structure/caddy#64"), j("hermes", "-cluster"), j("vbcdx#", "7"), j("see #", "9"), j("c1", "98765"),
  j("E9", ".3"), j("Q", "5"), j("§", "7"), j("card A", "1"), j("C", "1"), j("B", "2b"),
  j("192.168", ".40.7"), j("10.20", ".20.7"),
  j("C", "T 999"), j("V", "M 321"),
  j("/api/packages", "/VBCDX"), j("verd", "accio"),
  j("IVAN", " VERDICT"), j("reward", "-hack"), j("PR re", "view 1234"),
  j("k3x9q2m7w4z8", "t1v6y5u0r3p8"),
  j('"--', 'token"'), j('long = "', 'secret"'),
  j("-----BEGIN EC PRIV", "ATE KEY-----"), j("gh", "s_", "0123456789abcdefghijABCDEFGHIJ0123"), j("refresh_tok", "en: ", "0123456789abcdefgh"),
];

// Text that must match no class: generic words and numbers that sit close to a pattern.
export const NEGATIVE = [
  "a shepherd", "typed", "Type", "empty", "a party",
  "sha256:0xA1B2C3", "#A1B2C3", "color: #fff", "deadbeefA1", "0xC1", "a1b2c3d4",
  "color: #333;", "background:#000;", "'#000'", '"#333"', j("border: 1px solid #", "333;"),
  j("V", "4(addr)"), j("Ip::V", "6"), j("ip.V", "4"), j("[V", "4, V", "6]"), j("[x, V", "6, T", "1]"), j("f(V", "4, V", "6, T", "1]"),
  "an A4 page", "A4 paper", "ISO A3 size", "an H2 heading",
  "X25519", "P256", "SHA1", "ES256", "A256GCM", "HS256", "Ed25519", "AES-256-GCM",
  "HTTP/2", "HTTP/1.1", "h2c", "v1", "V1.2", "1.2.3", "v0.2.14", "node22", "Node 22",
  "V8's block ranges", "an S3 bucket", "K8s",
  "path/A1/file", "A1.json", "--flag=B2", "x=C1", "arr[E2]", "utf8", "UTF-8", "ipv4", "IPv6", "base64",
  "issue number 12", "item 3", "# heading", "#!/usr/bin/env node", "a#1", "&#39;", "/#12",
  "127.0.0.1", "10.0.0.0/8", "172.16.0.1", "192.168.1.1", "192.0.2.10", "203.0.113.7", "example.invalid",
  "CT scan", "a VM", "VM 12", "CTR mode",
  "a 0123456789abcdef01234567 hex id", "abcdefghijklmnopqrstuvwx",
  "git.example", "/api/packages/acme", "an audit trail", "the review", "a code review", "review 12 files", "round 1", "a round of 3", "rounds 2",
  "Q and A", "FAQ", "c114", "section 7",
  '"--token-file"', '"--enroll-token-stdin"', '"--key-out"', "'--token-env'", "pass --token on the command line", "`--key value`", '"--keyboard"', '"--monkey"',
  'long = "token-file"', 'flag.String("key-file", "", "")', 'm.String("key")', '"token"',
  // Next to a secret's shape: a placeholder where the value would be, and values that are no credential.
  "token=<R>", "Authorization: Bearer ${TOKEN}", "Authorization: Bearer $TOKEN", "authorization: basic <redacted>", "password <redacted>", "sk-<V len=48>",
  "x-api-key: ${KEY}", "api_key = [redacted]", "secret: ***", "password=REDACTED", "token: xxx", "https://user:${PASSWORD}@example.invalid/", "https://example.invalid:8443/path@x",
  "da39a3ee5e6b4b0d3255bfef95601890afd80709", "123e4567-e89b-12d3-a456-426614174000", "aGVsbG8gd29ybGQsIHRoaXMgaXMgcGxhaW4gdGV4dA==",
  "-----BEGIN PUBLIC KEY-----", "-----BEGIN CERTIFICATE-----", "a public key", "token = short", "sk-short", "the password is long enough", "key: value",
  // The name of a key's format, a placeholder where a URL's pass phrase would be, an option that takes a public key.
  j("a mini", "sign sec", "ret key file"), j("https://someone:", "pa", "ss@example.invalid/"), j("https://USER:", "PASS", "WORD@example.invalid/"), j('"--public-', 'key"'), j('long = "public-', 'key"'),
];

const CLASS_IDS = new Set(CLASSES.map((c) => c.id));
export const FIRST_PARTY = "first-party";
export const ASSEMBLED = "assembled";
const FIRST_PARTY_FILE = "ci/general-use/first-party.txt";

const matches = (cls, line, binary = false, path = undefined) => cls.patterns.some((p) => !(binary && p.prose) && p.test(line, path));

/**
 * The ids of the deny classes a line (or a path) matches. `source` says the line is from a
 * non-test file: only there do the source-only classes apply. Paths, commit messages and
 * test files are checked against every other class. `binary` says the line is from a file
 * that holds a NUL byte: the prose patterns are not applied to it. `path` is the tracked file
 * the line is in: the few rules that read a line by the kind of its file apply only with it.
 */
export function classesOf(line, classes = CLASSES, { source = true, binary = false, path = undefined } = {}) {
  return classes.filter((c) => (source || !c.sourceOnly) && matches(c, line, binary, path)).map((c) => c.id);
}

// A denied name put together from pieces: `["ab", "cd"].join("")`, `"ab" + "cd"`. The file
// then holds no literal for the classes above to find, and says the name all the same. The
// check is on one line, and only on what the line itself joins: two string literals with a
// plus between them, and the string literals of a list that is joined with nothing between
// its items (the forms below). Those seams are closed up and the line is read again: a name
// that is there only after closing up is a hit of the class `assembled`. Strings that only
// stand next to each other (the items of a list, the arguments of a call) are not joined,
// and are not closed up. Only names are looked for: the classes that are neither an
// option's nor a secret's shape, and in them only the patterns that mean something outside
// prose. Only the gate's five shared files are not checked: their patterns and samples are
// written that way on purpose.
const PLUS_SEAM = /["'`]\s*\+\s*["'`]/g;
const COMMA_SEAM = /["'`]\s*,\s*["'`]/g;
const JOINED_LISTS = [
  /\[([^[\]]*)\]\s*\.(?:join\(\s*(?:""|''|``)\s*\)|concat\(\s*\))/g, // [..].join("") and [..].concat()
  /(?:""|'')\s*\.join\(\s*[[(]([^[\]()]*)[\])]\s*\)/g, // "".join([..]) and "".join((..))
  /\bconcat!\(([^()]*)\)/g, // concat!(..)
  /\{([^{}]*)\}\s*,\s*""\s*\)/g, // Join([]string{..}, "")
];
const NAME_CLASSES = CLASSES.filter((c) => !c.sourceOnly && c.id !== "secret-shape");
export function assembles(line) {
  let closed = line.replace(PLUS_SEAM, "");
  for (const list of JOINED_LISTS) closed = closed.replace(list, (whole, items) => whole.replace(items, () => items.replace(COMMA_SEAM, "")));
  if (closed === line) return false;
  const already = classesOf(line, NAME_CLASSES, { binary: true });
  return classesOf(closed, NAME_CLASSES, { binary: true }).some((id) => !already.includes(id));
}
// The files `assembled` does not read: the gate's five shared files (SHARED in verify-dir.mjs),
// by their exact paths. Any other file under ci/general-use/, the repository's own lists
// included, is read like every other file.
export const ASSEMBLED_EXEMPT = Object.freeze([
  "ci/general-use/README.md", "ci/general-use/gate.mjs", "ci/general-use/scan.mjs",
  "ci/general-use/scan.test.mjs", "ci/general-use/verify-dir.mjs",
]);

/** [{ line, cls }] for a text: one row per line and class, 1-based line numbers. */
export function scanText(text, classes = CLASSES, { source = true, path = undefined } = {}) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) for (const cls of classesOf(lines[i], classes, { source, path })) out.push({ line: i + 1, cls });
  return out;
}

export const lineHash = (line) => createHash("sha256").update(line.trim(), "utf8").digest("hex");

// ---------------------------------------------------------------------------------------
// allow.txt: path<TAB>class<TAB>sha256(stripped line)<TAB>reason
// ---------------------------------------------------------------------------------------

/** Parses allow.txt. Returns { entries, errors }; any error fails the run. */
export function parseAllow(text, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  text.split("\n").forEach((raw, i) => {
    const n = i + 1;
    if (raw.trim() === "" || raw.startsWith("#")) return;
    const f = raw.split("\t");
    if (f.length !== 4) return errors.push(`allow.txt:${n} needs 4 tab-separated fields (path, class, sha256, reason)`);
    const [path, cls, hash, reason] = f;
    if (/[*?[\]{}]/.test(path)) return errors.push(`allow.txt:${n} the path holds a wildcard: one entry allows one line of one file`);
    if (path.startsWith("/") || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
      return errors.push(`allow.txt:${n} the path must name one tracked file, relative to the repository root`);
    }
    if (!CLASS_IDS.has(cls) && cls !== FIRST_PARTY && cls !== ASSEMBLED) return errors.push(`allow.txt:${n} unknown class`);
    if (!/^[0-9a-f]{64}$/.test(hash)) return errors.push(`allow.txt:${n} the third field must be the sha256 of the stripped line (64 lower-case hex)`);
    if (reason.trim().length < 20) return errors.push(`allow.txt:${n} the reason must say why the line is general (20 characters or more)`);
    const exp = /^expires (\d{4}-\d{2}-\d{2}): /.exec(reason);
    if (/^expires\b/.test(reason) && !exp) return errors.push(`allow.txt:${n} an expiry is written "expires YYYY-MM-DD: reason"`);
    if (exp && exp[1] < today) return errors.push(`allow.txt:${n} the entry expired on ${exp[1]}`);
    const key = `${path}\t${cls}\t${hash}`;
    if (seen.has(key)) return errors.push(`allow.txt:${n} duplicate entry`);
    seen.add(key);
    entries.push({ n, path, cls, hash, key });
  });
  return { entries, errors };
}

// ---------------------------------------------------------------------------------------
// first-party.txt: `name<TAB><text>` and `file<TAB><path>` (a path ending in / is a directory)
// ---------------------------------------------------------------------------------------

// Tests and fixtures may name anything they exercise; the first-party check is for the rest.
// A test directory is one of the names below with no `src` directory above it: a package's
// own tests (`tests/`, `crates/a/tests/`, `packages/p/test/`) are exempt, a directory of that
// name inside a source tree (`src/test/`, `crates/a/src/tests/`) is not. A test file is known
// by its name anywhere.
const TEST_DIR = /^(tests?|testdata|fixtures?|__tests__)$/;
const TEST_FILE = /_test\.go$|\.test\.(c|m)?(js|ts)$|(^|\/)tests\.rs$/;
export function isTestPath(p) {
  for (const dir of p.split("/").slice(0, -1)) {
    if (dir === "src") break;
    if (TEST_DIR.test(dir)) return true;
  }
  return TEST_FILE.test(p);
}

export function parseFirstParty(text) {
  const names = [];
  const files = [];
  const errors = [];
  text.split("\n").forEach((raw, i) => {
    const n = i + 1;
    if (raw.trim() === "" || raw.startsWith("#")) return;
    const f = raw.split("\t");
    if (f.length !== 2 || (f[0] !== "name" && f[0] !== "file") || f[1].trim() !== f[1] || f[1] === "") {
      return errors.push(`first-party.txt:${n} a line is name<TAB>text or file<TAB>path`);
    }
    if (f[0] === "name") {
      if (f[1].length < 4) return errors.push(`first-party.txt:${n} a name is 4 characters or more`);
      names.push({ n, text: f[1] });
    } else {
      if (/[*?[\]{}]/.test(f[1]) || f[1].startsWith("/") || f[1].split("/").some((s) => s === "." || s === "..")) {
        return errors.push(`first-party.txt:${n} a file entry is one path (or one directory ending in /), with no wildcard`);
      }
      files.push({ n, path: f[1] });
    }
  });
  if (names.length && !files.length) errors.push("first-party.txt names first-party entries but declares no file for them");
  return { names, files, errors };
}

const declaredIn = (fp, path) => fp.files.find((f) => (f.path.endsWith("/") ? path.startsWith(f.path) : path === f.path));

// ---------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------

export class ScanError extends Error {}

/** Runs git and returns its output. Any failure (a non-zero status, no git) throws ScanError. */
export function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const why = String(err.stderr || err.message || "").trim().split("\n")[0];
    throw new ScanError(`git ${args[0]} failed (status ${err.status ?? "none"}): ${why}`);
  }
}

export function trackedFiles(root) {
  const out = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  if (out.length === 0) throw new ScanError("git ls-files listed no file: nothing was scanned");
  return out;
}

function readTracked(root, rel, name = rel) {
  const abs = join(root, rel);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return Buffer.from(readlinkSync(abs), "utf8");
    if (st.isDirectory()) return null; // a submodule entry: its path is still scanned
    return readFileSync(abs);
  } catch (err) {
    throw new ScanError(`cannot read ${name}: ${err.code || "error"}`);
  }
}

/**
 * The text of a file that starts with a UTF-16 byte-order mark, decoded; null when the file
 * has no such mark. A trailing odd byte is dropped.
 */
export function utf16Text(buf) {
  const little = buf[0] === 0xff && buf[1] === 0xfe;
  const big = buf[0] === 0xfe && buf[1] === 0xff;
  if (!little && !big) return null;
  const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
  if (big) body.swap16();
  return body.toString("utf16le");
}

// One NUL-terminated record per commit (-z): its hash, a newline, then the message. A
// message can hold any byte but NUL, so no other separator can cut one short.
function logMessages(root, range) {
  const raw = git(root, ["log", "-z", "--format=%H%n%B", range]);
  return raw.split("\0").filter((s) => s !== "").map((s) => {
    const nl = s.indexOf("\n");
    const id = nl === -1 ? s : s.slice(0, nl);
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new ScanError("git log printed a record with no commit id");
    return { id: id.slice(0, 12), text: nl === -1 ? "" : s.slice(nl + 1) };
  });
}

/**
 * Commit messages of base..HEAD, where the range starts at the merge base of `base` and HEAD.
 * Returns [{ id, text }]. A base that git cannot resolve is an error, never an empty range.
 */
export function commitMessages(root, base) {
  if (/^-/.test(base) || /\s/.test(base) || base === "") throw new ScanError("the base must be a ref or a commit id");
  const mb = git(root, ["merge-base", base, "HEAD"]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(mb)) throw new ScanError("git merge-base printed no commit id");
  return logMessages(root, `${mb}..HEAD`);
}

/**
 * Commit messages a push adds at its head: those since the head's first parent (one commit
 * for a squash, every merged commit for a merge), or the head's own when it is a root commit
 * and has no parent to start from.
 */
export function headCommitMessages(root) {
  const ids = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ");
  const all = ids.length === 1 ? logMessages(root, "HEAD") : commitMessages(root, "HEAD^");
  // git lists the head first. Its subject is the one line a forge writes itself.
  return all.map((c, i) => (i === 0 ? { ...c, text: withoutSquashSuffix(c.text) } : c));
}

// A forge that squashes a pull request appends the pull request's number to the subject, in
// parentheses, and one more for each squash of a squash. Exactly that is taken off: a chain
// of them at the very end of the first line. A number anywhere else is scanned as usual.
const SQUASH_SUFFIX = / \(#[0-9]+\)$/;

/** A commit message without the number a squash appended to its subject. */
export function withoutSquashSuffix(text) {
  const nl = text.indexOf("\n");
  const subject = nl === -1 ? text : text.slice(0, nl);
  return subject.replace(SQUASH_SUFFIX, "") + (nl === -1 ? "" : text.slice(nl));
}

/**
 * Scans a repository. Options:
 *   root          the repository root
 *   allowText     the text of allow.txt ("" for none)
 *   firstPartyText the text of first-party.txt ("" for none)
 *   extraFiles    more files to scan, relative to root (what a package ships beyond the tracked tree)
 *   base          a ref or commit id: also scan the commit messages since its merge base with HEAD
 *   headCommit    true: also scan the commit messages the head adds to its first parent
 *   foreignLists  true: the lists are not this tree's own (another branch's): an entry that
 *                 matches nothing here is not reported as stale
 *   today         YYYY-MM-DD, for allow-list expiry
 * Returns { hits, refused, binary, utf16, files, commits }: `hits` are unallowed, as { where, cls };
 * `refused` are allow-list and first-party-list problems (bad, expired or stale entries).
 * The run is clean only when both are empty. Throws ScanError when the scan cannot be done.
 */
export function scanRepo({ root, allowText = "", firstPartyText = "", extraFiles = [], base = null, headCommit = false, foreignLists = false, today, classes = CLASSES } = {}) {
  const allow = parseAllow(allowText, { today });
  const fp = parseFirstParty(firstPartyText);
  const refused = [...allow.errors, ...fp.errors];
  const allowed = new Map(allow.entries.map((e) => [e.key, e]));
  const used = new Set();
  const hits = [];
  const binary = [];
  const utf16 = [];
  const fpFileUsed = new Set();
  const fpNameUsed = new Set();
  const tracked = trackedFiles(root);
  const files = [...new Set([...tracked, ...extraFiles])].sort();
  // A path whose own name has a secret's shape is never printed: not for that hit, not as the
  // place of another hit in the file, not in a note and not in an error. What stands for it
  // says where to find it, to someone who has the tree: its number in the list of tracked files.
  const position = new Map(tracked.map((path, i) => [path, i + 1]));
  const standIn = (path) => {
    if (shapesOf(path).length === 0) return null;
    return `(a path whose name has a secret's shape: ${position.has(path) ? `number ${position.get(path)} in git ls-files` : "given to the scan, not in git ls-files"})`;
  };

  const report = (path, lineNo, cls, lineText) => {
    const key = `${path}\t${cls}\t${lineHash(lineText)}`;
    if (allowed.has(key)) return used.add(key);
    const shown = standIn(path);
    hits.push({ where: `${shown ?? path}:${lineNo}`, cls, path, shown, key, line: lineNo, hash: lineHash(lineText) });
  };

  for (const rel of files) {
    for (const cls of classesOf(rel, classes, { source: false })) report(rel, 0, cls, rel);
    const name = standIn(rel) ?? rel;
    const buf = readTracked(root, rel, name);
    if (buf === null) continue;
    // A file with a NUL byte is read byte for byte and scanned for every name; only the
    // short prose patterns are left out. It is never skipped.
    const isBinary = buf.includes(0);
    // A file that starts with a UTF-16 byte-order mark is scanned twice: as the text the mark
    // promises, with every pattern, and as its bytes like any other file. The second view is
    // what keeps the mark from hiding plain text behind a wrong decoding.
    const wide = utf16Text(buf);
    const views = [];
    if (wide !== null) {
      utf16.push(name);
      views.push({ lines: wide.split("\n"), binary: false });
    } else if (isBinary) binary.push(name);
    views.push({ lines: buf.toString(isBinary ? "latin1" : "utf8").split("\n"), binary: isBinary });
    const declared = declaredIn(fp, rel);
    const source = !isTestPath(rel);
    const checkFirstParty = fp.names.length > 0 && source && rel !== FIRST_PARTY_FILE;
    const reported = new Set();
    const once = (lineNo, cls, line) => {
      const id = `${lineNo}\t${cls}`;
      if (reported.has(id)) return;
      reported.add(id);
      report(rel, lineNo, cls, line);
    };
    for (const view of views) {
      for (let i = 0; i < view.lines.length; i++) {
        const line = view.lines[i];
        for (const cls of classesOf(line, classes, { source, binary: view.binary, path: rel })) once(i + 1, cls, line);
        if (!view.binary && !ASSEMBLED_EXEMPT.includes(rel) && assembles(line)) once(i + 1, ASSEMBLED, line);
        if (!checkFirstParty) continue;
        const named = fp.names.filter((nm) => line.includes(nm.text));
        if (named.length === 0) continue;
        for (const nm of named) fpNameUsed.add(nm.n);
        if (declared) fpFileUsed.add(declared.n);
        else once(i + 1, FIRST_PARTY, line);
      }
    }
  }

  // The lists cannot rot: an entry that no longer matches anything fails the run. That is
  // asked of a tree's own lists only: another branch's lists describe that branch's tree.
  for (const e of allow.entries) if (!foreignLists && !used.has(e.key)) refused.push(`allow.txt:${e.n} stale: no line of that file has that class and hash any more`);
  if (fp.errors.length === 0 && !foreignLists) {
    for (const f of fp.files) if (!fpFileUsed.has(f.n)) refused.push(`first-party.txt:${f.n} stale: that file names no first-party entry`);
    for (const nm of fp.names) if (!fpNameUsed.has(nm.n)) refused.push(`first-party.txt:${nm.n} stale: that name appears in no non-test file`);
  }

  let commits = null;
  if (base !== null || headCommit) {
    commits = base !== null ? commitMessages(root, base) : headCommitMessages(root);
    for (const c of commits) for (const h of scanText(c.text, classes, { source: false })) hits.push({ where: `commit ${c.id}:${h.line}`, cls: h.cls, path: null, key: null });
  }
  return { hits, refused, binary, utf16, files: files.length, commits: commits === null ? null : commits.length };
}

// ---------------------------------------------------------------------------------------
// Self-test: the rule set checks itself, with no repository and no file but this one.
// ---------------------------------------------------------------------------------------

export function selfTest(classes = CLASSES) {
  const errors = [];
  const ids = classes.map((c) => c.id);
  if (new Set(ids).size !== ids.length) errors.push("two classes share an id");
  // Positive controls: every sample is caught by its own class.
  for (const c of classes) {
    if (!c.samples || c.samples.length === 0) errors.push(`class ${c.id} has no sample`);
    for (let i = 0; i < (c.samples || []).length; i++) if (!matches(c, c.samples[i])) errors.push(`class ${c.id}: sample ${i + 1} is not caught`);
    // No dead pattern: each one catches a sample of its class.
    c.patterns.forEach((p, i) => {
      if (!(c.samples || []).some((x) => p.test(x))) errors.push(`class ${c.id}: pattern ${i + 1} catches no sample`);
    });
  }
  // Every required name is caught, and no class is dead weight: without it a required name passes.
  for (let i = 0; i < REQUIRED.length; i++) if (classesOf(REQUIRED[i], classes).length === 0) errors.push(`required name ${i + 1} is caught by no class`);
  for (const c of classes) {
    const rest = classes.filter((x) => x !== c);
    if (!REQUIRED.some((t) => classesOf(t, rest).length === 0)) errors.push(`class ${c.id} could be deleted with every required name still caught`);
  }
  // Negative controls: generic text is clean.
  for (let i = 0; i < NEGATIVE.length; i++) {
    const got = classesOf(NEGATIVE[i], classes);
    if (got.length) errors.push(`negative sample ${i + 1} is caught as [${got.join(", ")}]`);
  }
  // This file matches none of its own rules.
  const own = scanText(readFileSync(fileURLToPath(import.meta.url), "utf8"), classes);
  for (const h of own) errors.push(`the scanner's own line ${h.line} matches [${h.cls}]`);
  // The allow-list parser refuses what it must.
  const h = "0".repeat(64);
  const reason = "a reason that is long enough";
  const bad = [
    `src/*.js\tvocabulary\t${h}\t${reason}`, `src/\tvocabulary\t${h}\t${reason}`, `../x\tvocabulary\t${h}\t${reason}`, `a.js\tnot-a-class\t${h}\t${reason}`,
    `a.js\tvocabulary\tabc\t${reason}`, `a.js\tvocabulary\t${h}\tshort`, `a.js\tvocabulary\t${h}`, `a.js\tvocabulary\t${h}\texpires 2000-01-01: ${reason}`,
    `a.js\tvocabulary\t${h}\t${reason}\na.js\tvocabulary\t${h}\t${reason}`,
  ];
  bad.forEach((t, i) => {
    if (parseAllow(t, { today: "2020-01-01" }).errors.length === 0) errors.push(`allow-list control ${i + 1} was accepted`);
  });
  const good = parseAllow(`a.js\tvocabulary\t${h}\texpires 2999-01-01: ${reason}\n# note\n`, { today: "2020-01-01" });
  if (good.errors.length || good.entries.length !== 1) errors.push("a well-formed allow-list entry was refused");
  return errors;
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------

const USAGE = `usage: node ci/general-use/scan.mjs [--self-test] [--root <dir>] (--base <ref|commit> | --head-commit | --tree-only)
                                    [--lists <dir>] [--commit-messages block|warn] [--hashes]
  --self-test    check the rule set against its own samples, then exit
  --base         also scan the commit messages since the merge base of <ref> and HEAD
  --head-commit  also scan the commit messages the head adds to its first parent (a push)
  --tree-only    scan the tracked tree only
  --lists        read allow.txt and first-party.txt from <dir>, not from the tree's own
                 ci/general-use (the pull-request step gives the base branch's); an entry of
                 such lists that matches nothing in this tree is not reported as stale
  --hashes       print each hit's allow.txt columns (path, class, sha256 of the stripped line);
                 a local aid, refused where a CI variable is set
`;

// Text from outside (a path, an argument, a message of git) is printed on one line: control
// characters and the Unicode line separators are written as escapes, so a file name cannot
// start a line of its own in a log.
const printable = (text) => String(text).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, (c) => {
  const n = c.codePointAt(0);
  return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u{${n.toString(16)}}`;
});
// A hit's line starts with the path. A CI runner reads a line that starts with `::` or
// `##[` (spaces before it or not) as a command to itself: the first of those characters is
// written as an escape, so no path is one.
const atLineStart = (text) => printable(text).replace(/^(\s*)(::|##\[)/, (_, spaces, lead) => `${spaces}\\x${lead.charCodeAt(0).toString(16)}${lead.slice(1)}`);
// The allow.txt columns of a hit. For a path that is stood in for there is no hash: the hash of
// its line 0 is the hash of the path itself, and an entry could not name the file anyway.
const placeOf = (h) => (h.path === null ? h.where : `${h.shown ?? atLineStart(h.path)}:${h.line}`);

// Where one of these is set, the run is a CI job and its output is a log others can read.
export const CI_VARIABLES = ["CI", "GITHUB_ACTIONS", "FORGEJO_ACTIONS", "GITEA_ACTIONS"];

function parseArgs(argv) {
  const o = { selfTest: false, root: null, base: null, treeOnly: false, headCommit: false, lists: null, commitMode: "block", hashes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new ScanError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--self-test") o.selfTest = true;
    else if (a === "--root") o.root = value();
    else if (a === "--base") o.base = value();
    else if (a === "--lists") o.lists = value();
    else if (a === "--tree-only") o.treeOnly = true;
    else if (a === "--head-commit") o.headCommit = true;
    else if (a === "--hashes") o.hashes = true;
    else if (a === "--commit-messages") {
      o.commitMode = value();
      if (o.commitMode !== "block" && o.commitMode !== "warn") throw new ScanError("--commit-messages takes block or warn");
    } else throw new ScanError(`unknown argument ${JSON.stringify(a)}`);
  }
  const scopes = [o.base !== null, o.headCommit, o.treeOnly].filter(Boolean).length;
  if (!o.selfTest && scopes !== 1) throw new ScanError("say which scope, once: --base <ref|commit>, --head-commit or --tree-only");
  return o;
}

export function main(argv, out = process.stdout, err = process.stderr, env = process.env) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err.write(`general-use: ${printable(e.message)}\n${USAGE}`);
    return 2;
  }
  // A line's hash in a public log lets a reader test guesses of the line against it.
  if (o.hashes && CI_VARIABLES.some((name) => env[name])) {
    err.write("general-use: --hashes is a local aid: it is refused where a CI variable is set\n");
    return 2;
  }
  if (o.selfTest) {
    const errors = selfTest();
    for (const e of errors) err.write(`general-use self-test: ${e}\n`);
    out.write(`general-use self-test: ${CLASSES.length} classes, ${REQUIRED.length} required names, ${NEGATIVE.length} negative samples: ${errors.length ? "FAILED" : "ok"}\n`);
    return errors.length ? 1 : 0;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(o.root ?? join(here, "..", ".."));
  const cfg = o.lists === null ? join(root, "ci", "general-use") : resolve(o.lists);
  try {
    const read = (name) => {
      const p = join(cfg, name);
      if (!existsSync(p)) throw new ScanError(`${o.lists === null ? "ci/general-use/" : "the --lists directory's "}${name} is missing (an empty file means "no entry")`);
      return readFileSync(p, "utf8");
    };
    const r = scanRepo({ root, allowText: read("allow.txt"), firstPartyText: read("first-party.txt"), base: o.base, headCommit: o.headCommit, foreignLists: o.lists !== null });
    const fromCommit = (h) => h.path === null;
    const blocking = r.hits.filter((h) => !(fromCommit(h) && o.commitMode === "warn"));
    const warned = r.hits.filter((h) => fromCommit(h) && o.commitMode === "warn");
    for (const h of blocking) out.write(o.hashes && h.key ? `${placeOf(h)} [${h.cls}] ${h.shown ?? printable(h.path)}\t${h.cls}\t${h.shown ? "-" : h.hash}\n` : `${placeOf(h)} [${h.cls}]\n`);
    for (const h of warned) out.write(`warning: ${placeOf(h)} [${h.cls}]\n`);
    for (const m of r.refused) out.write(`${m}\n`);
    for (const b of r.binary) out.write(`note: ${printable(b)} holds a NUL byte: scanned as bytes, without the short prose patterns\n`);
    for (const u of r.utf16) out.write(`note: ${printable(u)} starts with a UTF-16 byte-order mark: scanned as that text, and as bytes\n`);
    const byClass = {};
    for (const h of blocking) byClass[h.cls] = (byClass[h.cls] || 0) + 1;
    const counts = Object.entries(byClass).sort().map(([k, v]) => `${k} ${v}`).join(", ");
    const scope = r.commits === null ? `${r.files} files` : `${r.files} files, ${r.commits} commit messages`;
    const bad = blocking.length + r.refused.length;
    out.write(`general-use: ${scope}: ${bad ? `NOT CLEAN: ${blocking.length} hits${counts ? ` (${counts})` : ""}, ${r.refused.length} list problems` : "clean"}\n`);
    return bad ? 1 : 0;
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    err.write(`general-use: the scan could not be completed: ${printable(e.message)}\n`);
    return 2;
  }
}

// Run only when started as a program, not when imported (the tests import it). Both sides
// are real paths: node gives the main module its real path, so comparing with a resolved
// argv[1] would make a start through a symlink run nothing and exit 0.
function startedAsProgram() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // The program's path is gone or cannot be resolved: whether this is a start or an import
    // cannot be told, so nothing runs and the status says so. The text is fixed.
    process.stderr.write("general-use: the program path could not be resolved; the scan did not run\n");
    process.exitCode = 2;
    return false;
  }
}

if (startedAsProgram()) {
  let code = 2;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    // The name only: an unexpected error's message could quote a scanned line.
    process.stderr.write(`general-use: internal error (${(e && e.name) || "unknown"}); the scan did not complete\n`);
    code = 2;
  }
  process.exitCode = code;
}
