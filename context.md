 this is actually a very good portfolio project for you, especially because you're trying to move toward Cloud/DevOps while keeping your software-development background. The key is not to build a huge Buffer/Hootsuite clone. Build a small but genuinely agentic system, deploy it properly on AWS, and document the architecture.

The screenshot's idea can become a project like:

🚀 AI Social Media Content Planner & Scheduler

An AI-powered application where a user gives the agent a business/profile description, target audience, goals, and preferred tone. The agent then:

Understands the user's business
Generates content ideas
Creates captions
Suggests hashtags
Recommends posting dates/times
Lets the user review/edit/approve
Schedules approved posts
Eventually publishes them to social platforms
Tracks what has been published

And importantly, the AI should make decisions using tools, rather than just being a chatbot.

1. First: what exactly are we building?

I'd define the project as:

An AI agent that autonomously plans and prepares social-media content based on a user's business profile, audience, goals and content strategy, while keeping the user in control before publishing.

Example

User enters:

Business: Small coffee shop in Colombo
Audience: 18–35
Goal: Increase Instagram engagement
Tone: Friendly and humorous
Frequency: 4 posts/week

The agent could produce:

Date	Content type	Idea	Caption	Hashtags
Monday	Educational	Coffee brewing tip	Generated caption	#Coffee #Colombo...
Wednesday	Promotional	New iced latte	Generated caption	#IcedCoffee...
Friday	Engagement	"Choose your coffee"	Generated caption	...
Sunday	Story	Behind the scenes	Generated caption	...

The user then says:

"Change Wednesday's post to something more humorous."

The agent modifies it.

Then:

"Approve Monday and Friday."

The system schedules those posts.

That's already a strong MVP.

2. Don't start with social-media APIs

This is probably the biggest recommendation I'd give you.

Don't start by trying to integrate:

Instagram
Facebook
LinkedIn
TikTok
X
Buffer
Hootsuite

You'll spend a huge amount of time dealing with OAuth, permissions, platform restrictions and API quirks instead of learning AI agents.

Build in 3 levels

Level 1 — AI Content Agent

Generate:

ideas
captions
hashtags
content calendar

↓

Level 2 — Scheduling System

Allow:

approve
edit
schedule
reschedule
cancel

↓

Level 3 — Social Publishing

Connect one real platform/API.

That gives you a very clean development path.

3. What makes this an "AI agent"?

This is important for your CV.

A normal AI application might simply do:

User → LLM → Response

That's basically an AI chatbot.

Your system should instead look more like:

                    ┌───────────────┐
                    │     User      │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   AI Agent    │
                    └───────┬───────┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
      ┌────────────┐ ┌────────────┐ ┌─────────────┐
      │ Content    │ │ Caption    │ │ Hashtag     │
      │ Planner    │ │ Generator  │ │ Generator   │
      └────────────┘ └────────────┘ └─────────────┘
             │              │              │
             └──────────────┼──────────────┘
                            ▼
                    ┌───────────────┐
                    │ Content       │
                    │ Database      │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Human Review  │
                    └───────┬───────┘
                            │
                         APPROVE
                            │
                            ▼
                    ┌───────────────┐
                    │   Scheduler   │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Social Media  │
                    │ API / Adapter │
                    └───────────────┘

The important part is that the agent can use tools and perform actions.

4. I would give your agent these tools

This is where your project becomes much more interesting technically.

The AI agent can have tools such as:

Tool 1 — get_business_profile()

Retrieves:

{
  "business": "Coffee Shop",
  "audience": "18-35",
  "location": "Colombo",
  "tone": "friendly",
  "goal": "increase engagement"
}
Tool 2 — generate_content_ideas()

The agent calls this when it needs ideas.

Tool 3 — generate_caption()

Produces the caption for a selected idea.

Tool 4 — generate_hashtags()

Generates relevant hashtags.

Tool 5 — create_content_calendar()

Creates something like:

Monday → Educational
Wednesday → Promotional
Friday → Engagement
Sunday → Behind the scenes
Tool 6 — check_scheduled_posts()

The agent can inspect existing scheduled content.

