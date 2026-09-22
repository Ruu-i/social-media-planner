# Getting a public URL

You do not need to buy a domain to put this on the internet. AWS hands you two
working HTTPS URLs for free, and a custom domain is a DNS change you can make
weeks later without touching anything else.

---

## 1. Why not Netlify

Netlify is a good host and the wrong one for this app, for one measurable
reason:

| | Limit |
|---|---|
| Netlify streaming function | **60 seconds** |
| Netlify regular function | 10 seconds |
| This app's planning turn | **~80 seconds** |

A week-long plan spends ~80 seconds in a single turn writing every caption as
tool arguments, at a fixed ~75 tokens per second. Netlify would cut the
connection mid-turn, every time, on the exact feature the demo exists to show.

Lowering `MODEL_EFFORT` to `medium` brings a turn to ~60 seconds — which is
not a margin, it is a coin flip.

Netlify could host the React build perfectly well. It cannot host the agent.

---

## 2. The two free URLs you already get

Neither needs a domain, and both are HTTPS:

```
UI    https://d1a2b3c4d5e6f7.cloudfront.net
API   https://abc123xyz.lambda-url.us-east-1.on.aws/
```

**Lambda Function URLs** are a first-class public endpoint — they are how the
streaming path works at all, and they come with a certificate. **CloudFront**
gives the React build its own HTTPS address.

They are ugly, and they are shareable today. For a CV link, `followfav.me`
reads better — but an ugly URL that works now beats a pretty one that waits on
a purchase.

---

## 3. Adding the domain later costs nothing built

When you do buy it:

1. Request an ACM certificate for the domain, **in us-east-1** — CloudFront
   only accepts certificates from that region, whatever region the rest of the
   stack runs in.
2. Add the domain as an alternate name on the CloudFront distribution.
3. Point DNS at CloudFront — Route 53 (~$0.50/month) or your registrar's free
   DNS with a CNAME.

Three steps, all configuration. No code changes, no redeploy of the Lambda, no
rebuild of the front end. The application never learns its own hostname.

---

## 4. One thing to decide before going public

`DEMO_MODE=true` turns on the spend cap. Without it the daily budget and the
per-client rate limit are recorded but not enforced, which is right locally and
wrong on a public URL.

The failure mode it prevents is specific: an agent turn costs about $0.30, and
a public URL is reachable by anyone including crawlers. Fifty curious visitors
is $15 in an afternoon.

With it on, a spent budget still leaves a fully explorable app — the calendar,
captions, approvals and publishing all work, because none of them touch the
model. Only the chat stops.
