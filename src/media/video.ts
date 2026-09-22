/**
 * Reading dimensions and duration out of an MP4/MOV header.
 *
 * Done by hand rather than with ffmpeg because the whole of what we need —
 * width, height, duration — sits in two well-known atoms near the front of the
 * file. Pulling in a binary dependency for eight numbers is not worth it.
 *
 * What this deliberately does NOT do is describe the video. There is no video
 * input to the model, so an uploaded clip arrives undescribed and is flagged as
 * such. Pretending otherwise would have the agent planning confidently around
 * footage nobody has seen.
 */

export interface VideoInfo {
  width: number;
  height: number;
  durationSeconds: number | null;
}

const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function videoMimeFor(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return VIDEO_TYPES[ext] ?? null;
}

export function isVideo(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

/**
 * Walk the MP4 atom tree for `mvhd` (duration) and `tkhd` (dimensions).
 *
 * Returns null for anything it cannot parse — including WebM, which is a
 * completely different container. The caller falls back to asking the user
 * rather than guessing, because a wrong aspect ratio silently disqualifies a
 * clip from being a Reel.
 */
export function readVideoInfo(buf: Buffer): VideoInfo | null {
  try {
    const moov = findAtom(buf, 0, buf.length, "moov");
    if (!moov) return null;

    let durationSeconds: number | null = null;
    const mvhd = findAtom(buf, moov.start, moov.end, "mvhd");
    if (mvhd) {
      const version = buf[mvhd.start]!;
      // version 0 stores 32-bit times, version 1 stores 64-bit.
      const base = mvhd.start + 4;
      const timescale = version === 1 ? buf.readUInt32BE(base + 16) : buf.readUInt32BE(base + 8);
      const duration =
        version === 1 ? Number(buf.readBigUInt64BE(base + 20)) : buf.readUInt32BE(base + 12);
      if (timescale > 0) durationSeconds = Math.round(duration / timescale);
    }

    // The first track with non-zero dimensions is the video track; audio tracks
    // report 0x0, which is how we skip them without parsing handler types.
    let width = 0;
    let height = 0;
    let cursor = moov.start;
    while (cursor < moov.end) {
      const trak = findAtom(buf, cursor, moov.end, "trak");
      if (!trak) break;
      const tkhd = findAtom(buf, trak.start, trak.end, "tkhd");
      if (tkhd) {
        // Width and height are the final eight bytes, as 16.16 fixed point.
        const w = buf.readUInt32BE(tkhd.end - 8) / 65536;
        const h = buf.readUInt32BE(tkhd.end - 4) / 65536;
        if (w > 0 && h > 0) {
          width = Math.round(w);
          height = Math.round(h);
          break;
        }
      }
      cursor = trak.end;
    }

    if (!width || !height) return null;
    return { width, height, durationSeconds };
  } catch {
    return null;
  }
}

/** Find a direct-or-nested atom by type within a byte range. */
function findAtom(
  buf: Buffer,
  from: number,
  to: number,
  type: string,
): { start: number; end: number } | null {
  let offset = from;
  while (offset + 8 <= to) {
    const size = buf.readUInt32BE(offset);
    const atom = buf.toString("ascii", offset + 4, offset + 8);
    // A size of 0 means "to end of file"; 1 means a 64-bit size follows.
    const length = size === 0 ? to - offset : size === 1 ? Number(buf.readBigUInt64BE(offset + 8)) : size;
    if (length < 8) return null;

    const bodyStart = size === 1 ? offset + 16 : offset + 8;
    const end = Math.min(offset + length, to);

    if (atom === type) return { start: bodyStart, end };

    // moov and trak are containers; descend rather than skipping past them.
    if (atom === "moov" || atom === "trak" || atom === "mdia") {
      const inner = findAtom(buf, bodyStart, end, type);
      if (inner) return inner;
    }

    offset += length;
  }
  return null;
}
