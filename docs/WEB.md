# Web UI

React + Vite + Tailwind on :5173, Express on :3001. Vite proxies `/api`, so the
browser sees a single origin and there is no CORS or cookie trouble in dev.

## Why an API layer exists at all

React cannot call a TypeScript class in a Node process. The agent module is
unchanged — it just gained a transport. Everything in `src/server/` is thin:
every rule about who may approve what already lives in the store, so the HTTP
layer only does transport and error-code translation.

## The 80-second problem

A planning turn takes about 80 seconds. Output runs at a fixed ~75 tokens per
second, so that cannot be shortened — and it is far past the point where a plain
request/response gets killed by a proxy (API Gateway's ceiling is 29 seconds,
hard).

So the turn arrives as **Server-Sent Events**:

    event: tool       {"name":"get_calendar"}
    event: thinking   {"delta":"Monday already has the cold brew..."}
    event: writing    {}
    event: text       {"delta":"Three drafts are in"}
    event: done       {"text":"...","usage":{...}}

The agent's existing callbacks map onto these one-for-one. Two details that
matter in production: `X-Accel-Buffering: no`, without which nginx buffers the
whole stream and delivers it at the end — indistinguishable from a hang — and a
15-second heartbeat, because the model emits nothing visible for long stretches
while writing tool arguments.

On AWS this wants ALB + Fargate or Lambda response streaming. Plain API Gateway
will cut it off.

## Where the human gate lives

Two routes deliberately do not go through the agent:

    POST /api/variants/:id/approve   the Approve button
    POST /api/publish/run            stands in for the scheduler firing

They call the store directly. There is no tool that reaches this code, so the
agent cannot approve or publish its own work — a fact about the system, not a
promise in a prompt. It is visible in the browser's network tab, which makes it
easy to demonstrate.

## Layout

    ┌──────────────────────────────┬──────────────────┐
    │ Calendar | Media             │ Agent            │
    │                              │                  │
    │ idea                         │ → get_calendar   │
    │   Instagram REEL  [Approve]  │ thinking… 12s    │
    │   Facebook  REEL  [Approve]  │ writing… 47s     │
    └──────────────────────────────┴──────────────────┘

Ideas nest their per-channel variants, because that is the data model: one idea,
two adapted versions, approved separately since the words differ.

Uploading a photo runs the vision pass server-side and shows the description
that comes back — the most direct way to see the model actually looked.

## Known limitations

- **Conversations live in process memory.** They die on restart and would not
  survive a second instance. Persisting message history to the database is the
  fix, and is worth doing before deploying rather than now.
- **No auth.** Every request acts as the demo user. Real auth replaces the
  hardcoded `USER_ID` with a session claim — the store already takes `userId` on
  every call, so nothing below the HTTP layer changes.
- **Seeded assets have no file behind them**, so thumbnails 404 and fall back to
  a shape label. Uploaded photos render normally.
