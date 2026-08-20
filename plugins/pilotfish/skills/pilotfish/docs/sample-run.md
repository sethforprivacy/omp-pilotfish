# Sample run — pilotfish end-to-end

A real validation run of the skill, captured 2026-08-20 on OMP with the two-tier
split this skill exists for:

- **Orchestrator / final review:** `prem/kimi-k3`
- **Worker pool:** `vllm/deepseek-v4-flash-0731` (local router)

Scratch repo: a single `src/greeter.py` with an unconditional `greet()` f-string
and `main()` printing `greet("world")`.

## Prompt

> Use the pilotfish skill for a small validation task in this repo.
> Task: have pf-scout report how greet() handles an empty name and where the
> default call site lives (file + line). Then claim: "greet('') returns 'Hello, !'
> in src/greeter.py". Send that exact claim to pf-verifier for a calibrated
> CONFIRMED/REFUTED/INCONCLUSIVE verdict. Then give your orchestrator final
> review of the whole two-tier run (what each tier did, verdict, disposition).

Command: `omp -p --model prem/kimi-k3 "…prompt…"` from the repo root.

## Output

**Tier 1 — pf-scout (local worker, recon):** Read `src/greeter.py` and
repo-searched for call sites. Reported: `greet()` is a single unconditional
f-string (`src/greeter.py:1-3`) — no default parameter, no falsy check, no
empty-string branch — so `greet('')` → `Hello, !` (8 chars, empty `{name}` slot
before `!`). Sole/default call site: `src/greeter.py:7` —
`print(greet("world"))` inside `main()` (line 6); no `__main__` guard, CLI, or
other module. Facts carried `file:line` and quoted lines; no edits.

**Tier 2 — pf-verifier (premium, fresh context):** Received the packet with the
exact claim `greet('') returns 'Hello, !' in src/greeter.py`. Independently
executed `greet('')` → observed `'Hello, !'` / `True` / len 8; probed edges —
live source has no empty-input branch, disk file matches packet verbatim, no
shadowing `greet` definitions, falsy inputs uniform (`' '` → `'Hello,  !'`,
`'0'` → `'Hello, 0!'`). Read-and-run only.

**Verdict:** `CONFIRMED` (confidence 1.0, no findings).

**Disposition:** CONFIRMED → final review → ship. My own read of
`src/greeter.py` matches both tiers byte-for-byte: unconditional f-string at
lines 1-3, sole call site at line 7. The claim is true as stated. Nothing
ignored; no fixes required. Validation-only task — no files were modified by
any tier.

## What the run demonstrated

1. Recon stayed on the local worker (`pf-scout`, vllm router) — premium tokens
   untouched.
2. The verifier did an independent, fresh-context execution + edge probing —
   the model that does the work never grades its own work.
3. The orchestrator exercised its final review: read the integrated result,
   cross-checked both tiers, and disposed the verdict.
4. No tier modified the repo; the only artifact was the verifier's `__pycache__`
   from genuinely executing the code under test.
