# Social Media Content Planner

A tool-using AI agent that plans, drafts, revises and schedules social media
content — keeping a human in the loop before anything irreversible happens.

Built on the Claude API (`claude-opus-5`) in TypeScript, so the same agent module
runs unchanged behind a CLI today and an Express + React app later.

- [Agent design](docs/AGENT-DESIGN.md) — tool surface, approval state machine, validation layer
- [Content model](docs/CONTENT-MODEL.md) — ideas vs platform versions, formats, time, campaigns
- [Architecture](docs/ARCHITECTURE.md) — surface selection, cost strategy, deployment target
- [Media](docs/MEDIA.md) — letting the agent see the user's photos
- [Connecting accounts](docs/OAUTH.md) — Meta OAuth, what it really requires
- [Roadmap](docs/ROADMAP.md) — the phases and what each one teaches

**Current status: the full loop works end to end against mocks.** Draft →
approve → schedule → publish, Meta only (Instagram + Facebook), planning around
a real media library the agent can see. In-memory store, mock scheduler, mock
connector. No real OAuth yet — see [docs/OAUTH.md](docs/OAUTH.md).

## Setup

```bash
npm install
cp .env.example .env          # add your key from console.anthropic.com
```

## Usage

```bash
npm run agent      # interactive REPL
npm run verify     # 83 safety assertions
npm run typecheck
```

Then talk to it: `plan next week for me`

| Command | What it does |
|---|---|
| `/calendar` | ideas, with each channel's version nested under them |
| `/show <itemId>` | one idea plus every platform version in full |
| `/approve <variantId>` | approve **as the human** — the agent has no path to this |
| `/media` | the photo and video library |
| `/upload <path>` | add a real photo — runs the vision pass |
| `/publish` | run the publisher — simulates the timer firing |
| `/cost` | session spend |
| `/exit` | quit |

## Layout

```
src/
  cli.ts            REPL standing in for the React UI
  schemas.ts        domain model + the variant state machine
  seed.ts           demo business profile and capability matrix
  verify.ts         83 safety assertions
  agent/
    agent.ts        the loop (SDK Tool Runner)
    tools.ts        the 19 tools
    system.ts       agent instructions — frozen, so it caches
    time-context.ts what "now" and "next Monday" mean, injected per turn
  store/
    memory.ts       backend validation layer (mock DynamoDB)
    connections.ts  OAuth connections and their channels — tokens never leave
  publisher.ts      the worker: drains due variants, applies failure policy
  scheduler/
    types.ts        the Scheduler seam — EventBridge drops in here
    mock.ts         in-memory timers, so reschedule/cancel are honest
  connectors/
    types.ts        the SocialConnector seam — MetaConnector drops in here
    mock.ts         publishes nothing, fails in all four real ways
  media/
    types.ts        assets, aspect ratios, which formats a shape allows
    describe.ts     the vision pass — runs ONCE per asset, at upload
    storage.ts      local disk standing in for S3 + CloudFront
```

## The two design rules

**Tools are for what the model cannot know or cannot do.** Reading state,
causing side effects. There is no `generate_caption` tool — captions are the
model's *output*, written in its turn and passed as arguments to
`save_draft_posts`. A generate-tool means the LLM calling a tool that calls an
LLM: double the cost, and a caption written without knowledge of the rest of the
week.

**The human gate is a type error, not an instruction.** There is no
`approve_post` tool. `/approve` calls the store directly, bypassing the agent —
as a React button will hit an authenticated endpoint rather than going through
the model. "Never schedule without approval" is enforced by a status check in
backend code, not by a line in a prompt that a long context could erode.
