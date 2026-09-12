import {
  createMediaStore,
  createSeededStore,
  createStoreWithExpiredConnection,
  createStoreWithPersonalInstagram,
  USER_ID,
} from "./seed.js";
import { MockScheduler } from "./scheduler/mock.js";
import { MockMetaConnector, MockTokenProvider } from "./connectors/mock.js";
import { Publisher } from "./publisher.js";
import { StoreError } from "./store/memory.js";
import { MediaError } from "./store/media.js";
import { buildTimeContext, utcOffset } from "./agent/time-context.js";
import { VariantDraftSchema, type ContentItemDraft, type VariantDraft } from "./schemas.js";

/**
 * Assertions on the safety boundary, the time rules, and the item/variant
 * relationship. These are the properties the whole design rests on, so they are
 * checked in code rather than trusted to a prompt.
 */

const store = createSeededStore();
let pass = 0;
let fail = 0;

const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
};

const future = (days = 1) => new Date(Date.now() + days * 86_400_000).toISOString();

const IG = "ch_ig001";
const FB = "ch_fb001";

const variant = (over: Partial<VariantDraft> = {}): VariantDraft => ({
  channelId: IG,
  assetIds: [],
  scheduledFor: future(),
  media: { format: "POST", imageConcept: "A grinder." },
  hook: "Your grinder matters more than your beans.",
  caption: "Short caption.",
  hashtags: ["coffee"],
  callToAction: "Try it.",
  ...over,
});

const item = (over: Partial<ContentItemDraft> = {}): ContentItemDraft => ({
  topic: "Grinder basics",
  coreMessage: "Grind consistency matters more than bean origin for most home setups.",
  pillar: "Coffee education people can use at home",
  contentCategory: "educational",
  rationale: "Teaches something immediately usable.",
  variants: [variant()],
  ...over,
});

// -- the approval boundary ---------------------------------------------------

const [i1] = store.createContent(USER_ID, [item()]);
const v1 = i1!.variants[0]!;

check("new variants start as DRAFT", v1.status === "DRAFT", `got ${v1.status}`);

try {
  store.requestApproval(USER_ID, v1.id);
  check("agent can move DRAFT -> PENDING_APPROVAL", true);
} catch (e) {
  check("agent can move DRAFT -> PENDING_APPROVAL", false, String(e));
}

try {
  await store.scheduleVariant(USER_ID, v1.id, future(), "k1");
  check("scheduling without human approval is refused", false, "it succeeded!");
} catch (e) {
  check(
    "scheduling without human approval is refused",
    e instanceof StoreError && e.code === "INVALID_STATE",
  );
}

store.humanApprove(USER_ID, v1.id);
const when = future(2);
const s1 = await store.scheduleVariant(USER_ID, v1.id, when, "key-abc");
check("scheduling works after a human approves", s1.status === "SCHEDULED");

const s2 = await store.scheduleVariant(USER_ID, v1.id, when, "key-abc");
check("idempotent replay returns the same variant", s2.id === s1.id);

// -- item / variant relationship --------------------------------------------

const [cross] = store.createContent(USER_ID, [
  item({
    topic: "Weekend cupping",
    variants: [
      variant({ channelId: IG, hashtags: ["cupping", "colombocoffee"] }),
      variant({ channelId: FB, hashtags: [], caption: "A longer Facebook version." }),
    ],
  }),
]);
check("one idea can carry two channel variants", cross!.variants.length === 2);
check(
  "both variants share one item id",
  cross!.variants.every((v) => v.itemId === cross!.id),
);

const added = store.addVariants(USER_ID, cross!.id, [
  variant({
    channelId: FB,
    media: { format: "STORY", visual: "Counter shot.", interaction: "poll", interactionPrompt: "Milk or no milk?" },
    caption: "Story version.",
    hashtags: [],
  }),
]);
check("add_variants attaches to the existing idea", added[0]!.itemId === cross!.id);
check("item now has three variants", store.getItem(USER_ID, cross!.id).variants.length === 3);

