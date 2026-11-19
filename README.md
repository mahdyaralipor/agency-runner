# agency-runner

[![test](https://github.com/mahdyaralipor/agency-runner/actions/workflows/test.yml/badge.svg)](https://github.com/mahdyaralipor/agency-runner/actions/workflows/test.yml)

> The [agency-agents](https://github.com/msitarzewski/agency-agents) repo installs the team.
> This runs the pipeline.

Agency Agents ships hundreds of specialist prompts and the NEXUS playbooks. What it does not ship is a
way to **run** a playbook: which phase you are in, what counts as done, which gate is blocking,
and what evidence you attached. `agency-runner` is that missing state machine.

- Seven NEXUS phases, six gates (phase 6 is ongoing operations).
- Every criterion needs evidence before the gate opens.
- Generates a paste-ready orchestrator prompt for whatever agent tool you use — Claude Code,
  OpenCode, Codex, Cursor, anything that accepts text.
- Zero dependencies, no API keys, no LLM calls. It is a checklist that cannot be talked past.
- State lives in `.agency/state.json`: plain JSON, easy to diff, review and commit.

## Quick start

```bash
# straight from GitHub (works today)
npx github:mahdyaralipor/agency-runner init --runbook startup-mvp
npx github:mahdyaralipor/agency-runner next

# or, once the npm release is live
npx agency-runner init --runbook startup-mvp
```

`next` prints the phase brief and a prompt. Paste the prompt into your agent. When the work
produces an artifact, record it:

```bash
npx agency-runner next --prompt-only | your-agent-cli   # hand off without copy-paste
npx agency-runner evidence 1 reports/market.md
npx agency-runner evidence 2 reports/pain-points.md
npx agency-runner status
```

When every criterion is evidenced, open the gate:

```bash
npx agency-runner gate --pass --note "market validated, 3 pain points confirmed"
```

The gate refuses while evidence is missing (exit code `2`), and re-checks at gate time that every
recorded path still exists. `--force --note "<reason>"` exists for real life, and the override is
recorded in the state file forever.

## Commands

| Command | What it does |
|---|---|
| `agency init [--runbook <name>] [--force]` | Start a run in the current directory. |
| `agency next [--json] [--prompt-only]` | Phase brief, criteria, evidence status, paste-ready prompt. |
| `agency status [--json]` | All seven phases, current phase, gate state. |
| `agency evidence <n> <path-or-note>` | Attach an artifact to criterion `n` of the current phase. A path must exist. |
| `agency gate --pass\|--fail [--note "..."]` | Decide the gate. Failures count toward the 3-attempt escalation. |
| `agency log "<message>"` | Append a decision to the run log. |

Aliases: `agency-runner` is installed as the same binary.

## The gates

| Phase | Gate keeper |
|---|---|
| 0 Discovery | Executive Summary Generator |
| 1 Strategy & Architecture | Studio Producer + Reality Checker |
| 2 Foundation & Scaffolding | DevOps Automator + Evidence Collector |
| 3 Build & Iterate | Agents Orchestrator |
| 4 Quality & Hardening | Reality Checker (sole authority) |
| 5 Launch & Growth | Studio Producer + Analytics Reporter |
| 6 Operate & Evolve | Studio Producer (steady-state review) |

Criteria and gate keepers are taken from the NEXUS playbooks; the CLI links to the canonical
playbook for each phase instead of copying it.

## Why evidence gates

Agent workflows fail in a specific way: the agent says "done", the human believes it, and the
next phase builds on an artifact that does not exist. A gate that only accepts a path or a note
is a cheap counterweight. It does not prove the work is good — it proves the work is *findable*.
The reviewer still has to look.

## What it does not do

- **Does not install agents.** Use the agency-agents repo's own `scripts/install.sh`.
- **Does not call an LLM.** Your agent tool does the work; this tracks it.
- **Does not replace the playbooks.** It gives you the checklist and the prompt, and links out.
- **Does not invent a deadline for phase 6.** Operations has no end date; the final review just
  marks steady state.

## Try the whole loop without touching your repo

```bash
mkdir /tmp/agency-demo && cd /tmp/agency-demo
node /path/to/agency-runner/bin/agency.mjs init
node /path/to/agency-runner/bin/agency.mjs evidence 1 demo.md
node /path/to/agency-runner/bin/agency.mjs gate --pass   # blocked: 5 of 6
```

## Data provenance

Phase names, gate keepers and gate criteria are derived from the NEXUS playbooks in
[msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents), MIT licensed,
© AgentLand Contributors. See `NOTICE`. The runner code is MIT.

Pinned to the playbooks as of 2026-11-19. Upstream changes need a data update, not a rewrite.

## Status

`0.1.0`. The state machine, gates, evidence and prompt generation are covered by tests.
The next milestone is a real run by someone who is not the author — that is the only
validation that matters for a tool like this.