This is important because you don't want the AI generating five identical posts.

Tool 7 — schedule_post()

The agent can request:

{
  "contentId": "123",
  "scheduledAt": "2026-09-15T18:30:00"
}
Tool 8 — update_post()

For requests like:

Make Friday's post more humorous.

Tool 9 — cancel_post()

For:

Cancel Sunday's post.

5. Give the agent a specific responsibility

Don't create a generic:

"You are an AI assistant."

Instead:

You are a social media content planning agent. Your responsibility is to create, manage and schedule social media content according to the user's business profile and content strategy. You must use available tools to inspect existing content before creating new content. You must never publish content without user approval.

That's a much better agent design.

6. Human approval is VERY important

I strongly recommend this.

Don't make:

AI → automatically publishes

Instead:

AI
 ↓
Generate
 ↓
Review
 ↓
User approves
 ↓
Schedule
 ↓
Publish

This gives you a concept called human-in-the-loop.

It's also something you can discuss in interviews:

"I designed the agent with human-in-the-loop approval before external side effects such as publishing social-media content."

That sounds much more mature than:

"I connected ChatGPT to Instagram."

😂

7. Your MVP scope

I'd keep your first version to approximately this:

Phase 1 — User profile

User creates:

Business name
Business description
Industry
Target audience
Location
Brand tone
Marketing goal
Posting frequency
Preferred platforms
Phase 2 — AI content planning

User clicks:

Generate Content Plan

Agent generates:

30-day content calendar

Each item contains:

Date
Content type
Topic
Caption
Hashtags
Call-to-action
Recommended platform
Phase 3 — AI editing

User can say:

Make this more professional.

or

Make this shorter.

or

Give me three alternatives.

or

Change this from promotional to educational.

The agent modifies the content.

Phase 4 — Approval

Each post has:

Approve | Edit | Regenerate | Delete

Phase 5 — Scheduling

User chooses:

September 15
18:30
Instagram

System schedules it.

Phase 6 — Publishing

Initially:

Mock publisher

Instead of actually publishing:

POST PUBLISHED ✓

Later:

Real social API

Start with one platform.

8. Architecture I'd recommend for YOU

Considering your existing experience, I'd deliberately use technologies that strengthen your CV.

Frontend

React + TypeScript

You already have React experience.

React
TypeScript
Tailwind CSS
Backend

Node.js + TypeScript

Use something like:

Node.js
Express / Fastify

or a structured framework such as NestJS if you want to demonstrate stronger backend architecture.

AI

For the first version, use an LLM API.

If you want this to reinforce your AWS profile, I'd seriously consider Amazon Bedrock.

Then you can demonstrate:

AWS
+
LLM
+
Agent
+
IAM
+
Serverless

That's much more relevant to the Cloud/DevOps direction you're targeting.

9. AWS architecture

This is where I think you can make the project CV-worthy rather than just another AI demo.

Something like:

                    ┌─────────────────┐
                    │     Browser     │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ CloudFront      │
                    │ + S3            │
                    │ React App       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ API Gateway     │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Lambda / ECS    │
                    │ Node.js API     │
                    └───────┬─────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌────────────┐ ┌─────────────┐
        │ Bedrock  │ │ DynamoDB   │ │ S3          │
        │ AI Agent │ │            │ │ Media       │
        └──────────┘ └────────────┘ └─────────────┘
              │
              ▼
        ┌──────────────┐
        │ EventBridge  │
        │ Scheduler    │
        └──────┬───────┘
               │
               ▼
        ┌──────────────┐
        │ SQS          │
        └──────┬───────┘
               │
               ▼
        ┌──────────────┐
        │ Publisher    │
        │ Lambda       │
        └──────┬───────┘
               │
               ▼
        Social Media API

You don't need to implement every box on day one.

10. Database design

A simple DynamoDB design could contain:

Users
userId
email
createdAt
BusinessProfiles
profileId
userId
businessName
description
industry
targetAudience
tone
location
marketingGoals
ContentPosts
postId
userId
platform
contentType
topic
caption
hashtags
status
scheduledAt
createdAt
updatedAt

