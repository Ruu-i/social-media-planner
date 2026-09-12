import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * The vision pass.
 *
 * Runs ONCE per asset, at upload, while the user is already waiting for the
 * file to finish uploading. Its output is what the planning agent searches
 * forever after, which is why this is the piece that makes the whole media
 * feature affordable.
 *
 * Deliberately uses a cheap model: describing a photo is not a reasoning task,
 * and this runs once per file rather than once per plan.
 */

const DESCRIBE_MODEL = "claude-haiku-4-5";

const DescriptionSchema = z.object({
  description: z
    .string()
    .describe(
      "What is actually in the frame, in two or three sentences. Concrete and " +
        "specific: the subject, the setting, the light, anything a caption could " +
        "reasonably refer to. Not an interpretation, a description.",
    ),
  tags: z
    .array(z.string())
    .min(3)
    .max(12)
    .describe(
      "Lowercase single words or short phrases someone would search for later: " +
        "subjects, objects, setting, mood. e.g. 'roaster', 'latte art', 'people', " +
        "'close-up', 'morning light'.",
    ),
  hasTextInFrame: z
    .boolean()
    .describe("Whether there is significant text, a logo, or a graphic overlay in the image"),
  quality: z
    .enum(["good", "usable", "poor"])
    .describe("Is this publishable as-is? poor = blurry, badly lit, or unusable"),
});

export type AssetDescription = z.infer<typeof DescriptionSchema>;

const client = new Anthropic();

/** Media types the vision API accepts. */
const SUPPORTED = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type SupportedMedia = (typeof SUPPORTED)[number];

export function canDescribe(mimeType: string): mimeType is SupportedMedia {
  return (SUPPORTED as readonly string[]).includes(mimeType);
}

/**
 * Describe one image.
 *
 * For a VIDEO, the caller must extract a frame first and pass that — there is no
 * video input, and pretending otherwise would have the agent confidently
 * planning around motion it has never seen.
 */
export async function describeImage(
  data: Buffer,
  mimeType: string,
  context?: { businessName?: string; industry?: string },
): Promise<AssetDescription> {
  if (!canDescribe(mimeType)) {
    throw new Error(
      `${mimeType} cannot be described. Supported: ${SUPPORTED.join(", ")}. ` +
        `For video, extract a frame first.`,
    );
  }

  const about = context?.businessName
    ? `The business is ${context.businessName}` +
      (context.industry ? ` (${context.industry}).` : ".")
    : "";

  const response = await client.messages.parse({
    model: DESCRIBE_MODEL,
    max_tokens: 1024,
    system:
      "You catalogue photographs for a social media content library. You describe " +
      "what is in front of you plainly and specifically, so that someone searching " +
      "the library months later can find this image from the description alone. " +
      "You never invent detail you cannot see, and you never editorialise.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: data.toString("base64") } },
          { type: "text", text: `Catalogue this image. ${about}`.trim() },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(DescriptionSchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Claude declined to describe this image (${response.stop_details?.category ?? "unknown"}).`,
    );
  }
  if (!response.parsed_output) {
    throw new Error("Vision pass returned output that did not match the schema");
  }

  return response.parsed_output;
}
