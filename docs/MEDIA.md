# Media: letting the agent see

Your idea — users upload photos and videos, the agent looks at them and decides
what becomes a post and what becomes a story — is a good one, and it changes the
product in a specific way worth naming.

---

## 1. What it changes

Today the agent writes a **prescription**:

    mediaConcept: "Close-up of cold brew poured over a single large ice cube."

That is an instruction to a human: *go and shoot this*. Useful, but it means the
caption is written about a photo that does not exist yet, and may never match.

With real assets the arrow reverses. The agent writes a **description** of
something that exists:

    asset: img_8842  (the shot of the roaster mid-drop, 4:5, taken Tuesday)
    caption: "6:40am. Nobody here yet except the drum."

The caption can now refer to what is actually in the frame. That is a real
quality jump, and it is only possible because Claude can genuinely look at
images — this is not metadata matching, it is the model seeing the photo.

It also lets the agent make the decision you described: a 9:16 clip is a Reel or
a Story, a set of five stills is a Carousel, a single 4:5 frame is a feed post.
Format follows the asset instead of the asset being commissioned to fit a format.

---

## 2. The cost trap, and the rule that avoids it

The obvious implementation — hand the agent every image on every turn — is
ruinous. A photo costs roughly 1,500 tokens. A library of fifty is ~75,000
tokens **per turn**, which would take a $0.30 planning run to something like $5
and slow it down badly.

The rule:

> **Look once, at upload. Search descriptions, not pixels. Re-open an image only
> when a decision actually depends on it.**

So:

    UPLOAD
      │
      ▼
    Store the file (S3), generate a thumbnail
      │
      ▼
    ONE vision call: describe it, tag it, note orientation and what is in frame
      │
      ▼
    Save that description alongside the asset
      │
      ▼
    The agent searches DESCRIPTIONS when planning — cheap, text only
      │
      ▼
    It opens the actual image only to choose between close candidates
      │      or to write a caption that turns on a visual detail

Describing at upload also means the work is done once per asset rather than once
per planning run, and it happens when the user is already waiting for an upload
to finish.

---

## 3. What Claude can and cannot see

Worth being straight about, because it shapes the build:

| | Reality |
|---|---|
| **Images** | Genuinely seen. Composition, subject, text in frame, mood, quality. |
| **Video** | Not watched. There is no video input. |

For video you extract frames — the first frame, a few keyframes, the intended
cover — and describe those. That is enough to pick a cover frame and write a
caption, which is what this product needs. It is not enough to judge pacing or
audio, so the agent should say so rather than pretend.

This is worth handling explicitly rather than letting the agent quietly reason
about a video it cannot see.

---

## 4. Validation the agent should not have to remember

Once assets are real, several things become checkable in code rather than hoped
for in a prompt — which is the same move as the format union:

| Check | Why |
|---|---|
| Aspect ratio vs format | Reels and Stories are 9:16. A landscape photo in a Reel slot is wrong before anyone reads the caption. |
| Carousel card count | 2-10 assets, and they must all exist. |
| Video duration vs format | Reels 3-90s; Stories cap around 15s per card. |
| Asset belongs to this user | Same ownership rule as everything else. |
| Asset still exists | Deleted between planning and publishing is a real failure. |

The store already refuses an under-specified Reel. This extends the same idea:
**refuse a Reel whose chosen asset is the wrong shape.**

---

## 5. One practical constraint for publishing

Meta's publishing API does not take bytes. You give it a **publicly reachable
URL** and it fetches the media itself:

    POST /{ig-user-id}/media   { image_url: "https://...", caption: "..." }

So the pipeline is: upload to S3 → serve via CloudFront (or a presigned URL with
a lifetime longer than the publish window) → pass that URL to Meta. Assets
cannot live only in a private bucket the publisher reads into memory.

Worth designing in now, because it affects bucket policy and the connector's
signature.

---

## 6. Proposed shape

```ts
MediaAsset {
  id, userId
  kind: "IMAGE" | "VIDEO"
  mimeType, bytes
  width, height, aspectRatio      // drives format validation
  durationSeconds?                // video only
  storageRef                      // S3 key
  publicUrl                       // what Meta will fetch
  thumbnailRef

  // Written once, by a vision pass at upload time.
  description: string             // what is actually in the frame
  tags: string[]                  // searchable: "roaster", "latte art", "people"
  dominantColours?: string[]
  hasTextInFrame?: boolean        // IG penalises heavy text overlays

  uploadedAt, lastUsedAt
}
```

`VariantDraft.media` gains asset references alongside the concept, so both modes
work:

- **No assets yet** → `imageConcept` as today: a brief for a shoot.
- **Assets available** → `assetIds`, and the concept becomes optional.

Keeping both matters. Planning a month ahead legitimately has no photos yet; the
prescription mode is not a workaround, it is half the product.

### Tools

| Tool | Purpose |
|---|---|
| `list_media_assets` | Search by tag, kind, orientation, date. Returns descriptions — no image data. |
| `get_media_asset` | One asset in full. Optionally returns the image itself for a close look. |
| `suggest_format_for_asset` | Optional. Given an asset, what formats does its shape allow? |

`list_media_assets` returning descriptions rather than images is the whole cost
strategy in one design decision.

---

## 7. Build order

1. ~~**Asset model + upload.**~~ **DONE** — `src/media/`, `src/store/media.ts`.
   Dimensions are read from the file header, so no image library is needed.
2. ~~**Vision pass at upload.**~~ **DONE** — `describe.ts`, on Haiku 4.5. One
   call per asset, at upload, never per planning turn.
3. ~~**`list_media_assets` / `get_media_asset`.**~~ **DONE** — search returns
   descriptions only; `includeImage: true` returns the actual picture as an
   image block, for when a decision genuinely turns on seeing it.
4. ~~**Asset-aware validation.**~~ **DONE** — aspect ratio vs format, asset
   counts per format, video duration, ownership, and a public URL requirement.
5. **Video frame extraction** (ffmpeg) so uploaded videos get described too.
   Seeded videos carry `describedFrom: "VIDEO_FRAME"` already.
6. ~~**Public URLs** wired through to the connector, once storage is real S3.~~
   **DONE** — `S3MediaStorage` writes to the media bucket and returns a URL that
   genuinely resolves, which is what a real connector needs: Meta does not take
   media bytes on publish, it takes an address and fetches it.

Steps 1-4 and 6 are done. 5 still needs ffmpeg rather than more design.

`LocalMediaStorage` remains, for development. It is not a fallback in Lambda:
/var/task is read-only, so disk writes there fail with EROFS, and /tmp is
per-container and discarded. `MEDIA_BUCKET` selects between them.

---

## 8. Where this sits against everything else

This is genuinely valuable and genuinely optional. The agent is complete without
it: it plans, writes, revises, schedules and publishes.

What media adds is the difference between *"shoot a close-up of the cold brew"*
and *"use the shot from Tuesday where the ice hasn't melted yet"*. That is a
better product — but it is also a second system (storage, thumbnails, a vision
pipeline, CDN URLs) sitting alongside the agent rather than inside it.

If the goal is a portfolio piece, the honest sequencing question is whether the
next thing should be **media** or the **React UI**. A UI makes everything already
built visible; media makes it better but stays invisible without one.