Status:

DRAFT
PENDING_APPROVAL
APPROVED
SCHEDULED
PUBLISHED
FAILED
CANCELLED
AgentTasks
taskId
userId
task
status
createdAt
completedAt

This gives you something to demonstrate around data modelling too.

11. The actual agent workflow

This is the part I'd want you to understand before writing code.

Suppose the user says:

"Create content for my coffee shop for next week."

The agent receives that request.

Step 1

Agent determines:

I need:
- business profile
- existing posts
- posting frequency
- target audience
Step 2

Agent calls:

get_business_profile()
Step 3

Agent calls:

get_scheduled_posts()
Step 4

Agent reasons:

There are already promotional posts
on Monday and Wednesday.

I should avoid generating another
promotional post.
Step 5

Agent calls:

generate_content_ideas()
Step 6

Agent creates:

Monday → Educational
Wednesday → Engagement
Friday → Behind the scenes
Sunday → Promotional
Step 7

Agent generates captions.

Step 8

Agent returns structured data.

Step 9

Frontend displays:

┌──────────────────────────────┐
│ Monday                       │
│ ☕ Coffee Brewing Tip        │
│                              │
│ "Did you know..."            │
│                              │
│ #Coffee #CoffeeLovers        │
│                              │
│ [Edit] [Regenerate] [Approve]│
└──────────────────────────────┘

That's your agent.

12. Don't let the LLM control everything

This is another important architecture decision.

The LLM should not directly execute arbitrary database operations.

Instead:

LLM
 ↓
Tool request
 ↓
Backend validates request
 ↓
Backend performs operation
 ↓
Result returned to agent

For example:

Agent:
schedule_post(postId=123, time=...)

        ↓

Backend:

Is post 123 owned by this user?
Is the date valid?
Is the platform connected?
Is the post approved?

        ↓

YES

        ↓

Schedule

This demonstrates that you understand AI safety + backend authorization, rather than blindly trusting the model.

13. Structured output is important

Don't ask the LLM:

"Give me some social media ideas."

and then parse random text.

Make it return structured data:

{
  "posts": [
    {
      "date": "2026-09-15",
      "contentType": "educational",
      "topic": "Coffee brewing tips",
      "caption": "...",
      "hashtags": [
        "#Coffee",
        "#CoffeeTips"
      ],
      "callToAction": "Save this tip!"
    }
  ]
}

This makes the application much more reliable.

14. What I would NOT build initially

❌ AI image generation
❌ AI video generation
❌ TikTok integration
❌ Instagram + Facebook + LinkedIn + X simultaneously
❌ Analytics dashboard
❌ AI voice
❌ Mobile app
❌ Complex multi-agent architecture
❌ RAG/vector database immediately

You can add those later.

Your first objective is:

Build one good agent that can plan → generate → review → schedule.

15. A very good development roadmap for you

I'd do this over approximately 6 milestones.

🟢 Milestone 1 — Basic application

Build:

React
   ↓
Node API
   ↓
DynamoDB

Features:

login
business profile
content list
create/edit/delete post

No AI yet.

🟢 Milestone 2 — LLM integration

Add:

Node
 ↓
LLM

Implement:

Generate 5 content ideas

Then:

Generate caption

Then:

Generate hashtags

🟢 Milestone 3 — Agent

Now introduce:

Agent
 ↓
Tools

Tools:

get_business_profile
get_existing_posts
generate_ideas
generate_caption
generate_hashtags

This is where you're actually learning agent development.

🟢 Milestone 4 — Content planner

Implement:

"Create my content plan for next week."

Agent generates the calendar.

Frontend displays it.

User can:

Approve
Edit
Regenerate
Delete
🟢 Milestone 5 — Scheduler

Implement:

EventBridge Scheduler
       ↓
SQS
       ↓
Publisher Lambda

Initially the publisher can simply simulate publishing.

Then connect one real social platform.

🟢 Milestone 6 — Production deployment

This is where your Cloud/DevOps CV angle becomes strong.

Use:

Terraform
GitHub Actions
AWS
Docker
CloudWatch
IAM
Secrets Manager

