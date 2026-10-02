# Connecting Meta accounts

How a user connects their Instagram and Facebook, what it actually takes, and
what the earlier "app review is slow or denied" warning did and did not mean.

---

## 1. The short version

**Yes — you can do this, and for a portfolio project you do not need Meta's App
Review at all.**

The correction to my earlier framing: App Review only becomes necessary when
*other people* connect their accounts to your app. While your app is in
Development mode, you can publish to accounts that have a role on the app —
which for a portfolio project means your own. That is the standard way these
projects are built and demonstrated.

App Review matters when you want strangers to sign up. That is a product
decision, not a prerequisite for building or demoing this.

---

## 2. Two grants, not one — the correction that matters

This document originally described **one** Meta grant covering both Instagram
and Facebook. That is true of only one of Meta's two auth paths, and not the one
most people can use.

| | Facebook Login | Instagram Login |
|---|---|---|
| Account types | Instagram **Business** only | Business **and Creator** |
| Facebook Page | **Required**, Instagram must be linked to it | Not needed |
| Publishes to | Pages, and Instagram via the Page | Instagram only |
| Permissions | `pages_show_list`, `pages_manage_posts` | `instagram_business_basic`, `instagram_business_content_publish` |

Creator is what an individual account becomes when it goes professional, and it
is **unreachable through Facebook Login**. So the account type decides the auth
path, and the auth path decides what can be published — which means one grant
covering both platforms cannot be assumed.

Hence `Provider` is now `"instagram" | "facebook"` rather than `"meta"`. The
model is better for it: a dead Instagram token no longer takes Facebook down
with it, and `verify.ts` asserts that isolation rather than the old coupling.

**Facebook cannot be a fallback.** The Graph API cannot post to a personal
Facebook profile at all — that was removed years ago. Facebook posting requires
a Page you administer, full stop.

    ┌──────────────────────────────────────────────┐
    │  Connected accounts                          │
    │                                              │
    │  Instagram       ● @brewandbean.lk (Creator) │
    │                  [ Disconnect ]              │
    │  Facebook Page     Not available yet         │
    │                  [ Connect ]  (disabled)     │
    └──────────────────────────────────────────────┘

---

## 2a. Setting up the Meta app

Development mode throughout — no App Review, no business verification.

Meta reorganises this console often, and app creation is now built around **use
cases** rather than app types. If the labels below have drifted again, the thing
to look for is the Instagram use case and, under it, *Instagram login*.

1. **Instagram account** → Settings → *Account type and tools* → switch to
   **Professional**, then Business or Creator. Both publish; personal cannot.

2. **developers.facebook.com** → **My Apps** → **Create app**.

3. Enter an **app name** and **contact email**, and select a **Meta Business
   Portfolio**. A business portfolio is required at creation now — if you have
   none, the dialog offers to make one, which is free.

4. For the use case, choose **"Manage messaging and content on Instagram"**.
   This is the one that carries content publishing; the permissions this app
   needs are added by default with it.

5. Open the **Instagram** product and choose **API setup with Instagram login**.

6. **Take the credentials from THIS screen**, not from *App settings → Basic*.
   There are two different pairs and they are not interchangeable:

   | Where | What | Used by |
   |---|---|---|
   | Instagram product → *API setup with Instagram login* | **Instagram app ID / secret** | Instagram Login — what this app uses |
   | App settings → Basic | Meta app ID / secret | Facebook Login |

   Using the Meta pair for Instagram Login fails at the token exchange with an
   error that blames the code rather than the credentials, so it is worth
   checking twice.

7. In the same section, under **business login settings**, add the **OAuth
   redirect URI**:

       https://<your-function-url>/api/connect/instagram/callback

   Exactly — scheme, host, path, no trailing slash. A mismatch is rejected
   before the user ever reaches a consent screen.

8. Add your Instagram account as a tester, and accept the invite from the
   notifications in the Instagram app itself.

Then put the secrets where the Lambda reads them:

```bash
aws ssm put-parameter --name /social-planner/oauth/instagram-app-secret   --type SecureString --value <instagram app secret> --overwrite

# Signs the OAuth state. Any long random string; it never leaves the server.
aws ssm put-parameter --name /social-planner/oauth/oauth-state-secret   --type SecureString --value "$(openssl rand -base64 32)" --overwrite
```

and set `instagram_app_id` in Terraform (the ID is not a secret; the secret is).

---

## 3. The flow, concretely

    USER clicks "Connect Meta"
      │
      ▼
    Your backend redirects to Facebook's OAuth dialog
    (app id + redirect URI + requested scopes)
      │
      ▼
    USER logs in at facebook.com and approves
      │
      ▼
    Facebook redirects back with ?code=...
      │
      ▼
    Your backend exchanges code -> short-lived token
      │                        -> long-lived token (~60 days)
      ▼
    Store the token in Secrets Manager; keep only the REFERENCE in the database
      │
      ▼
    Call the Graph API to discover the Pages and the linked
    Instagram Business account
      │
      ▼
    Write one Connection + two Channel rows

