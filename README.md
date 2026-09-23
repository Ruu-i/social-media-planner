# Social Media Content Planner

A tool-using AI agent that plans, drafts, revises and schedules social media
content — keeping a human in the loop before anything irreversible happens.

Built on the Claude API (`claude-opus-5`) in TypeScript, so the same agent module
runs unchanged behind a CLI, a local Express server, and a Lambda.

**Live: https://d252um6eslhku1.cloudfront.net**

- [Agent design](docs/AGENT-DESIGN.md) — tool surface, approval state machine, validation layer
- [Content model](docs/CONTENT-MODEL.md) — ideas vs platform versions, formats, time, campaigns
- [Architecture](docs/ARCHITECTURE.md) — surface selection, cost strategy, deployment target
- [Media](docs/MEDIA.md) — letting the agent see the user's photos
- [Web UI](docs/WEB.md) — the API layer, SSE, and where the human gate lives
- [Connecting accounts](docs/OAUTH.md) — Meta OAuth, what it really requires
- [Serverless](docs/SERVERLESS.md) — why Lambda response streaming, and its traps
- [Deploy](docs/DEPLOY.md) — the Terraform stack, start to finish
- [Roadmap](docs/ROADMAP.md) — the phases and what each one teaches

**Current status: the full loop works end to end, deployed on AWS.** Draft →
approve → schedule → publish, Meta only (Instagram + Facebook), planning around
a real media library the agent can see.

Real: DynamoDB, S3, Lambda, CloudFront, and the agent itself. Still mocked:
the scheduler (in-memory timers) and the publish connector, which fails in all
four realistic ways but posts nothing. No real OAuth yet — see
[docs/OAUTH.md](docs/OAUTH.md).

The store is an interface with two implementations, and the same 115 assertions
run against both — which is the only reason swapping in DynamoDB was not a
rewrite. It also caught two real bugs the memory store alone never would have:
see [Parity testing](#parity-testing-found-bugs-a-single-store-would-not-have).

## Setup

```bash
npm install
cp .env.example .env          # add your key from console.anthropic.com
```

## Usage

```bash
npm run agent        # interactive REPL
npm run verify       # 115 safety assertions against the in-memory store
npm run verify:both  # the same assertions against DynamoDB Local too
npm run typecheck
```

`verify:both` needs DynamoDB Local running — `npm run ddb:start` launches it
from a JRE, no Docker involved. It is the check worth running before a deploy.

### Web UI

One-time setup:

```bash
npm run web:install
```

Then two terminals — one each, no shell chaining, so this works the same in
PowerShell, cmd and bash:

```bash
npm run api     # terminal 1 — Express + SSE on :3001
npm run web     # terminal 2 — React on :5173
```

Open the URL Vite prints. It is usually http://localhost:5173, but Vite moves to
the next free port if something else is already using it — read the line that
says `Local:`.

Calendar and media library on the left, the agent on the right. Vite proxies
`/api` to the Express server, so the browser sees one origin.

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
  budget.ts         spend cap and per-client rate limit — DEMO_MODE gates it
  server/
    index.ts        Express API — SSE for agent turns, REST for everything else
    sessions.ts     per-conversation agents over one shared store
  lambda/
    handler.ts      the deployed entry point — response streaming, SSE
    router.ts       routing, split out so it is testable without a Lambda
  store/
    types.ts        the ContentStore interface — async even in memory
    rules.ts        the business rules, as pure functions both stores share
    memory.ts       backend validation layer
    dynamo.ts       the same interface over a single DynamoDB table
    conversations.ts one row per message, so a turn cannot blow the item limit
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
    storage.ts      local disk or S3, behind one interface
infra/
  main.tf           the whole stack — DynamoDB, Lambda, S3, CloudFront, budget
```

## Deployment

One Terraform stack, no NAT gateway and no load balancer — both are billed by
the hour whether or not anyone visits, and a portfolio project is idle almost
all of the time. Everything here is billed per request, so an idle month is
cents.

```bash
npm run build:lambda
cd infra && terraform apply
aws ssm put-parameter --name /social-planner/anthropic-api-key \
  --type SecureString --value sk-ant-... --overwrite
```

Then build the UI against the API URL Terraform printed, sync it to the bucket,
and invalidate the distribution — `terraform output next_steps` prints the exact
commands with the real values filled in.

**Lambda response streaming is the load-bearing choice.** A week-long plan
spends ~80 seconds in a single turn writing every caption. API Gateway's
integration timeout is 29 seconds and is not adjustable, so a buffered handler
behind it would be killed mid-turn every time. A Function URL in
`RESPONSE_STREAM` mode has no such ceiling, and the SSE events reach the browser
as they happen instead of arriving in one lump at the end.

That mode is also the sharpest edge in the stack. Left in the default
`BUFFERED` mode, the Function URL parses a streaming handler's output as a
proxy-response JSON: it reads the status line, finds no `body` field, and
returns **HTTP 200 with an empty body** — no error, no failed invocation,
nothing in the logs. See [docs/SERVERLESS.md](docs/SERVERLESS.md).

`DEMO_MODE=true` enforces the spend cap, which matters on a public URL: a turn
costs about $0.30 and anyone, crawlers included, can reach it. When the budget
is spent the app stays fully explorable — calendar, captions, approvals and
publishing all work, because none of them touch the model. Only the chat stops.

## The two design rules

**Tools are for what the model cannot know or cannot do.** Reading state,
causing side effects. There is no `generate_caption` tool — captions are the
model's *output*, written in its turn and passed as arguments to
`save_draft_posts`. A generate-tool means the LLM calling a tool that calls an
LLM: double the cost, and a caption written without knowledge of the rest of the
week.

**The human gate is a type error, not an instruction.** There is no
`approve_post` tool. `/approve` calls the store directly, bypassing the agent —
as the React button hits an HTTP endpoint rather than going through the model.
"Never schedule without approval" is enforced by a status check in backend code,
not by a line in a prompt that a long context could erode.

## Parity testing found bugs a single store would not have

`ContentStore` is an interface with two implementations, and every method is
async **including in the memory store**, where nothing awaits anything.
Pretending otherwise would have been more honest to the in-memory code and
impossible to implement over a database — the signature has to be shaped by the
harder of the two backends, or the second one is a rewrite.

The business rules live in `store/rules.ts` as pure functions rather than in
either store, because two copies of a rule are two rules, and they drift.

The payoff was concrete. One assertion — *cancelling a scheduled post drops the
timer* — failed against DynamoDB while passing against memory. A database
transaction rolls back its own rows, but the scheduler's timers live outside
that transaction, so a rolled-back cancel left a timer that would still fire.
The memory store had the same class of bug, found earlier and fixed with
compensating actions; the DynamoDB fix looked equivalent and was not, because
it never persisted the restored `scheduleId`.

That is the entire argument for running one suite against both: the second
implementation is where assumptions the first one let you keep become visible.
