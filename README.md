# omp-pilotfish

Two-tier orchestration skill for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP): a
**premium model orchestrates** — frames the task, plans, makes integration calls, and does the
**final review** — while **ALL volume work, research, and implementation runs on a second,
cheaper model tier**, typically your own local router.

A port of [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) (MIT) compressed
to two tiers and wired through OMP's own agent files and `task` protocol.

> Published as an OMP plugin: `omp plugin marketplace add sethforprivacy/omp-pilotfish`, then
> `omp plugin install pilotfish@omp-pilotfish`.

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

Roles are resolved **by agent name** (config overrides, then agent `model:` frontmatter), not in
skill logic — so the skill itself is router/model agnostic. Any OpenAI-compatible provider works (local vLLM, Ollama, OpenRouter,
PREM, Venice, …).

## Recommended pairing (OpenRouter)

What we run. Kimi K3 (or GLM 5.3) orchestrates and reviews; DeepSeek V4 Flash does the volume
work — both premium seats through **OpenRouter** (OMP's built-in provider), the worker on our
local **vLLM** router:

| Role | Recommended model |
|---|---|
| Orchestrator (main session) | `openrouter/moonshotai/kimi-k3` — or `openrouter/z-ai/glm-5.3` (GLM 5.3) |
| Verifier (`pf-verifier`) | `openrouter/moonshotai/kimi-k3` — or `openrouter/z-ai/glm-5.3` (GLM 5.3) |
| Workers (`pf-scout`, `pf-mech-executor`, `pf-executor`) | `vllm/deepseek-v4-flash-0731` (local router) |

Naming: `openrouter/` = the **OpenRouter** provider, `vllm/` = the local **vLLM** router
(provider prefix `vllm` is what `models.yml` declares — see below). The shipped agent files
default to `prem/kimi-k3`, the PREM-router route they were validated against; switch them to
OpenRouter per [Customizing the model tiers](#customizing-the-model-tiers).

## Install (plugin, recommended)

```bash
omp plugin marketplace add sethforprivacy/omp-pilotfish
omp plugin install pilotfish@omp-pilotfish
```

Pull updates after a new release:

```bash
omp plugin upgrade pilotfish@omp-pilotfish
```

## Install (manual copy)

```bash
# 1. Skill + scripts → global skill dir
cp -R plugins/pilotfish/skills/pilotfish ~/.omp/agent/skills/pilotfish
# 2. Role agents → global agent dir
cp plugins/pilotfish/agents/pf-*.md ~/.omp/agent/agents/
```

## Customizing the model tiers

Models are resolved **by agent name**, so you never edit installed files. OMP picks each `pf-*`
agent's model in this order (first match wins):

1. `task.agentModelOverrides.<agent>` in config — `~/.omp/agent/config.yml` (global), a project
   `<repo>/.omp/config.yml`, or a one-shot `omp --config <overlay>.yml`
2. the agent file's `model:` list — shipped as a **role alias first, concrete default second**:
   workers `["@pf-worker", "vllm/deepseek-v4-flash-0731"]`, verifier `["@pf-strong", "prem/kimi-k3"]`.
   Set `modelRoles.pf-worker` / `modelRoles.pf-strong` and a whole tier follows; leave them unset
   and the concrete default applies (verified: an undefined alias falls through to the next entry)
3. the session model

The orchestrator is always the `--model` you launch OMP with. Routing is fixed at launch (the `task`
tool has no per-call model parameter), so a swap is a relaunch, not a mid-session request.

### Presets (one run)

Two ready-made overlays ship in `plugins/pilotfish/presets/`:

```bash
# everything on your local router: flash-class workers, strong local verifier
omp --config <plugin-dir>/presets/all-local.yml --model vllm/GLM-5.3-Flash-Ring

# premium seats on OpenRouter, workers on OpenRouter's DeepSeek V4 Flash
omp --config <plugin-dir>/presets/openrouter.yml --model openrouter/moonshotai/kimi-k3
```

`<plugin-dir>` is `~/.omp/plugins/cache/plugins/omp-pilotfish___pilotfish___<version>` for a plugin
install, or wherever you cloned this repo. Copy a preset and change one line to try a new worker
model on the next run — e.g. `pf-executor: vllm/qwen3.8-flash-next`.

### Persistent

Paste the same block into `~/.omp/agent/config.yml` (or `<repo>/.omp/config.yml` to make one
repository use different tiers):

```yaml
modelRoles:
  pf-worker: vllm/deepseek-v4-flash-0731     # all three workers
  pf-strong: vllm/GLM-5.3-Flash-Ring         # verifier
task:
  agentModelOverrides:
    pf-scout: vllm/qwen3.8-flash-next        # optional: pin one seat differently
```

Try a new worker model for one run without touching anything else:

```bash
omp --config <(printf 'modelRoles:\n  pf-worker: vllm/qwen3.8-flash-next\n') --model vllm/GLM-5.3-Flash-Ring
```

### Shipped defaults

| Role | Agent | Shipped `model:` |
|---|---|---|
| Orchestrator | your `omp --model …` | (you choose; strong tier) |
| Recon / Mechanical / Judgment | `pf-scout`, `pf-mech-executor`, `pf-executor` | `@pf-worker`, then `vllm/deepseek-v4-flash-0731` |
| Verifier | `pf-verifier` | `@pf-strong`, then `prem/kimi-k3` |

Editing the four `agents/pf-*.md` files still works for a fork, but overrides are the supported
path — drifted installed copies are how a quick swap becomes an unreproducible setup.

### Provider registration (`~/.omp/agent/models.yml`)

OpenRouter is built into OMP — no entry needed, just a key. Local vLLM routers get a
`providers:` entry:

```yaml
providers:
  vllm:
    baseUrl: http://my-router.local:8000/v1   # your local OpenAI-compatible router
```

Keys: `openrouter` reads `OPENROUTER_API_KEY` from your environment or `~/.omp/agent/.env`:

```bash
echo "OPENROUTER_API_KEY=sk-or-…" >> ~/.omp/agent/.env
chmod 600 ~/.omp/agent/.env   # or create the file via editor/secrets manager
```

Any other OpenAI-compatible gateway (PREM, Venice, …) follows the same pattern: add a
`providers:` entry with `baseUrl` (+ `apiKey`/env name if it needs one), then address its
models as `<provider>/<model-id>` in overrides.

### Verifying your routes

```bash
omp models   # lists every provider + model OMP can currently serve
```

Every model you pin must be served by that provider for your account — if a role's model
doesn't appear, the route is wrong (bad provider name, missing key, or model not available to
that account).

## Usage

Start OMP on the premium tier, invoke the skill:

```bash
omp --model openrouter/moonshotai/kimi-k3
# in the session:
#   "pilotfish: <task>"
#   or "orchestrate this with the local router doing the work and kimi reviewing"
```

The orchestrator runs the six-gate protocol (frame + roster → capped recon fan-out → plan/approval →
worker execution with budgets → fresh-context verification of a fingerprinted packet → final
review). Full protocol in `SKILL.md`.

Hardening built in: the packet script never embeds credential-like files (`.env*`, `*.pem`,
`*token*`, …) and stamps each packet with root, revision, and a diff fingerprint so a verifier can
refuse a moved tree and the orchestrator never re-verifies identical state; workers carry turn
budgets and an explicit output contract; concurrent scouts/verifiers are capped to what one local
router can serve.

Sample end-to-end run with real output: [`docs/sample-run.md`](plugins/pilotfish/skills/pilotfish/docs/sample-run.md).

## Publishing (maintainer)

This repo is both the marketplace catalog (`./.omp-plugin/marketplace.json`) and the plugin
(`./plugins/pilotfish/`). CI keeps it publishable:

- **Every push/PR** — `ci.yml` validates the catalog + plugin integrity, lints agent frontmatter
  and presets (`scripts/lint-agents.mjs`), smoke-tests the packet script, and proves an untracked
  `.env` never reaches a packet.
- **Every `v*` tag** — `publish.yml` validates, archives `plugins/pilotfish/` as
  `pilotfish-<version>.zip`, and attaches it to a GitHub release (release notes auto-generated).

Bump versions in both `.omp-plugin/marketplace.json` and `plugins/pilotfish/package.json`
(the validator enforces they match), then tag. Users pull updates with `omp plugin upgrade`.

## Credit

Adapted from [pilotfish](https://github.com/Nanako0129/pilotfish) by Nanako0129 — MIT licensed.
Original: frontier model keeps planning/approval/integration/final judgment in the main session;
small fast role agents do the volume work; fresh-context verifiers gate acceptance. This port
compresses that topology to two tiers and implements it natively for the Oh My Pi agent.

## License

MIT — see [LICENSE](plugins/pilotfish/skills/pilotfish/LICENSE). Pilotfish's review gates and
severity/verifier vocabulary carry through from the upstream project.
