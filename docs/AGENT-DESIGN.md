# Agent Design

This document supersedes the "thin agent loop" framing in the first draft of
ARCHITECTURE.md. That framing was scoped to a single operation — "generate a
content plan" — which genuinely is a workflow. The actual product described in
`context.md` is broader, and it is genuinely an agent.

---

## 1. What makes this a real agent

An agent, concretely, is: **an LLM that decides which actions to take, in what
order, based on state it inspects at runtime — looping until the goal is met.**

Four properties move this product across that line:

| Property | How it shows up here |
|---|---|
| **Inspects state before acting** | Must read existing scheduled posts before planning, or it generates five near-identical promotional posts |
| **Branches on what it finds** | "Instagram isn't connected, so I can prepare the Reel but cannot schedule it" is a runtime decision, not a fixed code path |
| **Multi-turn over persistent state** | "Make Wednesday funnier" then "approve Monday and Friday" — each turn acts on state the previous turn created |
| **Causes gated side effects** | Scheduling and publishing are irreversible and external |

A single call that emits a calendar has none of these. The full product has all
four. It is one agent with a persistent tool surface, not a pipeline.

---

## 2. The tool surface

### The rule that decides what becomes a tool

> **Tools are for what the model cannot know or cannot do** — reading state it has
> no access to, or causing effects outside the conversation.
>
> **Generation is output, not a tool.**

This is the one significant design change from `context.md`, and it matters
enough to be explicit about.

`context.md` proposes `generate_content_ideas()`, `generate_caption()`, and
`generate_hashtags()` as tools. Implemented literally, that means **the LLM calls
a tool whose implementation calls an LLM**. Consequences:

- **Double cost and latency.** Every caption becomes a second round trip with its
  own prompt, its own tokens, its own network hop.
- **Loss of coherence.** A standalone caption generator doesn't know the week's
  strategy, what Monday already said, or that Friday repeats a pillar. Coherence
  across a calendar is the main thing a *planner* offers over a caption
  generator, and this design discards it.
- **Nothing gained.** There is no state to read and no side effect to gate. The
  tool wraps a capability the model already has.

The model writes captions **in its turn** and passes them as *arguments* to a
persistence tool — one call, full context, everything validated on the way in:

    save_draft_posts([
      { platform, scheduledFor, contentType, hook, caption, hashtags, cta, rationale },
      ...
    ])

Generation is the model's output. The tool persists it. That keeps the calendar
coherent and halves the token bill.

*(There is a legitimate version of "generation as a tool" — delegating to cheaper
sub-agents for parallel drafting at volume. That is a scale optimisation, not an
MVP pattern, and it trades away the same coherence.)*

### The actual tools

| Tool | Kind | Gated | Why it exists |
|---|---|---|---|
| `get_business_profile` | read | no | Voice, audience, goals. Model can't know it. |
| `get_connected_accounts` | read | no | Which platforms are live, plus the capability matrix for each |
| `get_scheduled_posts` | read | no | Prevents repetition and clashes. The tool that makes it a *planner*. |
| `save_draft_posts` | write | no | Persists generated content as DRAFT. Reversible. |
| `update_post` | write | no | "Make Wednesday funnier." Reversible. |
| `cancel_post` | write | no | Reversible. |
| `request_approval` | write | no | DRAFT to PENDING_APPROVAL. The agent's ceiling. |
| `schedule_post` | write | **yes** | Irreversible and external. Backend-validated. |

There is no `approve_post` and no `publish_now`. That is deliberate — see §4.

---

## 3. How a run actually works

**User:** *"Plan next week's content for my coffee shop."*

    get_business_profile()          -> tone, audience, goals, frequency
    get_connected_accounts()        -> [instagram: connected, caps{post,reel,story}]
    get_scheduled_posts(next 7d)    -> [Mon: promotional, already scheduled]
        |
        v  the model reasons over what it found:
           "Monday is taken by a promotional post, so avoid a second one.
            Instagram supports Reels, so Friday can be a Reel.
            Frequency is 4/week and one slot is used, so plan 3."
        |
    save_draft_posts([ 3 posts, captions written in this same turn ])
        |
        v
    "I've drafted three posts. Wednesday is educational, Friday is a Reel,
     Sunday is behind-the-scenes. Want to review them?"

**User:** *"Make Wednesday more humorous, and give me two options for Friday."*

    update_post(wed_id, { caption: ... })
    save_draft_posts([ friday_variant_a, friday_variant_b ])