// Cancelling one channel must leave the idea and its siblings intact.
await store.cancelVariant(USER_ID, added[0]!.id);
const afterCancel = store.getItem(USER_ID, cross!.id);
check(
  "cancelling one variant leaves the others alone",
  afterCancel.variants.filter((v) => v.status !== "CANCELLED").length === 2,
);

// -- approval scoping --------------------------------------------------------

const igVariant = cross!.variants.find((v) => v.platform === "instagram")!;
store.humanApprove(USER_ID, igVariant.id);
const moved = store.updateVariant(USER_ID, igVariant.id, { scheduledFor: future(3) });
check("a time-only change KEEPS approval", moved.status === "APPROVED", `got ${moved.status}`);

const reworded = store.updateVariant(USER_ID, igVariant.id, { caption: "Totally new words." });
check("a content change REVOKES approval", reworded.status === "DRAFT", `got ${reworded.status}`);

// Editing the shared idea invalidates approvals on every variant beneath it.
const fbVariant = cross!.variants.find((v) => v.platform === "facebook")!;
store.humanApprove(USER_ID, fbVariant.id);
store.updateItem(USER_ID, cross!.id, { coreMessage: "An entirely different message." });
check(
  "editing the idea REVOKES approval on its variants",
  store.getVariant(USER_ID, fbVariant.id).status === "DRAFT",
);

// -- timezone correctness ----------------------------------------------------

try {
  store.createContent(USER_ID, [
    item({ variants: [variant({ scheduledFor: "2026-09-21T11:00:00" })] }),
  ]);
  check("naive datetime (no offset) is rejected", false, "it succeeded!");
} catch (e) {
  check(
    "naive datetime (no offset) is rejected",
    e instanceof StoreError && e.code === "INVALID_INPUT",
  );
}

const [tz] = store.createContent(USER_ID, [
  item({ variants: [variant({ scheduledFor: "2126-09-21T11:00:00+05:30" })] }),
]);
check("datetime with offset is accepted", tz!.variants[0]!.scheduledFor.endsWith("+05:30"));
check("utcOffset resolves Asia/Colombo", utcOffset(new Date(), "Asia/Colombo") === "+05:30");

const ctx = buildTimeContext("Asia/Colombo", new Date("2026-09-12T06:43:00Z"));
check("time context states today", ctx.includes("2026-09-12"));
check("time context names the weekday", ctx.includes("Saturday"));
check(
  "time context flags 'next Monday' ambiguity",
  ctx.includes("2026-09-14") && ctx.includes("2026-09-21"),
);

// -- capability and ownership ------------------------------------------------

const fbOff = createStoreWithExpiredConnection();
const [d1] = fbOff.createContent(USER_ID, [item({ variants: [variant({ channelId: FB, hashtags: [] })] })]);
fbOff.humanApprove(USER_ID, d1!.variants[0]!.id);
try {
  await fbOff.scheduleVariant(USER_ID, d1!.variants[0]!.id, future(), "key-fb");
  check("an expired connection blocks scheduling", false, "it succeeded!");
} catch (e) {
  check(
    "an expired connection blocks scheduling",
    e instanceof StoreError && e.code === "NOT_CONNECTED" && /reconnect meta/i.test(e.message),
    e instanceof StoreError ? e.message : String(e),
  );
}

try {
  store.getVariant("user_attacker", v1.id);
  check("cross-user read is refused", false, "it succeeded!");
} catch (e) {
  check("cross-user read is refused", e instanceof StoreError && e.code === "NOT_FOUND");
}

// A bad variant must not leave its siblings half-written.
const countBefore = store.getCalendar(USER_ID).length;
try {
  store.createContent(USER_ID, [
    item({ variants: [variant(), variant({ scheduledFor: "not-a-date" })] }),
  ]);
  check("a partially invalid item writes nothing", false, "it succeeded!");
} catch {
  check("a partially invalid item writes nothing", store.getCalendar(USER_ID).length === countBefore);
}

