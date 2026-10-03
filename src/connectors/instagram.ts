import {
  PublishError,
  type PublishRequest,
  type PublishResult,
  type SocialConnector,
} from "./types.js";
import type { Platform, Provider } from "../schemas.js";

/**
 * Publishing to Instagram, for real.
 *
 * Instagram does not have a "post" endpoint. Publishing is two calls with a
 * wait in the middle:
 *
 *   POST /{ig-user-id}/media           create a CONTAINER, get a creation id
 *   (poll until the container is FINISHED — videos take seconds to minutes)
 *   POST /{ig-user-id}/media_publish   publish that container
 *
 * That shape is the reason the publisher is a background worker rather than a
 * request handler: a Reel can spend minutes in processing, which no HTTP
 * request should wait on.
 *
 * Nothing above this file knows any of it. The publisher calls `publish` and
 * gets a post id back, exactly as it does from the mock.
 *
 * https://developers.facebook.com/docs/instagram-platform/content-publishing/
 */

const GRAPH = "https://graph.instagram.com/v23.0";

/** Meta's own ceiling: 100 published posts per account per rolling 24h. */
const DAILY_LIMIT_HINT = 100;

interface ContainerStatus {
  status_code?: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
  status?: string;
}

export class InstagramConnector implements SocialConnector {
  readonly provider: Provider = "instagram";
  readonly platforms: Platform[] = ["instagram"];

  constructor(
    /** How long to wait for a container to finish processing. */
    private maxPollMs = 5 * 60_000,
    private pollIntervalMs = 3_000,
    private log: (line: string) => void = () => {},
  ) {}

  async publish(request: PublishRequest, accessToken: string): Promise<PublishResult> {
    const caption = this.captionFor(request);

    if (request.mediaUrls.length === 0) {
      // Instagram has no text-only post. Catching it here gives a clear reason
      // rather than a Graph API error about a missing image_url.
      throw new PublishError(
        "Instagram posts require at least one image or video.",
        "PERMANENT",
      );
    }

    const creationId = await this.createContainer(request, caption, accessToken);
    await this.awaitProcessing(creationId, accessToken);
    const postId = await this.publishContainer(request.externalId, creationId, accessToken);

    return {
      platformPostId: postId,
      permalink: await this.permalinkFor(postId, accessToken),
      publishedAt: new Date().toISOString(),
    };
  }

  /**
   * Hashtags are part of the caption on Instagram.
   *
   * There is no hashtags field — they are plain text that Instagram parses. The
   * domain model keeps them separate because the two platforms treat them
   * differently (Facebook reads a wall of them as spam), and the connector is
   * where that difference is resolved.
   */
  private captionFor(request: PublishRequest): string {
    const tags = request.hashtags.map((h) => `#${h}`).join(" ");
    return tags ? `${request.caption}\n\n${tags}` : request.caption;
  }

  private async createContainer(
    request: PublishRequest,
    caption: string,
    accessToken: string,
  ): Promise<string> {
    const format = request.media.format;

    // A carousel is built from child containers, which is a different shape
    // from every other format — each child is created first, then a parent
    // container collects them.
    if (format === "CAROUSEL") {
      const children = await Promise.all(
        request.mediaUrls.map((url) =>
          this.post(`${request.externalId}/media`, accessToken, {
            image_url: url,
            is_carousel_item: "true",
          }),
        ),
      );
      return this.post(`${request.externalId}/media`, accessToken, {
        media_type: "CAROUSEL",
        children: children.map((c) => c.id).join(","),
        caption,
      }).then((r) => r.id);
    }

    const url = request.mediaUrls[0]!;
    const isVideo = /\.(mp4|mov)(\?|$)/i.test(url);

    const params: Record<string, string> = { caption };
    if (format === "REEL") {
      params.media_type = "REELS";
      params.video_url = url;
    } else if (format === "STORY") {
      params.media_type = "STORIES";
      // A Story can be either, and unlike a feed post there is no caption.
      delete params.caption;
      if (isVideo) params.video_url = url;
      else params.image_url = url;
    } else {
      params.image_url = url;
    }

    return this.post(`${request.externalId}/media`, accessToken, params).then((r) => r.id);
  }

