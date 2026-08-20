#!/usr/bin/env node
// packet.mjs — Assemble the pilotfish context packet (focus + claim + summary + changed files + diff).
// Deterministic context capture so every worker/verifier sees the SAME scope.
//
// Usage:
//   packet.mjs --focus <text> [--claim <text>] [--summary <text>] [options]
//   packet.mjs --focus <text> [--files a,b,c]        # explicit changed-file list (no VCS needed)
//
// Options:
//   --focus <text>    Focus for this slice (required). What is being done / what success means.
//   --claim <text>    Exact claim handed to the verifier ("done means X", acceptance conditions).
//   --summary <text>  Session/slice summary written by the orchestrator.
//   --files <a,b,c>   Explicit changed-file paths (absolute) instead of VCS diff.
//   --limit <bytes>   Max diff/embed bytes per section (default 100000).
//   --out <path>      Write markdown packet to <path> (default stdout).
//   --json            Also write machine-readable metadata to <path>.json (or stdout when no --out).
//
// Exit 0 on success. Any error exits 1 with a message on stderr.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { files: [], limit: 100000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--focus") args.focus = next();
    else if (a === "--claim") args.claim = next();
    else if (a === "--summary") args.summary = next();
    else if (a === "--files") args.files = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") {
      const n = Number.parseInt(next(), 10);
      if (!Number.isFinite(n) || n <= 0) fail("--limit must be a positive integer");
      args.limit = n;
    }
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

/** Non-fatal runner for probes (VCS detection). Returns null on failure instead of exiting. */
function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function truncate(text, limit) {
  if (!limit || text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function detectVcs() {
  const git = tryRun("git", ["rev-parse", "--is-inside-work-tree"]);
  if (git?.trim() === "true") return "git";
  if (tryRun("jj", ["root"])) return "jj";
  return null;
}

function gitMode(limit) {
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
      embeds.push({ path: abs, text: listing, truncated: false });
      continue;
    }
    const { text, truncated } = truncate(readFileSync(abs, "utf8"), limit);
    embeds.push({ path: abs, text, truncated });
  }
  return { vcs: "git", files: rows, diff: diff ?? "", untracked, embeds };
}

function jjMode(limit) {
  const files = run("jj", ["status"]).trim();
  const rows = (files.match(/^[MADR!]\s+.*$/gm) ?? []).map((l) => {
    const [st, ...rest] = l.trim().split(/\s+/);
    return { status: st, path: rest.join(" ") };
  });
  const diff = run("jj", ["diff", "--git"]).trim();
  return { vcs: "jj", files: rows, diff, untracked: [] };
}

function filesMode(paths, limit) {
  const rows = [];
  const embeds = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) fail(`file not found: ${abs}`);
    const st = statSync(abs);
    rows.push({ status: st.isDirectory() ? "dir" : "file", path: abs });
    if (st.isDirectory()) continue;
    const { text, truncated } = truncate(readFileSync(abs, "utf8"), limit);
    embeds.push({ path: abs, text, truncated });
  }
  return { vcs: "files", files: rows, diff: "", untracked: [], embeds };
}

const args = parseArgs(process.argv.slice(2));
if (!args.focus) fail("--focus <text> is required");

const vcs = args.files.length > 0 ? "files" : detectVcs();
let info;
if (vcs === "files") info = filesMode(args.files, args.limit);
else if (vcs === "git") info = gitMode(args.limit);
else if (vcs === "jj") info = jjMode(args.limit);
else fail("no VCS detected and --files not given; pass --files <paths> or run from a git/jj repo");

const md = ["# Pilotfish context packet", ""];
md.push(`## Focus`, "", args.focus.trim(), "");
if (args.claim) md.push("", "## Claim / acceptance", "", args.claim.trim());
if (args.summary) md.push("", "## Summary", "", args.summary.trim());
md.push(
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

if (info.embeds?.length) {
  for (const e of info.embeds) {
    const tag = e.truncated ? " (truncated)" : "";
    md.push(`## ${e.path}${tag}`, "", "```", e.text, "```", "");
  }
}
if (info.diff) {
  const { text, truncated } = truncate(info.diff, args.limit);
  md.push(`## Diff${truncated ? " (truncated)" : ""}`, "", "```diff", text, "```");
} else if (!info.embeds?.length) {
  md.push("> No tracked diff or untracked content; see changed-file list above.");
}

const packet = md.join("\n");
const outPath = args.out ? resolve(args.out) : null;
const meta = {
  focus: args.focus,
  claim: args.claim ?? null,
  summary: args.summary ?? null,
  vcs: info.vcs,
  files: info.files,
  bytes: packet.length,
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
  `packet: ${info.files.length} changed file(s)${info.diff ? ", diff captured" : ""} (${outPath ? basename(outPath) : "stdout"})`,
);