const [p6] = store.createContent(USER_ID, [item()]);
store.humanApprove(USER_ID, p6!.variants[0]!.id);
try {
  await store.scheduleVariant(USER_ID, p6!.variants[0]!.id, "2020-01-01T10:00:00Z", "key-past");
  check("a past datetime is refused", false, "it succeeded!");
} catch (e) {
  check("a past datetime is refused", e instanceof StoreError && e.code === "INVALID_INPUT");
}

// -- rescheduling ------------------------------------------------------------

{
  const sched = new MockScheduler();
  const st = createSeededStore(sched);

  const [a] = st.createContent(USER_ID, [item({ variants: [variant({ scheduledFor: future(2) })] })]);
  const [b] = st.createContent(USER_ID, [item({ variants: [variant({ scheduledFor: future(3) })] })]);
  const av = a!.variants[0]!;
  const bv = b!.variants[0]!;

  // A SCHEDULED variant has a live timer that must move with it.
  st.humanApprove(USER_ID, av.id);
  const scheduled = await st.scheduleVariant(USER_ID, av.id, future(2), "resched-key");
  const firstJob = scheduled.scheduleId!;
  check("scheduling creates a timer", sched.pending().length === 1 && !!firstJob);

  const movedTo = future(5);
  const rescheduled = await st.rescheduleVariants(USER_ID, [
    { variantId: av.id, scheduledFor: movedTo },
  ]);
  check("reschedule moves the row", rescheduled[0]!.scheduledFor === movedTo);
  check("reschedule preserves SCHEDULED status", rescheduled[0]!.status === "SCHEDULED");
  check(
    "reschedule replaces the timer rather than adding one",
    sched.pending().length === 1 && rescheduled[0]!.scheduleId !== firstJob,
  );
  check(
    "the new timer fires at the new time",
    sched.pending()[0]!.fireAt === movedTo,
    `got ${sched.pending()[0]!.fireAt}`,
  );

  const bulk = await st.rescheduleVariants(USER_ID, [
    { variantId: av.id, scheduledFor: future(9) },
    { variantId: bv.id, scheduledFor: future(10) },
  ]);
  check("bulk move returns every variant", bulk.length === 2);

  // Atomicity: one bad move rejects the whole batch.
  const beforeA = st.getVariant(USER_ID, av.id).scheduledFor;
  const beforeB = st.getVariant(USER_ID, bv.id).scheduledFor;
  try {
    await st.rescheduleVariants(USER_ID, [
      { variantId: av.id, scheduledFor: future(12) },
      { variantId: bv.id, scheduledFor: "2020-01-01T10:00:00Z" },
    ]);
    check("a batch containing a past date is fully rejected", false, "it succeeded!");
  } catch {
    check(
      "a batch containing a past date is fully rejected",
      st.getVariant(USER_ID, av.id).scheduledFor === beforeA &&
        st.getVariant(USER_ID, bv.id).scheduledFor === beforeB,
    );
  }

  // Rollback: the scheduler itself fails partway through a batch.
  const preA = st.getVariant(USER_ID, av.id).scheduledFor;
  const preB = st.getVariant(USER_ID, bv.id).scheduledFor;
  sched.failNext(1);
  try {
    await st.rescheduleVariants(USER_ID, [
      { variantId: av.id, scheduledFor: future(13) },
      { variantId: bv.id, scheduledFor: future(14) },
    ]);
    check("a scheduler failure rolls the whole batch back", false, "it succeeded!");
  } catch {
    check(
      "a scheduler failure rolls the whole batch back",
      st.getVariant(USER_ID, av.id).scheduledFor === preA &&
        st.getVariant(USER_ID, bv.id).scheduledFor === preB,
    );
  }

  try {
    await st.rescheduleVariants(USER_ID, [
      { variantId: av.id, scheduledFor: future(15) },
      { variantId: av.id, scheduledFor: future(16) },
    ]);
    check("the same variant twice in one batch is rejected", false, "it succeeded!");
  } catch {
    check("the same variant twice in one batch is rejected", true);
  }

  // Cancelling must drop the timer, or a cancelled post still fires.
  const timersBefore = sched.pending().length;
  await st.cancelVariant(USER_ID, av.id);
  check(
    "cancelling drops the timer",
    sched.pending().length === timersBefore - 1 &&
      st.getVariant(USER_ID, av.id).scheduleId === null,
  );
}

