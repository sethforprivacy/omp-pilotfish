# omp-pilotfish

Two-tier orchestration skill for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP): a
**premium model orchestrates** — frames the task, plans, makes integration calls, and does the
**final review** — while **ALL volume work, research, and implementation runs on a second,
cheaper model tier**, typically your own local router.

A port of [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) (MIT) compressed
to two tiers and wired through OMP's own agent files and `task` protocol.

## Why this is the ideal mix of efficacy and cost savings for local AI

Most tokens in any coding session go to search, repetitive edits, test suites, and docs — not to
judgment. This skill prices that reality in:

- **Volume work runs on hardware you already own.** A local vLLM router on a reasonable GPU
  (or even a shared one) serves DeepSeek V4 Flash-class work at near-zero marginal cost per token.
  The long-tail of a session — recon, mechanical edits, broad research — never touches a paid API.
- **Premium tokens are spent only where they change the outcome:** planning/architecture,
  integration judgment, and one fresh-context **final review** by a model that did *not* do the
  work. Instead of paying for millions of run-of-the-mill tokens, you pay for the handful of
  turns that actually decide correctness.
- **Independence is built in.** The model that produced the work never grades its own work: a
  fresh-context premium verifier (`CONFIRMED` / `REFUTED` / `INCONCLUSIVE`) gates every
  acceptance boundary.

For someone running local inference on consumer/mid-range hardware, this is the pattern that
gets frontier-quality *decisions* at local *throughput* — the best cost/efficacy mix available.

## Architecture

| Role | Tier | Job |
|---|---|---|
| Orchestrator (main session) | premium | framing, planning, approval, integration, **final review** |
| `pf-scout` | worker | read-only recon, facts with `file:line` |
| `pf-mech-executor` | worker | fully-specified, same-shape repetition |
| `pf-executor` | worker | bounded implementation with local judgment |
| `pf-verifier` | premium | fresh-context outcome verification → CONFIRMED / REFUTED / INCONCLUSIVE |

Roles are **pinned in agent `model:` frontmatter**, not in skill logic — so the skill itself is
router/model agnostic. Any OpenAI-compatible provider works (local vLLM, Ollama, OpenRouter,
PREM, Venice, …).

**Recommended pairing** (what we run — Kimi K3 or GLM 5.3 to orchestrate, DeepSeek V4 Flash to
work):

| Role | Model |
|---|---|
| Orchestrator / verifier | `prem/kimi-k3` — or `venice/zai-org-glm-5-2` (GLM 5.3) |
| Workers | `vllm/deepseek-v4-flash-0731` (local router) |

## Install

```bash
# 1. Skill + scripts → global skill dir
cp -R SKILL.md scripts ~/.omp/agent/skills/pilotfish/
# 2. Role agents → global agent dir
cp agents/pf-*.md ~/.omp/agent/agents/
```

Then register providers in `~/.omp/agent/models.yml` — any OpenAI-compatible router:

```yaml
providers:
  localvllm:
    baseUrl: http://localhost:8000/v1      # your router
  premium:
    baseUrl: https://your-routed-gateway/v1 # e.g. PREM/OpenRouter-style gateway
    apiKey: PREM_ROUTER_API_KEY             # env-var name; or inline secret
```

Edit `model:` in each `agents/pf-*.md` and the model you launch OMP with to your own routes.

## Usage

Start OMP on the premium tier, invoke the skill:

```bash
omp --model prem/kimi-k3
# in the session:
#   "pilotfish: <task>"
#   or "orchestrate this with the local router doing the work and kimi reviewing"
```

The orchestrator runs the six-gate protocol (frame → recon fan-out → plan/approval → worker
execution → fresh-context verification → final review). Full protocol in `SKILL.md`.

Sample end-to-end run with real output: [`docs/sample-run.md`](docs/sample-run.md).

## Credit

Adapted from [pilotfish](https://github.com/Nanako0129/pilotfish) by Nanako0129 — MIT licensed.
Original: frontier model keeps planning/approval/integration/final judgment in the main session;
small fast role agents do the volume work; fresh-context verifiers gate acceptance. This port
compresses that topology to two tiers and implements it natively for the Oh My Pi agent.

## License

MIT, see [LICENSE](LICENSE). Team Pilotfish's review gates and severity/verifier vocabulary
carry through from the upstream project.