The last two steps are the ones people forget. The token alone is not enough —
you still have to ask Meta which Page and which Instagram account it grants you,
and those ids become your channels.

---

## 4. Hard requirements you cannot design around

| Requirement | Why it bites |
|---|---|
| **Instagram must be a Business or Creator account** | Meta's publishing API does not work with personal accounts at all. There is no workaround. The `accountType: "PERSONAL"` branch in `connections.ts` exists for exactly this. |
| **The Instagram account must be linked to a Facebook Page** | The grant is a Page grant; Instagram publishing rides on it. |
| **HTTPS redirect URI** | Even in development. `localhost` is permitted for testing. |
| **Privacy policy URL** | Required on the app before it leaves development mode. |
| **Rate limits** | 100 API-published posts and 400 media containers per Instagram account per rolling 24 hours. Your scheduler must respect this, not discover it. |

Permissions to request (verify current names against Meta's docs before
implementing — they rename these periodically):

- `instagram_business_basic` — read the account
- `instagram_business_content_publish` — publish to it
- `pages_show_list` — discover which Pages the user has
- `pages_manage_posts` — publish to a Page

---

## 5. Publishing is two calls, not one

Worth knowing before building the connector, because it shapes the interface:

    POST /{ig-user-id}/media           -> returns a creation_id (a container)
    POST /{ig-user-id}/media_publish   -> publishes that container

Videos and Reels are slower: the container has to finish processing before it
can be published, so the connector has to poll its status. That is a real
argument for publishing from a queue worker rather than inside a request.

This maps cleanly onto the existing design — the publisher Lambda drains SQS,
creates the container, polls, publishes, then writes `PUBLISHED` with the
platform's post id. The idempotency key already in `schedule_variant` is what
stops a redelivered message from posting twice.

---

## 6. Two modes, and which one you need

| | Development mode | Live mode |
|---|---|---|
| Who can connect | Only accounts with a role on your app (admin, developer, tester) | Anyone |
| App Review needed | **No** | Yes, per permission |
| Business verification | No | Yes — legal entity documents |
| Time to set up | An afternoon | 2-4 weeks per submission, and it can come back rejected |
| Good for | Building, demoing, a portfolio, screenshots, a video walkthrough | A real product with real customers |

**For this project, development mode is the right answer.** Add your own
Instagram Business account as an Instagram Tester, accept the invite, and the
full flow works end to end — real OAuth, real tokens, real published posts.

A recruiter looking at the repo cannot tell the difference, and the architecture
is identical either way. Going Live is a checkbox plus paperwork, not a rewrite.

---

## 7. Where the token lives

The rule the code already enforces:

> No access token ever leaves `ConnectionStore`. The agent sees handles,
> formats and limits — never a token, never a `tokenRef`, never a
> platform-side id.

```
DynamoDB                          Secrets Manager
─────────────────────────         ─────────────────────
Connection                        the actual tokens
  id, userId, provider              access_token
  status                            refresh_token
  tokenRef  ──────────────────────> (encrypted via KMS)
  scopes, expiresAt
```

The database never holds a token. It holds a pointer. The publisher resolves
that pointer at the moment of publishing and never logs the result.

`ChannelSummary` is the type that enforces the boundary — it is the only shape
the agent can read, and there is an assertion in `verify.ts` proving nothing
sensitive survives the conversion.

---

## 8. When the token expires

Long-lived Meta tokens last around 60 days and must be refreshed before then. A
token that dies takes **both** channels with it, because they share one grant.

    Publisher -> Graph API -> 401
      │
      ▼
    Try refresh
      │
      ├── success -> publish, store the new token
      │
      └── failure -> Connection.status = REAUTH_REQUIRED
                     notify the user
                     the agent now refuses to schedule, saying "reconnect Meta"

That last line already works: `isPublishable` returns a message naming the
*provider*, not the platform, because telling someone to "reconnect Instagram"
sends them round the loop twice and leaves them still broken.

---

## 9. Build order

1. ~~**`SocialConnector` interface + `MockConnector`.**~~ **DONE** —
   `src/connectors/` and `src/publisher.ts`. The loop now runs end to end:
   draft → approve → schedule → publish, with typed failure policy (AUTH,
   RATE_LIMIT, TRANSIENT, PERMANENT) and an AUTH failure correctly marking the
   whole connection REAUTH_REQUIRED.
2. **Meta app in development mode**, your own accounts as testers. Real OAuth,
   real tokens, real posts.
3. **`MetaConnector`** implementing the same interface — container creation,
   status polling, publish.
4. **Token refresh and the REAUTH_REQUIRED path.**
5. *Optional, and only if real users need it:* business verification and App
   Review.

Steps 1-4 are entirely within your control and need nobody's approval. Step 5 is
the only one that depends on Meta, and it is not required for the project to be
complete or demonstrable.