// -- connections and channels ------------------------------------------------

{
  const st = createSeededStore();
  const accounts = st.getConnectedAccounts(USER_ID);
  check("both Meta channels are listed", accounts.length === 2);
  check(
    "channel summaries leak no token, tokenRef, or platform id",
    accounts.every(
      (a) =>
        !("tokenRef" in a) &&
        !("externalId" in a) &&
        !("connectionId" in a) &&
        !JSON.stringify(a).toLowerCase().includes("secretsmanager"),
    ),
  );
  check(
    "one connection means one shared status across channels",
    new Set(accounts.map((a) => a.connectionStatus)).size === 1,
  );

  // A personal Instagram account cannot be published to through Meta's API.
  const personal = createStoreWithPersonalInstagram();
  const [pi] = personal.createContent(USER_ID, [item()]);
  personal.humanApprove(USER_ID, pi!.variants[0]!.id);
  try {
    await personal.scheduleVariant(USER_ID, pi!.variants[0]!.id, future(), "key-personal");
    check("a PERSONAL Instagram account cannot be scheduled to", false, "it succeeded!");
  } catch (e) {
    check(
      "a PERSONAL Instagram account cannot be scheduled to",
      e instanceof StoreError && /business or creator/i.test(e.message),
      e instanceof StoreError ? e.message : String(e),
    );
  }

  try {
    st.createContent(USER_ID, [item({ variants: [variant({ channelId: "ch_nope" })] })]);
    check("an unknown channelId is rejected", false, "it succeeded!");
  } catch (e) {
    check("an unknown channelId is rejected", e instanceof StoreError);
  }

  // Facebook's hashtag limit is ours, not Meta's — but it is still enforced.
  try {
    st.createContent(USER_ID, [
      item({
        variants: [variant({ channelId: FB, hashtags: ["a", "b", "c", "d", "e"] })],
      }),
    ]);
    check("per-channel hashtag limit is enforced", false, "it succeeded!");
  } catch (e) {
    check("per-channel hashtag limit is enforced", e instanceof StoreError);
  }
}

// -- formats -----------------------------------------------------------------

{
  const st = createSeededStore();

  const [reel] = st.createContent(USER_ID, [
    item({
      variants: [
        variant({
          media: {
            format: "REEL",
            durationSeconds: 22,
            coverFrame: "First crack, close on the drum.",
            audio: "Natural sound, no music.",
            shotList: ["Beans in", "First crack", "Drop into cooling tray"],
          },
        }),
      ],
    }),
  ]);
  const rv = reel!.variants[0]!;
  check(
    "a REEL keeps its duration, cover frame and shot list",
    rv.media.format === "REEL" &&
      rv.media.durationSeconds === 22 &&
      rv.media.coverFrame.length > 0 &&
      rv.media.shotList.length === 3,
  );

  // The type system is what refuses an under-specified Reel. Parsing a raw
  // object proves the schema rejects it rather than silently filling defaults.
  const bad = VariantDraftSchema.safeParse({
    ...variant(),
    media: { format: "REEL", durationSeconds: 22 },
  });
  check("a REEL missing its cover frame fails validation", !bad.success);

  const tooLong = VariantDraftSchema.safeParse({
    ...variant(),
    media: {
      format: "REEL",
      durationSeconds: 300,
      coverFrame: "x",
      audio: "y",
      shotList: ["z"],
    },
  });
  check("a REEL over 90 seconds fails validation", !tooLong.success);

  const oneCard = VariantDraftSchema.safeParse({
    ...variant(),
    media: { format: "CAROUSEL", cards: ["only one"] },
  });
  check("a CAROUSEL with one card fails validation", !oneCard.success);

  const story = VariantDraftSchema.safeParse({
    ...variant(),
    media: { format: "STORY", visual: "Counter", interaction: "poll", interactionPrompt: "A or B?" },
  });
  check("a STORY with a poll validates", story.success);
}

// -- campaigns and two-phase planning ---------------------------------------