Pipeline:

GitHub
   ↓
GitHub Actions
   ↓
Test
   ↓
Build
   ↓
Docker
   ↓
Deploy AWS

Now you've demonstrated both:

Software Engineering + AI + Cloud + DevOps.

16. Then add observability

This is something many AI portfolio projects completely miss.

Track:

Agent request
↓
Tool called
↓
Execution time
↓
LLM response
↓
Tool result
↓
Final result

You could monitor:

API latency
Lambda errors
scheduler failures
publishing failures
agent execution failures
LLM token usage/cost

CloudWatch would fit nicely here.

17. Your eventual GitHub README should look impressive

Something like:

AI Social Media Content Planner

An AI-agent-powered social media planning and scheduling platform that autonomously generates content strategies, captions and hashtags while maintaining human approval before scheduled publishing.

Architecture

React + TypeScript
Node.js
Amazon Bedrock
AWS Lambda
API Gateway
DynamoDB
S3
EventBridge Scheduler
SQS
Terraform
GitHub Actions
CloudWatch

AI capabilities
Business-aware content planning
Tool-using AI agent
Context-aware content generation
Existing-content analysis
Structured LLM outputs
Human-in-the-loop approval
Automated scheduling
Social publishing integration

That is much stronger on a CV than:

"Built an AI chatbot using OpenAI."

18. And eventually your CV bullets

Once you've actually built it, we could truthfully get to something along the lines of:

Designed and developed an AI-powered social media content planning and scheduling platform using React, Node.js, AWS and LLM-based agent workflows, enabling automated content ideation, caption generation and scheduling with human-in-the-loop approval.

And for your Cloud/DevOps angle:

Provisioned AWS infrastructure using Terraform and implemented CI/CD with GitHub Actions, deploying containerized/serverless workloads with automated scheduling, asynchronous processing and CloudWatch monitoring.

And:

Implemented tool-based AI agent workflows with structured outputs and backend validation to safely execute content management and scheduling operations.

Those are genuinely useful CV bullets if you build the corresponding functionality.

19. One thing I want you to avoid

Don't fall into the trap of thinking:

"I haven't built an AI agent before, so I need to learn AI first."

You don't.

You already know software development.

Think of an AI agent as:

LLM
 +
Instructions
 +
Tools
 +
State/context
 +
Decision-making
 +
Application code

You already know how to build:

APIs
Databases
AWS infrastructure
Authentication
Docker
CI/CD
React
Node

The new piece you're learning is primarily:

LLM orchestration + tool calling + agent state + evaluation.

That's very manageable.

🎯 And I would make THIS your project

Not a generic AI chatbot.

I'd call it something like:

SocialPilot AI

AI-powered content planning and scheduling agent

And build it progressively:

                    SOCIALPILOT AI

                         USER
                           │
                           ▼
                    ┌─────────────┐
                    │ AI AGENT    │
                    └──────┬──────┘
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
          PLAN          CREATE        MANAGE
             │             │             │
             ▼             ▼             ▼
        Calendar       Captions       Posts
        Strategy       Hashtags       Approval
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                     SCHEDULER
                           │
                           ▼
                    SOCIAL PLATFORM

This is absolutely something I'd recommend putting in your portfolio while you're applying for Cloud/DevOps roles. It gives you a project where you can demonstrate AWS, Terraform, CI/CD, containers/serverless, monitoring, backend development and modern AI-agent development in one system.

For the next step, I can help you turn this into a proper software-project specification: requirements → MVP scope → user stories → agent architecture → API design → DynamoDB schema → AWS architecture → Terraform structure → GitHub repo structure → development tasks in the exact order you should implement them.

Today 9:55 PM
we have to let user to connect with their social media profiles through this AI agent right? we have to get access to their profiles to schedule / draft posts, reels, stories
how can we handle that part?

Yes. That is exactly the part you need to design carefully. Your AI agent should not ask users for their Instagram/Facebook/LinkedIn passwords. Instead, you use each platform's OAuth 2.0 authorization flow.

Think of it as:

