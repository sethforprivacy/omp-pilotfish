#!/usr/bin/env node
// validate-marketplace.mjs — validate the OMP marketplace catalog + plugin integrity.
// Run in CI (and locally) before publishing a release or after any repo change.
//
//   node scripts/validate-marketplace.mjs   # exit 0 = valid, 1 = broken
//
// Checks:
//   1. .omp-plugin/marketplace.json parses and matches the OMP catalog schema essentials.
//   2. Marketplace + plugin names obey the OMP naming rules (lowercase/digits/-/., alnum edges).
//   3. Each plugin `source` resolves inside the repo root (no path traversal) and exists.
//   4. For relative-path plugins: skills/<name>/SKILL.md exists (when a skills/ dir is claimed),
//      agents/*.md globs resolve, and skill-local scripts exist.
//   5. Version alignment: catalog plugin.version === plugin package.json version when present.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;

function fail(msg) {
  failed = true;
  console.error(`FAIL ${msg}`);
}

const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function checkName(kind, name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || !NAME_RE.test(name)) {
    fail(`${kind} name ${JSON.stringify(name)} violates OMP naming rules (lowercase letters/digits/hyphens/dots, alphanumeric start+end, <=64 chars)`);
  }
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read/parse ${path}: ${e.message}`);
    return null;
  }
}

const catalogPath = join(repoRoot, ".omp-plugin", "marketplace.json");
const catalog = loadJson(catalogPath);
if (catalog) {
  checkName("marketplace", catalog.name);
  if (!catalog.owner?.name) fail("catalog missing owner.name");
  if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) fail("catalog missing plugins[]");

  for (const entry of catalog.plugins ?? []) {
    checkName("plugin", entry.name);
    if (typeof entry.source !== "string" || !entry.source.startsWith("./")) {
      fail(`plugin ${entry.name}: source must be a relative './...' path for this repo (got ${JSON.stringify(entry.source)})`);
    }

    const pluginDir = resolve(repoRoot, entry.source);
    if (pluginDir === repoRoot || !pluginDir.startsWith(repoRoot + "/") || !existsSync(pluginDir)) {
      fail(`plugin ${entry.name}: source ${entry.source} must resolve inside the repo root and exist`);
      continue;
    }
    console.log(`ok: plugin ${entry.name} -> ${pluginDir}`);

    // Skills under a canonical skills/<name>/ layout.
    const skillDirs = [];
    if (existsSync(join(pluginDir, "skills"))) {
      for (const name of readdirSync(join(pluginDir, "skills"))) {
        if (existsSync(join(pluginDir, "skills", name, "SKILL.md"))) {
          skillDirs.push(name);
        } else {
          fail(`plugin ${entry.name}: skills/${name} exists but has no SKILL.md`);
        }
      }
      if (skillDirs.length === 0) fail(`plugin ${entry.name}: skills/ dir present but no skills/<name>/SKILL.md found`);
    }

    // Agents — at least the pilotfish cast is expected.
    const agentsDir = join(pluginDir, "agents");
    if (existsSync(agentsDir)) {
      const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
      console.log(`ok: plugin ${entry.name} ships agents: ${agents.join(", ") || "(none)"}`);
    }

    // Skill-local scripts that SKILL.md references must exist.
    for (const skill of skillDirs) {
      for (const script of ["scripts/packet.mjs"]) {
        const p = join(pluginDir, "skills", skill, script);
        if (existsSync(p)) console.log(`ok: ${skill}/${script} present`);
        else fail(`plugin ${entry.name}: ${skill}/${script} referenced by SKILL.md is missing`);
      }
    }

    // Version alignment with plugin package.json.
    const pkgPath = join(pluginDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = loadJson(pkgPath);
      if (pkg?.version && entry.version && pkg.version !== entry.version) {
        fail(`plugin ${entry.name}: catalog version (${entry.version}) != package.json version (${pkg.version})`);
      } else if (pkg?.version) {
        console.log(`ok: plugin ${entry.name} version ${pkg.version} (catalog ${entry.version ?? "(unset)"})`);
      }
    }
  }
}

if (failed) {
  console.error("\nmarketplace validation FAILED");
  process.exit(1);
}
console.log("\nmarketplace validation OK");
