# Serverless, and what it actually costs

Short version: **yes**, and AWS will cost roughly **$1–3 a month** for a
portfolio project. The Anthropic API will cost more than all of AWS combined,
by about two orders of magnitude.

---

## 1. The one thing that breaks

A planning turn takes ~80 seconds. That is fatal to the obvious serverless
shape:

| Path | 80-second stream? |
|---|---|
| API Gateway REST/HTTP → Lambda (buffered) | **No** — 29-second integration timeout, hard |
| **Lambda Function URL, `RESPONSE_STREAM`** | **Yes** — no API Gateway in the path, up to Lambda's 15-minute ceiling |
| API Gateway → Lambda, response streaming | Yes — 5-minute *idle* timeout on regional endpoints (30s on edge-optimised) |

Response streaming exists specifically to get past the 29-second limit. Either
of the bottom two works; the Function URL is simpler and has no idle timeout to
reason about.

The 15-second heartbeat already in `src/server/index.ts` matters here — on the
API Gateway path it is what keeps a 5-minute *idle* timer from firing during the
long stretch where the model emits nothing.

---

## 2. The architecture

```
                    CloudFront
                   ┌────┴────┐
                   │         │
              S3 (React)   Lambda Function URL
                             RESPONSE_STREAM
                             ┌──┴──────────────┐
                             │                 │
                        DynamoDB          Anthropic API
                     (single table)
                             │
                    SSM Parameter Store
                     (Meta tokens)

  S3 (media) ──> CloudFront ──> public URLs Meta can fetch

  EventBridge Scheduler ──> SQS ──> Publisher Lambda ──> Meta Graph API
```

No VPC. That is a deliberate cost decision — see §4.

---

## 3. What it costs

Assume a portfolio project: ~200 planning turns a month, a few hundred media
files, a handful of viewers.

| Service | Usage | Cost |
|---|---|---|
| Lambda (API) | 200 turns × 80s @ 512MB = 8,000 GB-s | **$0** — free tier is 400,000 GB-s/month |
| Lambda (publisher) | a few hundred short invocations | **$0** |
| DynamoDB on-demand | thousands of reads/writes, <1GB | **~$0.01** — 25GB storage always free |
| S3 (media + React) | <1GB | **~$0.02** |
| CloudFront | <1GB out | **$0** — 1TB/month always free |
| EventBridge Scheduler | a few hundred schedules | **$0** — 14M free |
| SQS | a few hundred messages | **$0** — 1M free |
| SSM Parameter Store | a few SecureStrings | **$0** |
| CloudWatch Logs | with 7-day retention | **~$0.50** |
| **AWS total** | | **~$1/month** |
| **Anthropic API** | 200 planning turns × ~$0.30 | **~$60/month** |

**The model is the bill.** Lambda's free tier alone covers about **10,000
planning turns a month** — at which point you would have spent $3,000 on
Anthropic. Optimising AWS here is optimising the wrong number.

If cost matters, the levers are in the agent, not the infrastructure:
`MODEL_EFFORT=medium` is ~23% fewer output tokens; prompt caching is already
saving ~66,000 cached tokens per turn; two-phase planning avoids writing copy
nobody asked for.

### The honest caveat

Lambda bills wall-clock time, and roughly 78 of those 80 seconds are spent
*waiting on the Anthropic API*, not computing. Paying for idle is the classic
serverless anti-pattern.

At this scale it costs about **$0.0007 per turn**, so it does not matter. It
would matter at thousands of concurrent users, and the fix then is to stop
holding the connection: enqueue the turn, return immediately, and push results
over WebSockets. That is a real trade — it costs you the streaming UX — and it
is not worth making until the numbers say so.

---

## 4. What NOT to build, and why

This is where serverless projects actually get expensive. Every item below is a
fixed monthly charge that runs whether anyone visits or not:

| Component | Cost | Use instead |
|---|---|---|
| **NAT Gateway** | **~$32/month** + data processing | No VPC at all |
| RDS (even db.t4g.micro) | ~$13/month | DynamoDB |
| Application Load Balancer | ~$16/month | Function URL or API Gateway |
| ECS Fargate, always on | ~$9–30/month | Lambda |
| Secrets Manager | $0.40 per secret/month | SSM Parameter Store SecureString — free |

**The NAT Gateway is the trap.** It appears the moment you put a Lambda in a VPC
to reach RDS, and it is billed hourly forever. Choosing DynamoDB (reached over
the public endpoint with IAM auth, no VPC) avoids the VPC entirely and takes
both the NAT and the RDS charge to zero.

A naive "ECS + RDS + ALB + NAT" version of this app costs **$80–100/month idle**.
The serverless version costs about **$1**. That contrast is worth being able to
explain in an interview — it is a design decision, not a preference.

Two more that quietly add up:

- **CloudWatch Logs retention defaults to "never expire."** Set 7 days or logs
  become your largest AWS line item.
- **Set a Lambda reserved concurrency cap.** A runaway loop against a
  pay-per-token API is a much worse bill than any AWS charge.

---

## 5. What has to change in the code

Less than it looks, because the seams already exist.

| Piece | Now | Serverless |
|---|---|---|
| Content store | `MemoryStore` | `DynamoStore`, same methods |
| Conversations | in-process `Map` | DynamoDB — Lambda is stateless |
| Scheduler | `MockScheduler` | `EventBridgeScheduler` — the interface exists |
| Connector | `MockMetaConnector` | `MetaConnector` — the interface exists |
| Media storage | `LocalMediaStorage` | `S3MediaStorage` — the interface exists |
| Tokens | `MockTokenProvider` | SSM Parameter Store |
| HTTP | Express | one Lambda handler, `streamifyResponse` |

Four of those seven are already interfaces with a mock behind them, which is
exactly what they were built for.

**The one genuinely new piece is persisting conversations.** Lambda holds no
state between invocations, so message history has to be written to DynamoDB and
re-read each turn. Prompt caching still works across that — the cache is keyed
on the prefix, not the process.

**Do not port Express to Lambda with an adapter.** Response streaming needs
`awslambda.streamifyResponse`, which does not compose cleanly with Express
middleware. With ~10 routes, hand-rolled routing in the handler is smaller and
clearer than the adapter would be.

### Single-table DynamoDB sketch

    PK                      SK                     entity
    USER#u1                 PROFILE                business profile
    USER#u1                 CONN#meta001           connection (tokenRef only)
    USER#u1                 CHAN#ig001             channel
    USER#u1                 ITEM#abc               content item
    ITEM#abc                VAR#xyz                variant
    USER#u1                 ASSET#123              media asset
    SESSION#s1              MSG#0001               conversation turn

    GSI1: variants by status and scheduled time, for the publisher sweep

---

## 6. Order to build it

1. **`DynamoStore`** behind the existing store interface, plus conversation
   persistence. The biggest piece, and entirely local — test it with DynamoDB
   Local before touching AWS.
2. **Lambda handler** with `streamifyResponse`, replacing Express.
3. **Terraform**: Lambda, Function URL, DynamoDB, S3, CloudFront, IAM.
4. **`S3MediaStorage`** and the CloudFront URL that Meta will fetch from.
5. **EventBridge Scheduler + SQS + publisher Lambda.**
6. **GitHub Actions**: typecheck, verify, build, `terraform apply`.

Steps 1–2 are local work with no AWS account involved. Step 3 is where the CV
value is.
