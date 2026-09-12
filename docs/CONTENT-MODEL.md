# Content Model

How the agent handles the real breadth of social media work: cross-posting,
Reels and Stories, rescheduling, and campaigns.

The structural flaw this document set out to fix — conflating content and
platform, which `context.md` §4 identified — is now **fixed**. §1 below describes
what was built; later sections remain the design for what has not been.

---

## 1. The core change: ContentItem and PostVariant

Today a `Post` *is* a platform plus a caption. So "put this on Instagram and
Facebook" produces two unrelated rows. Then "make it funnier" has no good answer —
edit which one? Both? They drift apart immediately, and there is nothing in the
data that says they were ever the same idea.

`context.md` §4 is right: separate the idea from its platform realisations.

    ContentItem                  the idea. platform-independent.
      id, campaignId?, pillar, topic, coreMessage, mediaConcept,
      contentCategory, status
         |
         +-- PostVariant         one platform realisation
         |     platform, channelId, format, caption, hashtags,
         |     scheduledFor, status, publishedId
         |
         +-- PostVariant
                 ...

What this unlocks:

| User says | What happens |
|---|---|
| "Post this to Instagram and Facebook" | One item, two variants, each written for its platform |
| "Make Friday funnier" | Edit the item, regenerate the variants that descend from it |
| "Drop the Facebook one" | Delete a variant; the idea and its IG version survive |
| "What did we say about cold brew?" | Query items, not a pile of captions |

**Variants are adapted, not duplicated.** The same caption on Instagram and
Facebook is the mark of a lazy scheduler. Instagram gets no clickable links and
carries hashtags; Facebook tolerates links and punishes hashtag stuffing; X needs
compression. The agent's job is to write each variant *for its platform* from a
shared idea — which is genuine work, and a good reason for the agent to exist.

---

## 2. Connections and channels — Instagram and Facebook are one login

You are right that people run Instagram and Facebook together. That is not a
convenience we add; it is how Meta's API actually works. One OAuth grant against
the Meta Graph API returns access to both an Instagram Business account and a
Facebook Page.

So "connected accounts" is two levels, not one:

    Connection            one OAuth grant, one token in the vault
      provider: meta | linkedin | tiktok | x
      status: ACTIVE | EXPIRED | REAUTH_REQUIRED
         |
         +-- Channel     one publishable destination
               platform: instagram | facebook
               channelId, handle, capabilities[]

Consequences worth designing for now:

- **One reauth breaks several channels.** A dead Meta token takes Instagram *and*
  Facebook down together. The UI must say "Reconnect Meta", not "Reconnect
  Instagram", or the user reconnects twice and is still broken.
- **The agent addresses channels, never platforms.** `channelId` is what goes in
  a variant, because a user can have two Facebook Pages.
- **Capabilities live on the channel.** An Instagram *Business* account can
  publish Reels via the API; a personal account cannot. Same platform, different
  capability — so the matrix cannot be keyed by platform name alone.

---

## 3. Formats: Post, Reel and Story are not one field with three values

A flat `contentType` enum is what we have and it is not enough, because each
format needs *different fields to be valid*:

| Format | Requires | Constraints that bite |
|---|---|---|
| **POST** | 1 image | caption limits, hashtag norms |
| **CAROUSEL** | 2-10 images, an order | first card carries the hook |
| **REEL** | video, duration, cover frame, audio | 3-90s; vertical; cover is what people actually see in the grid |
| **STORY** | image or short video, 24h life | no captions in the feed sense; interaction is stickers, polls, links |

A Reel without a duration and a cover concept is not a plannable Reel. Model this
as a **discriminated union on `format`**, so the type system refuses an
under-specified Reel and the agent is told exactly what a Reel needs.

### Stories break the weekly-planning assumption

Posts and Reels are planned ahead. Stories are reactive, daily, and expire in 24
hours — planning ten of them a fortnight out is not how anyone works. Treat them
as a distinct rhythm:

- Plan **story beats**, not story copy: "Tuesday: poll on next week's guest bean".
- Generate the actual story near the time, or on request.
- Never count Stories toward `postsPerWeek` — that cadence is about feed content.

---

## 4. Time: the part that is currently wrong

### Timezone

`scheduledFor` is a naive ISO string today. That is a latent bug. The business is
in Colombo (UTC+5:30); "7pm" means 7pm *there*, and the publisher Lambda runs in
UTC. Store both:

    scheduledFor   instant, UTC, unambiguous
    timezone       on the business profile, e.g. "Asia/Colombo"

Every user-facing time renders in the business timezone; every stored time is UTC.
Fix this before there is data to migrate.

### Rescheduling is not a field update

"Move Wednesday to Friday." "Push everything back a week, we're closed." "Shift
the launch to after the delivery arrives."

