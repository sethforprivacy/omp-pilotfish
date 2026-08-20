---
name: pilotfish
description: OMP port of Nanako0129/pilotfish (MIT) — two-tier orchestration. The main session is the orchestrator (recommended: Kimi K3 or GLM 5.3) and owns planning, decisions, integration, and the FINAL review; ALL work, research, and implementation is delegated to a second, cheaper model tier running on your local router (recommended: DeepSeek V4 Flash on local vLLM). Load whenever the user says "pilotfish", "orchestrate this", "two-model", "run the work on the local router, X reviews", "kimi orchestrates", "delegate the work, review with the strong model", or wants frontier judgment over locally-executed work.
---

# Pilotfish — two-tier orchestration (OMP port)

> Port of [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) (MIT) to the Oh My Pi
> coding agent. Original: frontier model keeps planning/approval/integration/final judgment in the
> main session; small fast role agents do the volume work; fresh-context verifiers gate acceptance.
> This port compresses that to **two tiers** — one orchestrator, one worker pool — and wires the
> tiers through OMP's own agent files and `task` protocol.

**The idea in one line:** most coding-session tokens are spent on search, repetitive edits, tests,
and docs — not judgment. Route those to a model that is nearly free to run locally, and spend your
premium endpoint tokens only where they change the outcome: planning, integration, and the final
review.

## Model contract — roles are pinned in agent files, not here

This skill never names a concrete model in prose or logic. Every tier is an **OMP agent file** in
`~/.omp/agent/agents/`, and each file's `model:` frontmatter is that tier's model. Swap models by
editing those files — no skill changes needed.

| Role | Agent file | Tier | Job | Shipped default (recommended) |
|------|-----------|------|-----|------|
| Orchestrator | *(main session)* | premium | framing, planning, approval, integration, **final review** | `prem/kimi-k3` — swap to `openrouter/moonshotai/kimi-k3` or `openrouter/z-ai/glm-5.3` |
| Recon | `pf-scout` | worker | read-only search/recon, facts with `file:line` | `vllm/deepseek-v4-flash-0731` |
| Mechanical executor | `pf-mech-executor` | worker | fully-specified, same-shape repetition | `vllm/deepseek-v4-flash-0731` |
| Judgment executor | `pf-executor` | worker | bounded implementation with local judgment | `vllm/deepseek-v4-flash-0731` |
| Verifier | `pf-verifier` | premium | fresh-context outcome verification → CONFIRMED / REFUTED / INCONCLUSIVE | `prem/kimi-k3` — swap to `openrouter/moonshotai/kimi-k3` |

Model routing lives in each agent file's `model:` frontmatter (and the `--model` the session
launches with); the recommended public pairing routes the premium seats through OpenRouter.
Rename `prem` ≠ premium: `prem/` is the PREM router provider, `openrouter/` is OpenRouter.

**Rules that are NOT optional:**
- The orchestrator (main session) must be a premium model — run OMP with `--model prem/kimi-k3`,
  `openrouter/moonshotai/kimi-k3`, or your GLM 5.3 route. If the session runs on the worker
  model, you are not pilotfishing; you are just a local-model session.
- Workers are pinned to the local router and do ALL volume work. Workers never spawn sub-agents
  (leaf roles) and never run on the premium model.
- The verifier is a **premium, fresh-context** gate — it exists because the model that did the work
  must not grade its own work.
- Applying this skill to a task does not remove general harness duties (tests, docs, cleanup) from
  the orchestrator's final sweep — it moves *production* of those to the worker tier.

## When to use

- User asks for it: "pilotfish", "orchestrate this", "delegate to the local router".
- Task is priced by token volume: multi-file refactors, broad research, docs generation, test
  suites, mechanical migration — anything where most of the work is volume, not judgment.
- A boundary exists where an independent final review is worth a premium round-trip.

Do NOT use for: small bounded tasks the orchestrator can finish in one pass (splitting has a
coordination cost), or genuinely novel architecture where the premium model should just do the work.

## Protocol

Run these steps in order. The packet script is deterministic context capture; you orchestrate.

### 1. Frame (orchestrator, premium)
Write one to three sentences: what is being done, what "done" means, and the constraints. If the
outcome or acceptance is unclear, ask a direction-changing question first (interaction shape
`co_discover`); otherwise `explore_then_plan` for broad/high-impact work, `execute` for bounded work.

### 2. Dispatch recon — ONE parallel batch
For genuinely independent evidence surfaces (multiple subsystems, large unknown codebase), spawn
`pf-scout` for each disjoint surface in a single `task` call — one entry per scout — so they run
concurrently. Each scout gets the exact question + scope, never a pre-decided conclusion.

