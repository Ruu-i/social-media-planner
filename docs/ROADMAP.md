# Roadmap

Each phase ships something runnable. Nothing built in an earlier phase is thrown
away in a later one.

---

## Phase 1 — One call, no agent  ✅ IMPLEMENTED

**Goal:** a brand profile in, a validated content plan out. No tools, no loop.

- `messages.parse()` with a Zod schema via `zodOutputFormat`
- Brand profile loaded from `data/brand.json`
- Plan written to `out/plan-<timestamp>.json` and printed to the terminal

**What you learn:** the SDK, structured outputs, prompt iteration — with no loop
mechanics in the way.

**Done when:** `npm run plan` prints a coherent 7-day calendar that matches the
brand voice.

---

## Phase 2 — Add the agent loop

**Goal:** the plan is grounded in what's actually happening now, not just the
model's priors.

- Switch `messages.parse()` → `client.beta.messages.toolRunner()`
- Declare the `web_search_20260209` server tool
- Add `get_brand_profile` and `get_recent_posts` as `betaZodTool`s
- **Gotcha:** the tool runner does not auto-resume `pause_turn`. Check
  `stop_reason` each iteration and `runner.pushMessages(...)` the paused
  assistant turn back, or the run silently ends truncated.

**What you learn:** the agentic loop, server tools vs. client tools, why tool
descriptions are really prompts.

**Done when:** the plan cites current, real trends and the reasoning shows
multiple searches.

---

## Phase 3 — Human-in-the-loop and persistence

**Goal:** a real side effect, safely gated.

- SQLite behind the existing `store/` interface
- `save_content_plan` tool (ungated)
- `schedule_post` tool with confirmation **inside `run()`**, returning a
  "user declined" result rather than throwing
- Pick a provider: Buffer (simplest), Ayrshare (broadest), or direct platform APIs
  (most work — each has its own OAuth and app review)

**What you learn:** approval gating, irreversible actions, why tool granularity
maps to your security boundary.

---

## Phase 4 — HTTP API

- Express wrapper over the exact same agent module
- `POST /plans` enqueues a run; `GET /plans/:id` polls; SSE streams progress
- Zod schemas shared between agent and API — one source of truth

Agent code is untouched. This phase is pure transport.

---

## Phase 5 — React UI

- Calendar view, inline caption editing, regenerate-single-post
- Brand profile editor
- Approval queue in front of `schedule_post`

---

## Phase 6 — AWS

- S3 + CloudFront (React), ECS Fargate (API), RDS Postgres
- Secrets Manager for the Anthropic key and provider tokens
- SQS for long-running plan jobs
- CloudWatch on token spend per run

---

## Cross-cutting, do early

- **Evals.** Once prompts start changing, build a small eval set so you can tell
  whether an edit helped. Without it, prompt tuning is guesswork.
- **Cache verification.** Assert `usage.cache_read_input_tokens > 0` on repeat
  runs.
- **Cost logging.** Record `usage` per run from Phase 1 onward.