{
  const st = createSeededStore();

  const campaign = st.createCampaign(USER_ID, {
    name: "Cold brew season",
    goal: "Sell 200 cold brews in two weeks",
    keyMessage: "Eighteen hours steeped, no dilution.",
    startDate: "2126-10-01",
    endDate: "2126-10-14",
  });
  check("a campaign can be created", campaign.id.startsWith("camp_"));

  const slots = st.planSlots(USER_ID, [
    {
      topic: "Tease",
      coreMessage: "Something is steeping.",
      pillar: "New drinks and seasonal menu",
      contentCategory: "promotional",
      rationale: "Builds anticipation before launch.",
      campaignId: campaign.id,
      plannedFor: "2126-10-01T08:00:00+05:30",
      plannedChannelIds: [IG],
      plannedFormat: "STORY",
    },
    {
      topic: "Launch",
      coreMessage: "Cold brew is back.",
      pillar: "New drinks and seasonal menu",
      contentCategory: "promotional",
      rationale: "The announcement itself.",
      campaignId: campaign.id,
      plannedFor: "2126-10-03T09:00:00+05:30",
      plannedChannelIds: [IG, FB],
      plannedFormat: "POST",
    },
  ]);
  check("plan_calendar creates slots with no copy", slots.length === 2);
  check("slots carry their campaign", slots.every((s) => s.campaignId === campaign.id));
  check(
    "campaign item count reflects the slots",
    st.listCampaigns(USER_ID).find((c) => c.id === campaign.id)?.itemCount === 2,
  );

  // An unwritten slot must still be visible, or phase two plans it twice.
  const planned = st.getCalendar(USER_ID, { from: "2126-10-01", to: "2126-10-31" });
  check("unwritten slots appear on the calendar", planned.length === 2);
  check("unwritten slots have no variants yet", planned.every((i) => i.variants.length === 0));

  // Phase two fills the copy.
  const launch = slots.find((s) => s.topic === "Launch")!;
  const written = st.addVariants(USER_ID, launch.id, [
    variant({ channelId: IG, scheduledFor: "2126-10-03T09:00:00+05:30" }),
    variant({ channelId: FB, scheduledFor: "2126-10-03T09:00:00+05:30", hashtags: [] }),
  ]);
  check("write_slot_copy fills a planned slot", written.length === 2);
  check(
    "the filled slot now shows its variants",
    st.getItem(USER_ID, launch.id).variants.length === 2,
  );

  const items = st.getCampaignItems(USER_ID, campaign.id);
  check("campaign items come back in planned order", items[0]!.topic === "Tease");

  // A slot whose format the channel cannot do must be refused up front.
  try {
    st.planSlots(USER_ID, [
      {
        topic: "Bad",
        coreMessage: "x",
        pillar: "y",
        contentCategory: "promotional",
        rationale: "z",
        plannedFor: "2126-10-05T09:00:00+05:30",
        plannedChannelIds: ["ch_nope"],
        plannedFormat: "POST",
      },
    ]);
    check("a slot for an unknown channel is rejected", false, "it succeeded!");
  } catch (e) {
    check("a slot for an unknown channel is rejected", e instanceof StoreError);
  }
}

// -- publishing --------------------------------------------------------------

