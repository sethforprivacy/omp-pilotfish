#!/usr/bin/env node
// packet.mjs — Assemble the pilotfish context packet (focus + claim + summary + state stamp +
// changed files + diff). Deterministic context capture so every worker/verifier sees the SAME scope,
// and so the orchestrator can tell two packets apart ("never reverify identical state").
//
// Usage:
//   packet.mjs --focus <text> [--claim <text>] [--summary <text>] [options]
//   packet.mjs --focus <text> [--files a,b,c]        # explicit changed-file list (no VCS needed)
//
// Options:
//   --focus <text>     Focus for this slice (required). What is being done / what success means.
//   --claim <text>     Exact claim handed to the verifier ("done means X", acceptance conditions).
//   --summary <text>   Session/slice summary written by the orchestrator.
//   --focus-file / --claim-file / --summary-file <path>
//                      Read the value from a file (safest for multi-line text). Stray unquoted
//                      tokens after a text option are re-joined onto it rather than rejected.
//   --files <a,b,c>    Explicit changed-file paths (absolute) instead of VCS diff.
//   --no-untracked     Do not embed untracked files (list them only).
//   --limit <bytes>    Max diff bytes (default 100000).
//   --embed-limit <b>  Max bytes embedded per untracked/explicit file (default 20000).
//   --out <path|dir>   Write markdown packet to <path>. If <path> is an existing directory, the
//                      packet is written there as pilotfish-packet-<rev8>-<NN>.md (NN = next free
//                      sequence number). Default: stdout.
//   --json             Also write machine-readable metadata to <out>.json (or stdout when no --out).
//
// Secret hygiene: untracked/explicit files whose name looks like a credential store (.env*, *.pem,
// *.key, *token*, *secret*, *credential*, id_rsa*, *.p12, *.pfx, *.kdbx, ...) are NEVER embedded, and
// neither are earlier pilotfish-packet-*.md files (they carry diffs and would re-embed themselves) —
// they are listed with an `[not embedded: secret-like name]` tag. Binary files are skipped too.
// Everything that IS embedded is listed on stderr so the orchestrator sees what left the machine.
//
// Exit 0 on success. Any error exits 1 with a message on stderr.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const TEXT_OPTS = { "--focus": "focus", "--claim": "claim", "--summary": "summary" };

