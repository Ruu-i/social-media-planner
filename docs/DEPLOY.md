# Deploying to AWS

Target: a live, custom-domain demo that costs about **$1 a month** and cannot
run away with your money.

---

## 1. Use Bedrock — and not as a concession

The interview question "why didn't you use Bedrock?" has a much better answer
than a justification: **use it, and show the seam that made it a one-line
change.**

The code already has that seam:

```ts
const client = process.env.LLM_PROVIDER === "bedrock"
  ? new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION })
  : new Anthropic();
```

Same `messages.create` surface, same model, same price ($5/$25 per MTok). On
Bedrock the model id gains a prefix: `anthropic.claude-opus-5`, or a geo
inference profile such as `us.anthropic.claude-opus-5`.

Three reasons Bedrock is genuinely the better choice *for this deployment*:

**There is no API key to store.** The Lambda's execution role carries
`bedrock:InvokeModel`. No key in an environment variable, no Secrets Manager
entry, no rotation, nothing to leak in a log. That removes an entire category of
problem — and "I used IAM instead of a shared secret" is a better sentence than
any explanation of how carefully you stored a key.

**One bill, one cap.** Model spend lands on the AWS bill alongside everything
else, so a single AWS Budget bounds both infrastructure *and* inference. With a
first-party key you have two independent spend surfaces and no unified ceiling.
For a public demo that is the difference between a bounded risk and an open one.

**One vendor relationship.** Same account, same IAM, same CloudWatch, same
region and data-residency story.

### What Bedrock costs you

Honest trade-offs, all currently unused by this project but on the roadmap:

| Feature | Bedrock |
|---|---|
| Web search (server tool) | **Not available** — trend research would need a client tool over Tavily/Brave |
| Server-side refusal fallbacks | Not available — handle `stop_reason: "refusal"` client-side |
| Files / Batches APIs | Not available |

None are wired in today. The one that matters later is web search, which is a
real argument for keeping the seam rather than hard-coding Bedrock.

### The answer to give in an interview

> I built it against a provider interface rather than a specific vendor, because
> the Messages API surface is identical across Anthropic's first-party API,
> Bedrock, Vertex and Foundry. I developed against the first-party API for
> same-day feature parity — web search in particular, which Bedrock does not
> carry — and deployed on Bedrock, because in a Lambda the execution role
> replaces a stored API key entirely and model spend lands on the same bill I
> already budget against. Switching is one constructor.

---

## 2. The serverless architecture

```
        your-domain.com
              │
         CloudFront  ── ACM cert (free, must live in us-east-1)
        ┌─────┴─────┐
        │           │
   S3 (React)   Lambda Function URL
                RESPONSE_STREAM
                 ┌──┴───────────┐
              DynamoDB       Bedrock
            (no VPC)       (IAM role)
```

Everything is request-priced. Nothing runs when nobody is visiting.

**Why a Function URL rather than API Gateway:** an agent turn takes ~80 seconds.
API Gateway's integration timeout is 29 seconds, hard. Lambda response streaming
through a Function URL has no such ceiling — see `docs/SERVERLESS.md` §1.

**Why CloudFront in front of it:** a Function URL cannot carry your own domain.
CloudFront can, terminates the ACM certificate, and serves the React build from
S3 on the same origin so there is no CORS to configure.

---

## 3. The cost traps, explicitly

Every one of these is a *fixed monthly charge that runs whether anyone visits or
not*. This is where AWS bills come from on projects this size — not from usage.

| Trap | Cost | Avoid by |
|---|---|---|
| **NAT Gateway** | **~$32/mo** | Use no VPC at all |
| RDS, even db.t4g.micro | ~$13/mo | DynamoDB |
| Application Load Balancer | ~$16/mo | Function URL + CloudFront |
| ECS / Fargate always-on | ~$9–30/mo | Lambda |
| Secrets Manager | $0.40 per secret/mo | Not needed — Bedrock uses IAM |
| Route 53 hosted zone | $0.50/mo | Optional — see below |
| CloudWatch Logs, never expiring | grows forever | Set 7-day retention |

**The NAT Gateway is the one that catches people.** It appears the moment you
put a Lambda inside a VPC — usually to reach RDS — and then bills hourly
forever. Choosing DynamoDB, reached over its public endpoint with IAM auth,
means no VPC, which means no NAT and no RDS. Two charges to zero from one
decision.

### The domain

- **ACM certificate**: free, but it must be issued in **us-east-1** to be usable
  by CloudFront, whatever region the rest of your stack is in.
- **Route 53 hosted zone**: $0.50/month. Avoidable — point your registrar's
  nameservers at Cloudflare (free DNS) and add a CNAME to the CloudFront
  distribution. Route 53 is tidier; Cloudflare is free. Either is fine.
- The domain registration itself is ~$10–15/year wherever you buy it, and is not
  an AWS cost.

---

## 4. Set the safety nets BEFORE you deploy

Do these first. They take fifteen minutes and they are the difference between a
capped experiment and an open-ended liability.

**An AWS Budget with alerts at $5 and $10.** Free. Covers Bedrock too, which is
the whole point of putting inference on the same bill.

**Reserved concurrency on the API Lambda — set it to 5.** This is the real
limiter. Five concurrent 80-second turns is a hard ceiling on how fast anyone,
or anything, can spend your money. Without it a crawler discovering your demo
can fan out arbitrarily.

**CloudWatch log retention: 7 days**, set at creation. Logs that never expire
quietly become the largest line on a small bill.

**An application-level daily spend cap.** Count tokens per turn, stop serving
the agent past a daily budget, and return a clear "demo budget spent for today,
try tomorrow" rather than an error. Browsing the calendar, opening captions and
clicking Approve cost nothing — only the chat touches the model — so a spent
budget still leaves a fully explorable app.

---

## 5. What still has to be built

| Piece | Now | Needed |
|---|---|---|
| Store | `MemoryStore` | `DynamoStore`, same interface |
| Conversations | in-process Map | DynamoDB — Lambda is stateless |
| HTTP | Express | one Lambda handler with `streamifyResponse` |
| Media storage | local disk | `S3MediaStorage` — interface exists |
| Provider | `Anthropic()` | `AnthropicBedrockMantle` behind the seam |
| Infra | — | Terraform |
| CI | — | GitHub Actions: typecheck, verify, build, apply |

Do not port Express to Lambda with an adapter — `streamifyResponse` does not
compose cleanly with Express middleware, and with ~10 routes a hand-written
handler is smaller than the adapter would be.

### Order

1. `DynamoStore` + conversation persistence — **entirely local**, testable
   against DynamoDB Local, no AWS account touched.
2. The Lambda handler.
3. The spend cap and rate limit.
4. Terraform: Lambda, Function URL, DynamoDB, S3, CloudFront, ACM, IAM.
5. GitHub Actions.
6. Point the domain at CloudFront.

Steps 1–3 cost nothing and need no AWS account. Step 4 is where the
infrastructure story comes from.