**User:** *"Approve Monday and Friday, schedule them for 7pm."*

    request_approval([mon_id, fri_id])   -> status: PENDING_APPROVAL

The agent **stops here**. It cannot approve. The UI now shows an approval control;
a human clicks it, which is an authenticated HTTP request from the browser — not a
tool call. Only after that:

    schedule_post(mon_id, "2026-09-15T19:00", idempotencyKey)

---

## 4. Human-in-the-loop is enforced by the state machine, not the prompt

`context.md` is right that human approval matters. What it doesn't specify is
*where the gate lives*, and that is the whole ballgame.

A prompt instruction — "never publish without approval" — is a **request**. It
holds until a long context, an edge case, or text injected through a business
profile talks the model out of it.

Make it structurally impossible instead:

    DRAFT --agent--> PENDING_APPROVAL --HUMAN ONLY--> APPROVED
                                                         |
                                                  agent -+
                                                         v
                                                     SCHEDULED --> PUBLISHED
                                                                      |
                                                          FAILED / CANCELLED

- The agent has **no tool** that writes `APPROVED`. Not a restricted tool — no tool.
- `schedule_post` rejects any post not already `APPROVED`, in backend code, before
  any I/O.

The guarantee then rests on a type system and a database constraint rather than on
the model's compliance. That is the difference between "the agent is instructed
not to" and "the agent cannot."

---

## 5. The backend validation layer

Every write tool passes through the same gate before touching anything.
`context.md` §12 is correct on this; below is the concrete checklist:

    schedule_post(postId, scheduledAt, idempotencyKey)
      |
      +- Does this post exist and belong to the authenticated user?  -> 403
      +- Is status == APPROVED?                                      -> 409
      +- Is the platform still connected and the token unexpired?    -> 409
      +- Does the platform support this content type? (capability matrix)
      +- Is scheduledAt in the future and within provider limits?    -> 400
      +- Has this idempotencyKey been seen before?    -> return the prior result
      +- Commit, then create the EventBridge one-time schedule

**The agent supplies intent. The backend decides authority.** The model never
holds a token, never issues a query, and never reaches a social API directly.

### Idempotency is not optional

Missing from `context.md`, and it prevents the worst failure this product has:
**a retry that double-posts to a customer's real account.**

Agent loops retry. SQS redelivers. Lambdas time out *after* the side effect
landed. Every publish carries a key derived from `(postId, scheduledAt)`, checked
with a conditional write before the API call, so a replay returns the original
result instead of posting twice.

### Untrusted input reaches this agent

Also missing, and directly relevant to tool design. The agent reads the business
profile (user-authored), existing captions (user-edited), and — once web research
is added — arbitrary web pages. All of it is **data, never instructions**.

The mitigation is already in the architecture, which is the point of noting it:
the agent has no tool that can approve or publish, so the worst a successful
injection achieves is a bad draft that a human then declines. The defence is the
tool surface, not a filter.

---

## 6. Provider choice: a correction to `context.md`

`context.md` recommends Amazon Bedrock for the AWS CV angle. The reasoning is
sound, but it carries a concrete cost that should be a deliberate choice:

| Feature | Anthropic API | Claude Platform on AWS | Bedrock |
|---|---|---|---|
| Messages, tool use, streaming | Yes | Yes | Yes |
| Structured outputs | Yes | Yes | Yes |
| Prompt caching | Yes | Yes | Yes |
| **Web search (server-side)** | Yes | Yes | **No** |
| Server-side refusal fallbacks | Yes | Yes | No |
| Files / Batches APIs | Yes | Yes | No |

**Web search is not available on Bedrock.** Trend research — a genuinely useful
feature here — would have to be reimplemented as a client tool over Tavily, Brave,
or SerpAPI. A real cost, not a blocker.

Also worth knowing: **Claude Platform on AWS** is Anthropic-operated with same-day
feature parity and keeps web search. It is an AWS-billed path that doesn't forfeit
capability.

**Recommendation:** build against the first-party client behind a one-line
provider seam. The SDK exposes `AnthropicBedrockMantle` with the *same*
`messages.create` surface, so moving is a client-construction change, not a
rewrite:

    const client = process.env.LLM_PROVIDER === "bedrock"
      ? new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION })
      : new Anthropic();

You develop fast on first-party, and can still truthfully write "deployed on
Amazon Bedrock with IAM-scoped access" on the CV — having made the tradeoff
knowingly rather than by accident.