  /**
   * Wait for Meta to finish processing the container.
   *
   * Images are usually ready immediately; video is not. Publishing a container
   * that is still IN_PROGRESS fails, so this is not optional politeness — it is
   * the step that makes Reels work at all.
   */
  private async awaitProcessing(creationId: string, accessToken: string): Promise<void> {
    const deadline = Date.now() + this.maxPollMs;

    for (;;) {
      const status = (await this.get(creationId, accessToken, {
        fields: "status_code,status",
      })) as ContainerStatus;

      if (status.status_code === "FINISHED") return;

      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        // The media itself was rejected — wrong codec, too long, bad aspect
        // ratio. Retrying the same asset will fail identically.
        throw new PublishError(
          `Instagram could not process the media: ${status.status ?? status.status_code}`,
          "PERMANENT",
        );
      }

      if (Date.now() > deadline) {
        // TRANSIENT, not PERMANENT: the container may still finish, and the
        // next sweep will find the variant still SCHEDULED and try again.
        throw new PublishError(
          `Media was still processing after ${Math.round(this.maxPollMs / 1000)}s`,
          "TRANSIENT",
        );
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private async publishContainer(
    igUserId: string,
    creationId: string,
    accessToken: string,
  ): Promise<string> {
    const result = await this.post(`${igUserId}/media_publish`, accessToken, {
      creation_id: creationId,
    });
    return result.id;
  }

  /** Best effort. A post that published but whose link we could not read is still published. */
  private async permalinkFor(postId: string, accessToken: string): Promise<string | null> {
    try {
      const result = (await this.get(postId, accessToken, { fields: "permalink" })) as {
        permalink?: string;
      };
      return result.permalink ?? null;
    } catch {
      return null;
    }
  }

  private async post(
    path: string,
    accessToken: string,
    params: Record<string, string>,
  ): Promise<{ id: string }> {
    const body = new URLSearchParams({ ...params, access_token: accessToken });
    const res = await fetch(`${GRAPH}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return (await this.unwrap(res)) as { id: string };
  }

  private async get(
    path: string,
    accessToken: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const query = new URLSearchParams({ ...params, access_token: accessToken });
    return this.unwrap(await fetch(`${GRAPH}/${path}?${query}`));
  }

  /**
   * Turn a Graph API response into a result or a typed failure.
   *
   * The mapping is the whole point of this method. The publisher's policy —
   * retry, back off, mark the connection dead, give up — is driven by the
   * FailureKind, so getting these wrong means a dead token retried forever or
   * a transient blip marked permanently failed.
   */
  private async unwrap(res: Response): Promise<unknown> {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    };

    if (res.ok && !body.error) return body;

    const error = body.error ?? {};
    const message = error.message ?? `Instagram returned ${res.status}`;

    // 190 is the token itself: revoked, expired, or invalidated by an account
    // change. The user has to reconnect; no amount of retrying helps.
    if (error.code === 190 || res.status === 401) {
      throw new PublishError(message, "AUTH");
    }

    // 4 is the app-level rate limit, 32 the page-level one, 613 a custom
    // throttle. The content is fine — only the timing is wrong.
    if (error.code === 4 || error.code === 32 || error.code === 613 || res.status === 429) {
      throw new PublishError(
        `${message} (Instagram allows ~${DAILY_LIMIT_HINT} API posts per account per day)`,
        "RATE_LIMIT",
      );
    }

    // 1 and 2 are Meta's own "unknown error, please retry", and any 5xx is
    // theirs rather than ours.
    if (error.code === 1 || error.code === 2 || res.status >= 500) {
      throw new PublishError(message, "TRANSIENT");
    }

    // Everything else is the request: a caption too long, an aspect ratio the
    // format forbids, an unreachable media URL. Retrying sends the same bytes.
    throw new PublishError(message, "PERMANENT");
  }
}