{
  const past = () => new Date(Date.now() - 60_000).toISOString();

  /** A store with one APPROVED variant scheduled in the past, ready to publish. */
  const readyToPublish = async (channelId = IG) => {
    const sched = new MockScheduler();
    const st = createSeededStore(sched);
    const [i] = st.createContent(USER_ID, [
      item({ variants: [variant({ channelId, hashtags: [] })] }),
    ]);
    const v = i!.variants[0]!;
    st.humanApprove(USER_ID, v.id);
    await st.scheduleVariant(USER_ID, v.id, future(1), `pubkey-${v.id}`);
    // Drag it into the past so the sweep picks it up.
    st.rescheduleForTest(v.id, past());
    return { st, variantId: v.id };
  };

  // Happy path.
  {
    const { st, variantId } = await readyToPublish();
    const connector = new MockMetaConnector();
    const pub = new Publisher(st, new MockTokenProvider(), [connector]);
    const [outcome] = await pub.publishDue(USER_ID);

    check("a due variant publishes", outcome?.status === "PUBLISHED", JSON.stringify(outcome));
    const v = st.getVariant(USER_ID, variantId);
    check("PUBLISHED is finally a reachable state", v.status === "PUBLISHED");
    check("the platform post id is recorded", !!v.platformPostId);
    check("publishedAt is set", !!v.publishedAt);
  }

  // Re-running the sweep must not post twice.
  {
    const { st, variantId } = await readyToPublish();
    const connector = new MockMetaConnector();
    const pub = new Publisher(st, new MockTokenProvider(), [connector]);
    await pub.publishDue(USER_ID);
    const first = st.getVariant(USER_ID, variantId).platformPostId;
    const second = await pub.publishOne(USER_ID, variantId);
    check(
      "re-publishing is a no-op, not a second post",
      second.status === "PUBLISHED" &&
        st.getVariant(USER_ID, variantId).platformPostId === first,
    );
  }

  // A dead token must break the CONNECTION, not just this one post.
  {
    const { st, variantId } = await readyToPublish();
    const connector = new MockMetaConnector();
    connector.failNext("AUTH");
    const pub = new Publisher(st, new MockTokenProvider(), [connector]);
    const [outcome] = await pub.publishDue(USER_ID);

    check("an AUTH failure marks the variant FAILED", outcome?.status === "FAILED");
    const accounts = st.getConnectedAccounts(USER_ID);
    check(
      "an AUTH failure takes BOTH Meta channels down together",
      accounts.length === 2 && accounts.every((a) => a.connectionStatus === "REAUTH_REQUIRED"),
      JSON.stringify(accounts.map((a) => a.connectionStatus)),
    );
  }

  // Transient failures must stay SCHEDULED so the next sweep retries them.
  {
    const { st, variantId } = await readyToPublish();
    const connector = new MockMetaConnector();
    connector.failNext("TRANSIENT");
    const pub = new Publisher(st, new MockTokenProvider(), [connector]);

    const [first] = await pub.publishDue(USER_ID);
    check("a TRANSIENT failure asks for a retry", first?.status === "RETRY");
    check(
      "a retryable failure leaves the variant SCHEDULED",
      st.getVariant(USER_ID, variantId).status === "SCHEDULED",
    );

    const [second] = await pub.publishDue(USER_ID);
    check("the retry succeeds on the next sweep", second?.status === "PUBLISHED");
  }

  // Rate limits behave like transient failures, not permanent ones.
  {
    const { st, variantId } = await readyToPublish();
    const connector = new MockMetaConnector();
    connector.failNext("RATE_LIMIT");
    const pub = new Publisher(st, new MockTokenProvider(), [connector]);
    await pub.publishDue(USER_ID);
    check(
      "a RATE_LIMIT failure is retryable, not fatal",
      st.getVariant(USER_ID, variantId).status === "SCHEDULED",
    );
  }

  // Permanent failures must stop, not spin.
  {
    const { st, variantId } = await readyToPublish();
    const connector = new MockMetaConnector();
    connector.failNext("PERMANENT");
    const pub = new Publisher(st, new MockTokenProvider(), [connector]);
    await pub.publishDue(USER_ID);
    const v = st.getVariant(USER_ID, variantId);
    check("a PERMANENT failure marks the variant FAILED", v.status === "FAILED");
    check("the failure reason is recorded", !!v.failureReason);
  }

  // Nothing that a human has not approved can ever reach the connector.
  {
    const sched = new MockScheduler();
    const st = createSeededStore(sched);
    const [i] = st.createContent(USER_ID, [item()]);
    const v = i!.variants[0]!;
    st.requestApproval(USER_ID, v.id);
    st.rescheduleForTest(v.id, past());

    const connector = new MockMetaConnector();
    const pub = new Publisher(st, new MockTokenProvider(), [connector]);
    const outcome = await pub.publishOne(USER_ID, v.id);
    check(
      "an unapproved variant is never published",
      outcome.status === "FAILED" && st.getVariant(USER_ID, v.id).status !== "PUBLISHED",
    );
  }

  // The sweep must only pick up things whose moment has arrived.
  {
    const { st } = await readyToPublish();
    const future2 = st.getDueVariants(new Date(Date.now() - 3600_000));
    check("the sweep ignores variants that are not due yet", future2.length === 0);
  }
}