User grants your application permission to act on their behalf → your backend receives an access token → your backend securely stores it → the agent uses your backend's tools to perform permitted actions.

For example, LinkedIn explicitly uses OAuth 2.0 for member authorization, and the user must approve access before your application can access their resources.

1. What the user experience should look like

Your application could have:

┌─────────────────────────────────────────────┐
│           Connected Accounts                │
│                                             │
│  Instagram     ○ Not connected             │
│                [ Connect Instagram ]        │
│                                             │
│  Facebook      ○ Not connected              │
│                [ Connect Facebook ]         │
│                                             │
│  LinkedIn      ● Connected ✓                │
│                Ruwani's Profile             │
│                [ Disconnect ]               │
└─────────────────────────────────────────────┘

User clicks:

Connect Instagram

Your app redirects them to Instagram/Meta's authorization page.

They log in on Instagram/Meta, not your website.

They see something like:

"SocialPilot AI wants permission to..."

Then:

Allow

The platform redirects the user back to your application.

Your backend exchanges the authorization code for an access token.

Your application now knows:

User X
   ↓
Instagram Account Y
   ↓
Access Token
   ↓
Permissions/Scopes

The user never gives you their password.

2. Very important: the AI agent should NOT own the OAuth tokens

This is an architectural distinction I really want you to make.

Don't build:

AI Agent
   ↓
Instagram access token
   ↓
Instagram API

Instead:

                    ┌───────────────┐
                    │   AI Agent   │
                    └───────┬───────┘
                            │
                     "publish_post"
                            │
                            ▼
                    ┌───────────────┐
                    │ Backend Tool  │
                    └───────┬───────┘
                            │
                    retrieves token
                            │
                            ▼
                    ┌───────────────┐
                    │ Token Vault   │
                    └───────┬───────┘
                            │
                            ▼
                    Social Media API

The agent requests an action.

Your backend decides whether the action is allowed and performs it.

That's much safer.

3. Think of each social network as a "connector"

This will make your architecture much cleaner.

Create a common interface:

interface SocialMediaConnector {
    connect(): Promise<void>;

    publishPost(post: Post): Promise<PublishResult>;

    uploadMedia(media: Media): Promise<MediaResult>;

    schedulePost(post: Post): Promise<ScheduleResult>;

    getAccount(): Promise<SocialAccount>;

    disconnect(): Promise<void>;
}

Then implement:

SocialMediaConnector
       │
       ├── InstagramConnector
       │
       ├── FacebookConnector
       │
       ├── LinkedInConnector
       │
       └── XConnector

Now your AI doesn't care which platform it's talking to.

It can say:

publish_content(
    platform = "instagram",
    account = "account123",
    content = ...
)

Your backend routes that to:

InstagramConnector.publishPost()

This is a very good software-engineering design decision for your portfolio.

4. You also need to separate CONTENT from PLATFORM

This is another thing I'd design from the beginning.

Suppose your agent creates:

Content
──────────────
Topic:
"5 ways to make better coffee"

Caption:
"..."

Media:
coffee.jpg

Hashtags:
#Coffee #CoffeeTips

That is platform-independent content.

Then you have:

Platform Version
─────────────────

Instagram:
caption + image/reel

LinkedIn:
caption + image

Facebook:
caption + image

TikTok:
video + caption

Because the same content may need to be adapted.

For example:

"Create a post for Instagram and LinkedIn."

The agent could create:

              CONTENT IDEA
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
      Instagram            LinkedIn
      version               version
          │                   │
       Reel                Image
       caption             caption
       hashtags            hashtags

That's where the AI becomes genuinely useful.

5. Scheduling is actually YOUR responsibility

This is another important distinction.

Don't rely on Instagram/LinkedIn/etc. to provide your application's scheduling mechanism.

Your system should maintain its own scheduling system.

For example:

User
 │
 │ "Post this Friday at 7 PM"
 ▼
AI Agent
 │
 ▼
Backend
 │
 ▼
Database
 │
 │ status = SCHEDULED
 ▼
EventBridge Scheduler
 │
 ▼
SQS
 │
 ▼
