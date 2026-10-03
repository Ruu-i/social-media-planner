import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";

/**
 * Turn stored conversation messages back into something a UI can render.
 *
 * The store keeps the model's view of the conversation — tool calls, tool
 * results, thinking blocks, and user turns with the time context and any
 * attached-media block prepended. None of that belongs on screen: the user
 * never typed `<current_time>`, and showing it back to them would be baffling.
 *
 * This exists because reloading the browser lost the whole conversation. The
 * history was never gone — it was in DynamoDB the entire time — but the UI
 * minted a new session id on every mount and so could never find it.
 */

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

/** Blocks the agent injects around what the user actually wrote. */
const INJECTED = /<(current_time|attached_media)>[\s\S]*?<\/\1>/g;

export function toTranscript(messages: BetaMessageParam[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const message of messages) {
    const text = textOf(message.content);
    if (!text) continue;

    const clean = message.role === "user" ? text.replace(INJECTED, "").trim() : text.trim();

    // A user turn that was ONLY injected context is a tool-result carrier, not
    // something a person said. Dropping it keeps the transcript readable.
    if (!clean) continue;

    // Only the two roles a person sees. A system turn is configuration, not
    // conversation, and should never render as a chat bubble.
    if (message.role !== "user" && message.role !== "assistant") continue;
    entries.push({ role: message.role, text: clean });
  }

  return entries;
}

function textOf(content: BetaMessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { type: "text"; text: string } => {
      // Only visible prose. Thinking is the model's private reasoning, and
      // tool_use / tool_result are machinery — replaying either as chat would
      // be noise at best and confusing at worst.
      const type = (block as { type?: string }).type;
      return type === "text" && typeof (block as { text?: unknown }).text === "string";
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}
