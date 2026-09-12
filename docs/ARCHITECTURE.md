# Architecture

## 1. What this system actually is

A **tool-using AI agent** that plans, drafts, revises and schedules social media
content against a business profile, keeping a human in the loop before any
external side effect.

> **Superseded framing.** An earlier draft of this document described the system
> as "a workflow with one agentic step". That was scoped to a single operation
> (generate a calendar) and is wrong for the actual product. See
> [AGENT-DESIGN.md](./AGENT-DESIGN.md) for the agent design that governs — tool
> surface, the approval state machine, and the backend validation layer.

The agent inspects state before acting, branches on what it finds, operates
multi-turn over persistent data, and causes gated irreversible effects. All four
properties are required for the product to work at all.

## 2. Surface selection

There are four ways to build an agent on Claude. This project uses #2.

| # | Approach | Who writes the loop | Chosen? |
|---|---|---|---|
| 1 | Claude API, manual loop | you | no — unnecessary control |
| 2 | Claude API + **Tool Runner** | the SDK | **yes** |
| 3 | Managed Agents | Anthropic (hosted sandbox) | no — we don't need a hosted container |
| 4 | Claude Agent SDK | Claude Code as a library | no — that's a coding agent |

**Why the Tool Runner.** `client.beta.messages.toolRunner()` drives the
request → execute tool → feed result back → repeat cycle for us. We write only the
tool functions. We keep full control of execution (tools run in *our* Node
process, against *our* database) without hand-rolling a
`while (stop_reason === "tool_use")` loop.

We are explicitly **not** using LangChain or a similar framework. The abstraction
it adds costs more to learn and debug than the ~40 lines of loop it replaces.

---

## 3. Model configuration

| Setting | Value | Reason |
|---|---|---|
| Model | `claude-opus-5` | 1M context, $5/$25 per MTok |
| Thinking | `{ type: "adaptive" }` | Model decides depth per request. Never disable it — see below. |
| Effort | `medium` for drafting, `high` for research | Caption writing is not hard reasoning; don't overpay |
| `max_tokens` | 16000 non-streaming / 64000 streaming | Avoid mid-thought truncation |
| Fallbacks | `"default"` + beta `server-side-fallback-2026-07-01` | Handles `stop_reason: "refusal"` automatically |

**Two Opus 5 specific traps:**

1. **Always check `stop_reason` before reading `content`.** A refusal returns
   HTTP 200 with `stop_reason: "refusal"` and no usable content. Server-side
   fallbacks make this mostly self-healing, but the guard still belongs in code.
2. **Never set `thinking: { type: "disabled" }`.** On Opus 5 that causes the model
   to occasionally write a tool call into its *visible text* instead of emitting a
   `tool_use` block — the call silently never runs, with no error. To cut cost,
   lower `effort` instead.

---

## 4. Tool surface

The single most important distinction for this project:

- **Tools** are things the agent *does* — side effects, or fetching data it can't know.
- **Output** is what the agent *produces* — captions, hashtags, ideas.

Captions are **output**, shaped by structured outputs (`output_config.format`),
not a `write_caption` tool. Making generation a tool is the most common beginner
mistake and it makes everything harder to validate.

| Tool | Side | Gated | Purpose |
|---|---|---|---|
| `web_search` | Anthropic server tool | no | Trend, competitor, seasonal research. Zero code — declare and it runs. |
| `get_brand_profile` | ours | no | Voice, audience, pillars, banned words. Keeps the system prompt small and cache-stable. |
| `get_recent_posts` | ours | no | Avoid repetition and clashes with what's already queued. |
| `save_content_plan` | ours | no | Persist the plan. Reversible, so no confirmation. |
| `schedule_post` | ours | **yes** | Publishes externally. Hard to reverse → human confirms. |

### Why `schedule_post` is a dedicated, gated tool

The general rule: *start with broad tools, promote an action to a dedicated tool
when you need to gate, render, audit, or parallelize it.* Scheduling is the
clearest case — it's an irreversible external side effect. A dedicated tool gives
the harness a typed, action-specific hook it can intercept and put a confirmation
in front of. The gate lives **inside the tool's `run()`**, returning a
"user declined" result rather than throwing, so the agent can react to the refusal
instead of crashing the loop.

---

## 5. Context and cost strategy

- **Prompt caching.** Render order is `tools` → `system` → `messages`. The system
  prompt and brand profile are stable, so they sit first behind a cache
  breakpoint. Anything volatile (today's date, the run id) goes *after* it.
  Verify with `usage.cache_read_input_tokens` — if it's zero across repeated runs,
  something in the prefix is changing.
- **No premature compaction.** A planning run is a handful of turns. Compaction
  and context editing matter for long-lived agents; revisit only if a session
  starts approaching the context limit.
- **Rough cost.** ~15k in / 4k out per plan ≈ **$0.17** uncached. Caching the
  system prefix cuts the input side substantially on repeat runs.

---

## 6. Data model

```
Brand      id, name, niche, audience, voice, pillars[], bannedWords[], platforms[]
Post       id, planId, platform, scheduledFor, hook, caption, hashtags[],
           mediaIdea, rationale, status
ContentPlan id, brandId, windowStart, windowEnd, strategy, posts[], createdAt
```

Storage is a JSON file for Phase 1, SQLite for Phase 2–3, Postgres (RDS) once the
API exists. The `store/` module is an interface from day one so that swap is a
one-file change and never touches agent code.

---

## 7. Target deployment (later)

```
React (S3 + CloudFront)
        |
   API Gateway
        |
   Node/Express on ECS Fargate ──> Anthropic API
        |                     └──> Buffer / Ayrshare
   RDS Postgres + Secrets Manager
```

Long planning runs exceed a typical HTTP timeout, so the API endpoint enqueues a
job (SQS) and the client streams or polls for progress. That is a Phase 5 concern
— noted here so nothing built earlier blocks it.

---

## 8. Layering rule

```
cli.ts / server.ts    <- transport. swappable.
  agent/              <- prompts, tools, loop. the product.
    store/            <- persistence interface. swappable.
```

Agent code never imports Express and never imports a database driver directly.
This is what makes "add React and AWS later" a genuinely additive change rather
than a rewrite.