- Block fan-out when: scopes overlap, the synthesis owner is missing, or integration cost exceeds
  the benefit. Bounded task-local search belongs to the orchestrator; do not split work you would
  have to reassemble anyway.
- Collect ALL results before cross-surface comparison. Scouts report facts; the orchestrator
  reconciles and writes the plan.

### 3. Plan + approval gate (orchestrator, premium)
Synthesize ONE plan from scout results. For large/architectural/risky cross-surface work, present
the plan and WAIT for explicit user approval before any source edit. Broad initial request is not
approval of an unseen plan.

### 4. Execute (workers, local)
Choose the worker by shape:
- `pf-mech-executor` — fully specified repetition: one complete one-shot brief, exclusive
  ownership, independent items, per-item acceptance.
- `pf-executor` — bounded judgment under an approved contract: `goal + constraints + done-criteria`.
- Parallel writers: only with `isolated` (worktree) tasks and disjoint ownership; otherwise one
  shared-checkout worker at a time. Read-only roles may share the checkout.

Rules:
- Worker files are worker-owned until you collect the result. Never redo a worker's changes.
- Never build a `pf-scout → pf-executor` pipeline for a single unknown bug — root-cause
  diagnosis stays orchestrator work until the cause, scope, files, constraints, and done-criteria
  are stable without rediscovery.
- After two failures from the same worker tier, escalate (stronger worker config) or take the work
  over yourself — never a third same-tier retry.
- A worker that reports a genuine architecture fork or spec conflict stops and escalates; you
  decide, never let it guess.

### 5. Verify (verifier, premium) — the final-review gate
Give `pf-verifier` the EXACT claim + acceptance conditions + the relevant diff/paths (build with
this skill's packet script — at `scripts/packet.mjs` next to this SKILL.md; canonical installed
location `~/.omp/agent/skills/pilotfish/scripts/packet.mjs`):

```
Run it from the skill directory (where this SKILL.md lives — e.g. the plugin cache or
`~/.omp/agent/skills/pilotfish/`), or via its absolute path:

```
node <skill-dir>/scripts/packet.mjs \
  --focus "<what was done>" \
  --claim "<exact acceptance: 'done means …'>" \
  --summary "<3-8 factual bullets of worker output>" \
  --out /tmp/pilotfish-packet.md
```

Then ONE `task` call: `agent: pf-verifier`, body = "Verify the claim in /tmp/pilotfish-packet.md per
your role contract; return your calibrated verdict." The verifier is read-and-run only, never edits.

### 6. Dispose + final review (orchestrator, premium)
| Verdict | Response |
|---|---|
| CONFIRMED | Pass to final review — read the integrated result yourself, then ship |
| REFUTED | Fix the reproduced P0-P2 block yourself or via worker, verify the fix, then ONE fresh verifier pass on the new state (never reverify identical state) |
| INCONCLUSIVE | One retry only after stated missing evidence/contract/prerequisite changed materially; otherwise pause and surface to the user |

Any required post-verdict change invalidates a CONFIRMED; rerun primary acceptance plus one fresh
verifier when claim-relevant. Your final review is a judgment pass over the integrated result and
the verifier's evidence — this is where the premium model earns its keep. Finish by stating what
changed, what you ignored and why, and the current verdict.

## Safety

- Credentials/secrets/identity/crypto work: never route unwittingly to a worker pool that lacks a
  verification gate — the verifier gate above is mandatory for any security-sensitive slice.
- The worker pool is your own local router: it is trusted, but a fresh-context verifier still
  exists because proximity ≠ independence.
- Long-running commands: workers run foreground and return the exact command if it exceeds ~10
  minutes — never detach (lost work is the failure mode; see `pf-*` role contracts).

## Tooling

- Scripts live in `scripts/` alongside this SKILL.md (use your installed skill dir absolute
  path; cwd varies by project).
- `packet.mjs`: `--focus` (required), `--claim`, `--summary`, `--files a,b,c` (explicit, no VCS),
  `--limit <bytes>`, `--out <path>`, `--json`. Auto-detects git (`git status --porcelain` +
  `git diff`) and jj (`jj status` + `jj diff --git`).
- Changing tier models = editing the four `pf-*.md` agent files + the `--model` role you run
  OMP with. Update `model:` (e.g. swap `prem/kimi-k3` → `openrouter/moonshotai/kimi-k3`, or
  `openrouter/z-ai/glm-5.3` for GLM 5.3). Register new provider endpoints in
  `~/.omp/agent/models.yml` (OpenRouter is built in — just set `OPENROUTER_API_KEY`).