For a `DRAFT`, that is a field update. For a `SCHEDULED` post it is not — there is
an EventBridge schedule in existence that must be cancelled and recreated. The
store method has to own that, or the post moves in the database and still fires at
the old time.

Bulk moves deserve their own tool. "Push everything back a week" as seven
`update_post` calls is slow, costly, and partially-applied if it fails halfway.

    reschedule_variants([{ variantId, scheduledFor }, ...])   // atomic

### Approval survives a time change — this is a correction

The current rule revokes approval on *any* edit. That is too strict, and users
will hate it.

The human approved **words**, not a slot in the calendar. So:

| Change | Approval |
|---|---|
| caption, hashtags, media, format, channel | **revoked** — they approved different content |
| `scheduledFor` only | **kept** — same content, different time |

Moving an approved post to Friday should not force a re-approval. Rewriting its
caption absolutely should.

---

## 5. Campaigns

"Promote the new cold brew for two weeks" is not four unrelated posts. It is a
campaign: one goal, one arc, several items building toward it.

    Campaign
      id, name, goal, startDate, endDate, keyMessage
        |
        +-- ContentItem (tease)
        +-- ContentItem (launch)
        +-- ContentItem (proof / social)
        +-- ContentItem (last call)

This gives the agent something to reason about that a flat calendar cannot
express: narrative order, not repeating the same angle, and knowing that the
Thursday post is the payoff of Tuesday's tease. It is also what makes
"promotional posts" coherent rather than four variations of "come buy this".

---

## 6. Long horizons need two phases

"Plan the next month" is 20-30 items. Writing every caption in one turn produces
degrading quality toward the end and a very large response.

Split it:

1. **Plan the calendar.** Slots, dates, pillars, formats, campaign arc, topics —
   no captions. Cheap, fast, and the part the user most wants to review first.
2. **Fill the copy.** In batches, on request, per week or per campaign.

This matches how people actually work — agree the shape of the month, then write
it — and it keeps each model turn inside a sensible context.

---

## 7. The tool surface this implies

Existing tools, revised:

| Tool | Change |
|---|---|
| `get_connected_accounts` | returns connections with nested channels + per-channel capabilities |
| `save_draft_posts` | becomes `save_content_items`, taking items with their variants |
| `update_post` | splits into `update_content_item` (idea) and `update_variant` (one platform's copy) |

New:

| Tool | Purpose |
|---|---|
| `plan_calendar` | phase one — slots and topics, no copy |
| `reschedule_posts` | bulk, atomic time moves; handles SCHEDULED correctly |
| `create_variants` | fan one item out to more channels, adapted per platform |
| `get_campaign` | read a campaign and its items so the agent can extend an arc |

Unchanged, and still the safety boundary: `request_approval`, `schedule_post`,
`cancel_post`. There is still no `approve_post`.

---

## 8. Build order

1. ~~**Timezone on the profile, UTC storage.**~~ **DONE** — offsets required at the
   store boundary; a precomputed calendar is injected per turn so the agent
   knows what "next Monday" means.
2. ~~**Approval scoping** — time-only edits keep approval.~~ **DONE** — and
   editing the shared item revokes approval on every variant beneath it.
3. ~~**ContentItem / PostVariant split.**~~ **DONE** — one idea, many adapted
   channel versions. `save_content`, `add_variants`, `update_content_item`,
   `update_variant`.
4. ~~**Meta scope**~~ **DONE** — Instagram and Facebook only; LinkedIn and TikTok
   removed from the schema rather than left as unsupported options.
5. ~~**Format as a discriminated union**~~ **DONE** — `MediaSpec` in
   `schemas.ts`. A REEL requires duration (3-90s), cover frame, audio and a shot
   list; a CAROUSEL 2-10 cards; a STORY a visual and an interaction. The schema
   rejects an under-specified one rather than trusting the prompt.
6. ~~**`reschedule_posts`**~~ **DONE** as `reschedule_variants` — bulk atomic time
   moves. A `Scheduler` seam (`src/scheduler/`) models the timer that must be
   cancelled and recreated when a SCHEDULED variant moves; `MockScheduler`
   stands in for EventBridge. Rollback compensates scheduler actions, not just
   database rows — restoring the rows alone leaves an orphaned or missing timer.
7. ~~**Campaigns**, then two-phase planning for month-scale requests.~~ **DONE**
   — `create_campaign` / `get_campaign_items`, and `plan_calendar` (slots, no
   copy) followed by `write_slot_copy` in batches.

**All seven are done.** §2 landed too: `ConnectionStore` holds one Meta
connection covering an Instagram and a Facebook channel, content is addressed to
a `channelId` rather than a platform name, and an expired connection correctly
takes both channels down with a "reconnect Meta" message.

What remains is not model work: publishing (`SocialConnector` + a mock
publisher), then real Meta OAuth. See `docs/OAUTH.md`.