// -- media -------------------------------------------------------------------

{
  const media = createMediaStore();
  const st = createSeededStore(new MockScheduler(), media);

  // Search is text-only. This is the whole cost strategy: a photo is ~1,500
  // tokens, so a fifty-asset library handed over on every turn would be ~75,000
  // tokens per turn.
  const all = media.search(USER_ID);
  check("the library is searchable", all.length > 0);
  check(
    "listing leaks no bytes, storage ref or public URL",
    all.every(
      (a) => !("storageRef" in a) && !("publicUrl" in a) && !("bytes" in a) && !("userId" in a),
    ),
  );

  const roaster = media.search(USER_ID, { query: "roaster" });
  check("search matches description and tags", roaster.length > 0);
  check("search can miss", media.search(USER_ID, { query: "elephant parade" }).length === 0);

  // Shape decides format eligibility.
  const reelable = media.search(USER_ID, { format: "REEL" });
  check(
    "only vertical video is offered for REEL",
    reelable.length > 0 &&
      reelable.every((a) => a.kind === "VIDEO" && a.aspectRatio === "9:16"),
  );
  const postable = media.search(USER_ID, { format: "POST" });
  check(
    "only square or 4:5 stills are offered for POST",
    postable.length > 0 &&
      postable.every((a) => a.kind === "IMAGE" && ["1:1", "4:5"].includes(a.aspectRatio)),
  );

  // The landscape shot exists precisely so this fails.
  const landscape = all.find((a) => a.aspectRatio === "16:9")!;
  check("a 16:9 landscape photo suits nothing", landscape.suitableFormats.length === 0);

  // A video is described from a frame, and says so rather than implying it was
  // watched.
  const video = all.find((a) => a.kind === "VIDEO")!;
  check("video is flagged as described from a frame", video.describedFrom === "VIDEO_FRAME");

  // Validation: the store refuses an asset that cannot be that format.
  try {
    st.createContent(USER_ID, [
      item({
        variants: [
          variant({
            media: {
              format: "REEL",
              durationSeconds: 20,
              coverFrame: "x",
              audio: "y",
              shotList: ["z"],
            },
            assetIds: ["asset_shopfront01"],
          }),
        ],
      }),
    ]);
    check("a landscape photo is refused as a REEL", false, "it succeeded!");
  } catch (e) {
    check("a landscape photo is refused as a REEL", e instanceof MediaError);
  }

  try {
    st.createContent(USER_ID, [
      item({ variants: [variant({ assetIds: ["asset_pour01", "asset_roaster01"] })] }),
    ]);
    check("a POST refuses two assets", false, "it succeeded!");
  } catch (e) {
    check("a POST refuses two assets", e instanceof MediaError);
  }

  try {
    st.createContent(USER_ID, [item({ variants: [variant({ assetIds: ["asset_nope"] })] })]);
    check("an unknown assetId is refused", false, "it succeeded!");
  } catch (e) {
    check("an unknown assetId is refused", e instanceof MediaError);
  }

  // The happy path, and the usage marker that powers unusedOnly.
  const [ok1] = st.createContent(USER_ID, [
    item({ variants: [variant({ assetIds: ["asset_pour01"] })] }),
  ]);
  check("a square photo is accepted as a POST", ok1!.variants[0]!.assetIds.length === 1);
  check(
    "using an asset marks it used",
    media.search(USER_ID, { unusedOnly: true }).every((a) => a.assetId !== "asset_pour01"),
  );

  // Planning without assets must still work — a month ahead there are no photos.
  const [brief] = st.createContent(USER_ID, [item({ variants: [variant({ assetIds: [] })] })]);
  check("content can still be planned with no assets", brief!.variants[0]!.assetIds.length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