function parseArgs(argv) {
  const args = { files: [], limit: 100000, embedLimit: 20000, untracked: true };
  let lastText = null; // text option that stray (unquoted multi-line) tokens are appended to
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${a}`);
      return argv[++i];
    };
    const positiveInt = (flag) => {
      const n = Number.parseInt(next(), 10);
      if (!Number.isFinite(n) || n <= 0) fail(`${flag} must be a positive integer`);
      return n;
    };
    if (a in TEXT_OPTS) { lastText = TEXT_OPTS[a]; args[lastText] = next(); continue; }
    if (/^--(focus|claim|summary)-file$/.test(a)) {
      const key = a.slice(2, -5);
      const path = resolve(next());
      if (!existsSync(path)) fail(`${a}: file not found: ${path}`);
      args[key] = readFileSync(path, "utf8");
      lastText = null;
      continue;
    }
    if (!a.startsWith("--") && lastText) {
      // Orchestrators routinely pass an unquoted multi-line summary; the shell splits it into
      // stray tokens. Re-join them onto the last text option instead of failing the packet.
      args[lastText] += (args[lastText].endsWith("\n") ? "" : "\n") + a;
      continue;
    }
    if (a === "--files") args.files = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--no-untracked") args.untracked = false;
    else if (a === "--limit") args.limit = positiveInt(a);
    else if (a === "--embed-limit") args.embedLimit = positiveInt(a);
    else if (a === "--out") args.out = next();
    else if (a === "--json") args.json = true;
    else fail(`unknown argument: ${a}`);
  }
  return args;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    fail(`${cmd} ${args.join(" ")} failed: ${(e.stderr || e.message || "").toString().slice(0, 400)}`);
  }
}

/** Non-fatal runner for probes (VCS detection, state stamp). Returns null on failure. */
function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function truncate(text, limit) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (!limit || bytes <= limit) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, limit).toString("utf8"), truncated: true };
}

// Names that look like credential stores. Matched against the basename, case-insensitively.
const SECRET_NAME_RE =
  /(^pilotfish-packet|(^|\.)env(\.|$)|\.(pem|key|p12|pfx|jks|kdbx|keystore|asc|gpg)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|secret|credential|token|password|passwd|\.netrc$|\.npmrc$|\.pypirc$|kubeconfig|\.htpasswd$|service[-_]?account.*\.json$)/i;

function isSecretLikeName(path) {
  return SECRET_NAME_RE.test(basename(path));
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Read a file for embedding, applying the secret/binary/size policy. Returns an embed record. */
function embedFile(abs, limit) {
  if (isSecretLikeName(abs)) return { path: abs, text: null, skipped: "secret-like name" };
  const buf = readFileSync(abs);
  if (isBinary(buf)) return { path: abs, text: null, skipped: "binary" };
  const { text, truncated } = truncate(buf.toString("utf8"), limit);
  return { path: abs, text, truncated };
}

function detectVcs() {
  const git = tryRun("git", ["rev-parse", "--is-inside-work-tree"]);
  if (git?.trim() === "true") return "git";
  if (tryRun("jj", ["root"])) return "jj";
  return null;
}

function gitMode(args) {
  // porcelain v1 -z raw bytes: an entry is "<XY> <path>" (renames/copies emit a
  // second bare token with the ORIGINAL path). Paths are raw (no quoting).
  const tokens = run("git", ["status", "--porcelain", "-z"]).split("\0").filter(Boolean);
  const rows = [];
  const untracked = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i++];
    const code = t.slice(0, 2);
    const path = t.slice(3); // skip "<XY> "
    if (code[0] === "R" || code[0] === "C") {
      const orig = tokens[i++] ?? path;
      rows.push({ status: code, path, orig });
    } else {
      rows.push({ status: code, path });
    }
    if (code === "??") untracked.push(rows[rows.length - 1].path);
  }
  const tracked = rows.filter((r) => r.status !== "??").map((r) => r.path);
  // Collect staged + unstaged against HEAD; fall back for unborn HEAD (no commits yet).
  let diff = tracked.length ? tryRun("git", ["diff", "HEAD", "--", ...tracked]) : "";
  if (tracked.length && diff === null) {
    const cached = tryRun("git", ["diff", "--cached", "--", ...tracked]) ?? "";
    const worktree = tryRun("git", ["diff", "--", ...tracked]) ?? "";
    diff = cached + worktree;
  }
  const embeds = [];
  for (const p of untracked) {
    const abs = resolve(p);
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      const listing = tryRun("git", ["ls-files", "--others", "--exclude-standard", abs])?.trim() ?? "";
      embeds.push({ path: abs, text: args.untracked ? listing : null, skipped: args.untracked ? undefined : "--no-untracked", truncated: false });
      continue;
    }
    embeds.push(args.untracked ? embedFile(abs, args.embedLimit) : { path: abs, text: null, skipped: "--no-untracked" });
  }
  const state = {
    rev: tryRun("git", ["rev-parse", "HEAD"])?.trim() ?? "(unborn)",
    branch: tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? "(none)",
    root: tryRun("git", ["rev-parse", "--show-toplevel"])?.trim() ?? process.cwd(),
  };
  return { vcs: "git", files: rows, diff: diff ?? "", untracked, embeds, state };
}

function jjMode(args) {
  const files = run("jj", ["status"]).trim();
  const rows = (files.match(/^[MADR!]\s+.*$/gm) ?? []).map((l) => {
    const [st, ...rest] = l.trim().split(/\s+/);
    return { status: st, path: rest.join(" ") };
  });
  const diff = run("jj", ["diff", "--git"]).trim();
  const state = {
    rev: tryRun("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"])?.trim() ?? "(unknown)",
    branch: tryRun("jj", ["log", "-r", "@", "--no-graph", "-T", "bookmarks"])?.trim() || "(none)",
    root: tryRun("jj", ["root"])?.trim() ?? process.cwd(),
  };
  return { vcs: "jj", files: rows, diff, untracked: [], embeds: [], state };
}

function filesMode(paths, args) {
  const rows = [];
  const embeds = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) fail(`file not found: ${abs}`);
    const st = statSync(abs);
    rows.push({ status: st.isDirectory() ? "dir" : "file", path: abs });
    if (st.isDirectory()) continue;
    embeds.push(embedFile(abs, args.embedLimit));
  }
  const state = { rev: "(no vcs)", branch: "(none)", root: process.cwd() };
  return { vcs: "files", files: rows, diff: "", untracked: [], embeds, state };
}

const args = parseArgs(process.argv.slice(2));
if (!args.focus) fail("--focus <text> is required");

const vcs = args.files.length > 0 ? "files" : detectVcs();
let info;
if (vcs === "files") info = filesMode(args.files, args);
else if (vcs === "git") info = gitMode(args);
else if (vcs === "jj") info = jjMode(args);
else fail("no VCS detected and --files not given; pass --files <paths> or run from a git/jj repo");

// State stamp: what tree this packet describes, and a fingerprint of the exact diff + embeds so
// two packets for the same working state hash identically (the orchestrator can refuse to reverify).
const fingerprintInput = [info.diff, ...info.embeds.map((e) => `${e.path}\n${e.text ?? ""}`)].join("\n\x00\n");
const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
const generatedAt = new Date().toISOString();
const rev8 = info.state.rev.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8) || "norev";

const md = ["# Pilotfish context packet", ""];
md.push(`## Focus`, "", args.focus.trim(), "");
if (args.claim) md.push("", "## Claim / acceptance", "", args.claim.trim());
if (args.summary) md.push("", "## Summary", "", args.summary.trim());
md.push(
  "",
  "## State",
  "",
  "| field | value |",
  "|-------|-------|",
  `| vcs | ${info.vcs} |`,
  `| root | \`${info.state.root}\` |`,
  `| rev | \`${info.state.rev}\` |`,
  `| branch | \`${info.state.branch}\` |`,
  `| generated | ${generatedAt} |`,
  `| fingerprint | \`${fingerprint.slice(0, 16)}\` (sha256 of diff + embedded files) |`,
  "",
  "Verify against THIS root and revision. If `git rev-parse HEAD` or `git status --porcelain` there",
  "disagrees with this packet, the tree moved: report INCONCLUSIVE with the mismatch.",
  "",
  "## Changed files",
  "",
  "| status | path |",
  "|--------|------|",
  ...(info.files.length
    ? info.files.map((f) => `| ${f.status} | \`${f.path}\` |`)
    : ["| - | (no changes detected) |"]),
  "",
);

const embedded = [];
const notEmbedded = [];
for (const e of info.embeds ?? []) {
  if (e.text === null || e.text === undefined) {
    notEmbedded.push(e);
    md.push(`## ${e.path}`, "", `> [not embedded: ${e.skipped}]`, "");
    continue;
  }
  embedded.push(e);
  const tag = e.truncated ? " (truncated)" : "";
  md.push(`## ${e.path}${tag}`, "", "```", e.text, "```", "");
}
if (info.diff) {
  const { text, truncated } = truncate(info.diff, args.limit);
  md.push(`## Diff${truncated ? " (truncated)" : ""}`, "", "```diff", text, "```");
} else if (!embedded.length) {
  md.push("> No tracked diff or embedded content; see changed-file list above.");
}

const packet = md.join("\n");

// Resolve --out: file path, or directory → sequenced packet name.
let outPath = null;
if (args.out) {
  const p = resolve(args.out);
  if (existsSync(p) && statSync(p).isDirectory()) {
    const prefix = `pilotfish-packet-${rev8}-`;
    const used = readdirSync(p)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
      .map((f) => Number.parseInt(f.slice(prefix.length, -3), 10))
      .filter(Number.isFinite);
    const seq = String((used.length ? Math.max(...used) : 0) + 1).padStart(2, "0");
    outPath = join(p, `${prefix}${seq}.md`);
  } else {
    outPath = p;
  }
}

const meta = {
  focus: args.focus,
  claim: args.claim ?? null,
  summary: args.summary ?? null,
  vcs: info.vcs,
  state: { ...info.state, generatedAt, fingerprint },
  files: info.files,
  embedded: embedded.map((e) => e.path),
  notEmbedded: notEmbedded.map((e) => ({ path: e.path, reason: e.skipped })),
  bytes: Buffer.byteLength(packet, "utf8"),
  out: outPath,
};

if (outPath) {
  writeFileSync(outPath, packet, "utf8");
  if (args.json) writeFileSync(outPath + ".json", JSON.stringify(meta, null, 2), "utf8");
} else if (args.json) {
  process.stdout.write(JSON.stringify({ packet, meta }, null, 2));
} else {
  process.stdout.write(packet);
}

console.error(
  `packet: ${info.files.length} changed file(s)${info.diff ? ", diff captured" : ""}, rev ${rev8}, fingerprint ${fingerprint.slice(0, 16)} → ${outPath ?? "stdout"}`,
);
for (const e of embedded) console.error(`packet: embedded ${e.path}${e.truncated ? " (truncated)" : ""}`);
for (const e of notEmbedded) console.error(`packet: NOT embedded ${e.path} [${e.skipped}]`);