Publisher Lambda
 │
 ▼
Instagram API

So your database might contain:

postId: 123

platform: INSTAGRAM

accountId: instagram_456

status: SCHEDULED

scheduledAt:
2026-09-11 19:00

contentId:
abc123

At 7 PM:

EventBridge
     ↓
SQS
     ↓
Publisher
     ↓
Instagram API
6. This is where your AWS experience becomes useful

You already know AWS, so I'd build this part properly.

I'd potentially use:

                    AWS

              ┌──────────────┐
              │ API Gateway  │
              └──────┬───────┘
                     │
                     ▼
              ┌──────────────┐
              │ Node.js API  │
              │ Lambda/ECS   │
              └──────┬───────┘
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
  DynamoDB       Secrets       Bedrock
                Manager           │
                                  ▼
                              AI Agent
       │
       ▼
 EventBridge Scheduler
       │
       ▼
      SQS
       │
       ▼
 Publisher Lambda
       │
 ┌─────┼──────────┐
 ▼     ▼          ▼
IG   Facebook   LinkedIn
7. Where do you store the access tokens?

Never in DynamoDB as plain text.

For a portfolio project, I'd use:

AWS Secrets Manager

or an encrypted token store using AWS KMS.

Conceptually:

DynamoDB

socialAccountId
userId
platform
platformAccountId
tokenSecretId
scopes
expiresAt
status

Then:

tokenSecretId
       ↓
AWS Secrets Manager
       ↓
encrypted access/refresh token

Your database doesn't contain:

"EAABxxxxxxxxxxxxxxxx"

in plaintext.

8. What happens when a token expires?

This is something your architecture should explicitly handle.

For example:

Publisher
   ↓
Social API
   ↓
401 Unauthorized
   ↓
Token expired
   ↓
Try refresh
   ↓
Success?
 ┌───────┴───────┐
 YES             NO
 │                │
 ▼                ▼
Publish       Mark account
              REAUTH_REQUIRED
                    │
                    ▼
             Notify user

Then your UI can say:

⚠️ Your Instagram connection needs to be renewed.

Reconnect Instagram

This is exactly the kind of real-world engineering detail that makes a project impressive.

9. Permissions are platform-specific

And this is where we need to be careful about your original idea of:

"schedule / draft posts, reels, stories"

You cannot assume that every platform allows every operation through its API.

Each platform has its own:

OAuth flow
scopes
account requirements
media requirements
publishing APIs
review requirements
rate limits
restrictions on scheduling
restrictions on drafts/stories/reels

For example, LinkedIn's current Posts API supports organic text, image, video and other post types, with permissions such as w_member_social for posting on behalf of an authenticated member.

But some read permissions are restricted, and additional LinkedIn API access may require approval.

So your system should have a capability matrix.

10. Build this capability matrix

Something like:

Capability	Instagram	Facebook	LinkedIn
Connect account	✓	✓	✓
Create text post	?	?	✓
Image post	?	?	✓
Video	?	?	✓
Reel	?	?	—
Story	?	?	—
Read posts	?	?	Depends
Schedule	Your scheduler	Your scheduler	Your scheduler
Publish	API	API	API
Analytics	Later	Later	Later

Don't implement the ? features until you've verified the current official API requirements.

This is especially important because social APIs change frequently.

11. Drafts are slightly different

This is an important point.

When the user says:

"Save this as an Instagram draft."

That doesn't necessarily mean your application can tell Instagram:

createDraft()

Some platforms don't expose the same draft functionality you'd have inside their native app.

So your application should have its own draft system.

For example:

SOCIALPILOT

Draft
 ├── caption
 ├── media
 ├── platform
 ├── hashtags
 ├── status
 └── scheduledAt

Then:

DRAFT
   ↓
USER APPROVES
   ↓
SCHEDULED
   ↓
PUBLISHED

That's actually better for your product.

12. Reels and Stories should be treated as different content types

Don't just have:

type = POST

Use:

type ContentType =
    | "POST"
    | "REEL"
    | "STORY";

And perhaps:

