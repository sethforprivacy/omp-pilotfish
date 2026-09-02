#!/usr/bin/env node
// lint-agents.mjs — dependency-free lint for the pilotfish agent files and presets.
//
//   node scripts/lint-agents.mjs   # exit 0 = clean, 1 = problems
//
// Agent files (plugins/pilotfish/agents/pf-*.md):
//   - frontmatter block present; `name:` equals the filename; `description:` and `model:` present
//   - every top-level scalar value is either quoted or free of ": " and " #" (OMP's parser is
//     lenient, strict YAML parsers are not — a quoted description keeps both happy)
//   - read-only roles (pf-scout, pf-verifier) do not list edit/write tools
//   - body mentions the yield envelope so workers return an object, not a string
// Presets (plugins/pilotfish/presets/*.yml):
//   - modelRoles.pf-worker and modelRoles.pf-strong present and look like `provider/model` selectors
//   - every key under task.agentModelOverrides (if present) names a shipped pf-* agent
//   - every value looks like a `provider/model` selector (optionally `:thinking`)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = join(repoRoot, "plugins", "pilotfish", "agents");
const presetsDir = join(repoRoot, "plugins", "pilotfish", "presets");
let failed = false;
const fail = (msg) => { failed = true; console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok: ${msg}`);

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : null;
}

const agentNames = new Set();
for (const file of readdirSync(agentsDir).filter((f) => /^pf-.*\.md$/.test(f)).sort()) {
  const path = join(agentsDir, file);
  const text = readFileSync(path, "utf8");
  const parsed = frontmatter(text);
  if (!parsed) { fail(`${file}: missing frontmatter block`); continue; }
  const { fm, body } = parsed;
  const expected = basename(file, ".md");
  agentNames.add(expected);

  const top = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):(.*)$/); // top-level key (no indentation)
    if (!m) continue;
    top[m[1]] = m[2].trim();
  }
  if (top.name !== expected) fail(`${file}: name: is ${JSON.stringify(top.name)}, expected ${expected}`);
  if (!top.description) fail(`${file}: description: missing`);
  if (!("model" in top)) fail(`${file}: model: missing`);
  const modelList = fm.match(/^model:\n((?:\s+-\s+.*\n?)+)/m);
  const models = modelList ? modelList[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").replace(/\s+#.*$/, "").replace(/^"|"$/g, "").trim()).filter(Boolean) : (top.model ? [top.model] : []);
  const wantAlias = expected === "pf-verifier" ? "@pf-strong" : "@pf-worker";
  if (models[0] !== wantAlias) fail(`${file}: model list must start with ${wantAlias} (got ${JSON.stringify(models[0])})`);
  if (models.length < 2 || !/^[\w.-]+\/[\w.\/-]+(:[a-z]+)?$/.test(models[1])) fail(`${file}: model list needs a concrete provider/model fallback after the alias`);

  for (const [key, val] of Object.entries(top)) {
    if (!val) continue; // nested block follows
    const quoted = /^(["']).*\1$/.test(val) || /^[\[{|>]/.test(val);
    if (!quoted && (/:\s/.test(val) || /\s#/.test(val))) {
      fail(`${file}: ${key}: plain scalar contains ': ' or ' #' — quote it (strict YAML rejects this)`);
    }
  }

  const toolsBlock = fm.match(/^tools:\n((?:\s+-\s+.*\n?)+)/m);
  const tools = toolsBlock ? toolsBlock[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean) : [];
  if ((expected === "pf-scout" || expected === "pf-verifier") && tools.some((t) => t === "edit" || t === "write")) {
    fail(`${file}: read-only role lists a write tool (${tools.join(", ")})`);
  }
  if (!/yield/.test(body)) fail(`${file}: body never mentions the yield envelope`);
  if (!/\{"result": \{"data":/.test(body)) fail(`${file}: body should show the exact yield shape {"result": {"data": ...}}`);
  ok(`${file}: frontmatter + role contract`);
}
if (agentNames.size === 0) fail("no pf-*.md agent files found");

if (existsSync(presetsDir)) {
  for (const file of readdirSync(presetsDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const text = readFileSync(join(presetsDir, file), "utf8");
    const roles = text.match(/^modelRoles:\n((?:\s+[\w-]+:\s*\S+.*\n?)+)/m);
    if (!roles) fail(`presets/${file}: no modelRoles block (pf-worker / pf-strong)`);
    else {
      for (const r of ["pf-worker", "pf-strong"]) {
        const m = roles[1].match(new RegExp(`^\\s+${r}:\\s*(\\S+)`, "m"));
        if (!m) fail(`presets/${file}: modelRoles.${r} missing`);
        else if (!/^[\w.-]+\/[\w.\/-]+(:[a-z]+)?$/.test(m[1])) fail(`presets/${file}: modelRoles.${r}: ${m[1]} is not a provider/model selector`);
      }
    }
    const block = text.match(/^task:\n\s+agentModelOverrides:\n((?:\s+[\w-]+:\s*\S+.*\n?)+)/m);
    if (!block) { ok(`presets/${file}: modelRoles only`); continue; }
    const entries = block[1].split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
    for (const e of entries) {
      const m = e.match(/^([\w-]+):\s*(\S+)/);
      if (!m) { fail(`presets/${file}: unparseable line ${JSON.stringify(e)}`); continue; }
      const [, agent, model] = m;
      if (!agentNames.has(agent)) fail(`presets/${file}: ${agent} is not a shipped agent (${[...agentNames].join(", ")})`);
      if (!/^[\w.-]+\/[\w.\/-]+(:[a-z]+)?$/.test(model)) fail(`presets/${file}: ${agent}: ${model} is not a provider/model selector`);
    }
    ok(`presets/${file}: modelRoles + ${entries.length} per-agent overrides`);
  }
}

if (failed) { console.error("\nagent lint FAILED"); process.exit(1); }
console.log("\nagent lint OK");