interface Content {
    id: string;
    userId: string;
    type: ContentType;
    caption?: string;
    media: Media[];
    hashtags?: string[];
    platforms: Platform[];
    status: ContentStatus;
}

Then platform validation decides whether it can actually be published.

13. Your AI agent should know these capabilities

This is where it gets interesting.

Imagine the user says:

"Create a reel for Instagram and schedule it for Friday at 7 PM."

Agent:

1. Identify user
2. Check connected Instagram account
3. Check Instagram publishing capabilities
4. Generate reel concept
5. Generate caption
6. Generate hashtags
7. Prepare content
8. Ask user for approval
9. Schedule

If Instagram isn't connected:

Agent:

"I can prepare the Reel, but your Instagram
account isn't connected.

Connect Instagram to schedule it."

If connected:

Agent:

"I've prepared the Reel and scheduled it for
Friday at 7 PM after your approval."

That's a real agent workflow.

14. I would actually build the "Connect Account" flow BEFORE the AI

This is slightly different from what I suggested earlier.

For this project, I'd change the development order to:

Phase 1

Build:

User
 ↓
Connect LinkedIn
 ↓
OAuth
 ↓
Token storage
 ↓
Connected account

Don't even involve AI yet.

Phase 2

Build:

Create content
 ↓
Publish through connector

Test:

React
 ↓
Backend
 ↓
LinkedIn API
Phase 3

Build your scheduler:

schedule
 ↓
EventBridge
 ↓
SQS
 ↓
Publisher
Phase 4

Only now:

AI Agent

Then the AI gets tools:

get_connected_accounts()
get_platform_capabilities()

create_content()
update_content()

schedule_content()
publish_content()

This makes the AI sit on top of a properly engineered platform.

That's the architecture I'd want you to demonstrate in a Cloud/DevOps interview.

15. And there's one BIG practical issue

Because you're building this as a portfolio project, don't start by trying to support Instagram + Facebook + TikTok + LinkedIn + X.

You'll drown in developer-account approvals and platform-specific rules. 😅

I'd start with:

LinkedIn OR Instagram

Personally, for your first implementation, I'd choose LinkedIn because its API model is relatively straightforward for basic publishing, and the current documentation explicitly supports member posting with w_member_social.

Then architecture:

             SocialPilot AI

                  │
             AI Agent
                  │
        ┌─────────┴─────────┐
        │                   │
  Content Tools       Social Tools
        │                   │
        │            LinkedInConnector
        │                   │
        ▼                   ▼
    DynamoDB           LinkedIn API
        │
        ▼
 EventBridge
        │
        ▼
       SQS
        │
        ▼
 Publisher Worker

Once that works:

LinkedInConnector
       +
InstagramConnector
       +
FacebookConnector

The rest of your application doesn't need to change.

🔐 The security principle to remember

The whole system should essentially follow:

OAuth gives the application permission. The agent requests an action. The backend validates the action. The connector uses the stored token.

Not:

AI gets someone's social-media password and does whatever it wants. ❌

And we should request only the minimum permissions required; LinkedIn's own security guidance explicitly recommends minimal scopes and protecting access tokens from logs/files.

Your architecture is therefore:
                    USER
                      │
                      │ OAuth
                      ▼
             SOCIAL PLATFORM
                      │
                      │ access token
                      ▼
              YOUR BACKEND
                      │
                ┌─────┴─────┐
                │           │
             Token       Account
             Vault       Metadata
                │           │
                └─────┬─────┘
                      │
                      ▼
                  AI AGENT
                      │
                 Tool calls
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       Create      Schedule    Publish
       Content      Content     Content
                                  │
                                  ▼
                          SOCIAL CONNECTOR
                                  │
                                  ▼
                         Social Media API

And yes — this connection/authentication layer should be part of the scope from the beginning. It is not a small add-on; it's one of the core architectural components of the product.

If we design this properly, your project can demonstrate OAuth 2.0, secure token management, API integrations, asynchronous jobs, event-driven AWS architecture, AI agents/tool calling, Terraform and CI/CD — which is a much stronger portfolio project for the Cloud/DevOps transition you're targeting.