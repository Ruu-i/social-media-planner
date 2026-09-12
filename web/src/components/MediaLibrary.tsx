import { useRef, useState } from "react";
import { api, type MediaAsset } from "../api";
import { Thumb } from "../ui";

/**
 * The media library.
 *
 * A grid rather than a list: assets are visual, and a list of 56px thumbnails
 * beside a wall of text was most of the empty space in the first version.
 *
 * Uploading runs the vision pass ONCE, server-side, while the user is already
 * waiting — never on a planning turn. What comes back is shown immediately,
 * because it is the most direct evidence the model actually looked.
 */
export function MediaLibrary({
  assets,
  onChanged,
}: {
  assets: MediaAsset[];
  onChanged: () => void;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<MediaAsset | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setJustAdded(null);
    setUploading(file.name);
    try {
      const dataBase64 = await toBase64(file);
      const { asset } = await api.upload(file.name, dataBase64);
      setJustAdded(asset);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  }

  return (
    <div className="space-y-4 px-5 py-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(e.dataTransfer.files);
        }}
        onClick={() => fileInput.current?.click()}
        className={`cursor-pointer rounded-xl border border-dashed px-4 py-5 text-center transition ${
          dragging
            ? "border-amber-400 bg-amber-50"
            : "border-violet-300 bg-white/50 hover:border-violet-400 hover:bg-white/70"
        }`}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={(e) => void upload(e.target.files)}
        />
        {uploading ? (
          <p className="flex items-center justify-center gap-2 text-[13px] text-stone-600">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            Looking at {uploading}…
          </p>
        ) : (
          <>
            <p className="text-[13px] font-medium text-stone-700">
              Drop a photo, or click to choose
            </p>
            <p className="mt-0.5 text-[11px] text-stone-500">
              Described once on upload — never on every plan
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
          {error}
        </div>
      )}

      {justAdded && (
        <div className="animate-fade-up rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-[11px] font-semibold text-emerald-700">
            Described — the agent can find this photo now
          </p>
          <p className="mt-1 text-[13px] text-stone-700">
            {justAdded.description}
          </p>
          <p className="mt-1 text-[11px] text-stone-500">{justAdded.tags.join(" · ")}</p>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {assets.map((asset) => (
          <AssetCard key={asset.assetId} asset={asset} />
        ))}
      </div>
    </div>
  );
}

function AssetCard({ asset }: { asset: MediaAsset }) {
  const unusable = asset.suitableFormats.length === 0;

  return (
    <div className="group overflow-hidden card card-hover rounded-xl border border-white/80 bg-white/95 backdrop-blur-sm transition hover:border-violet-200">
      <div className="relative">
        <Thumb asset={asset} size={0} className="!h-32 !w-full rounded-none" />
        <span className="absolute top-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          {asset.aspectRatio}
          {asset.durationSeconds ? ` · ${asset.durationSeconds}s` : ""}
        </span>
      </div>

      <div className="space-y-2 p-2.5">
        <p className="line-clamp-2 text-[11px] leading-snug text-stone-600">
          {asset.description}
        </p>

        {/* An asset's shape decides what it CAN be. These are capabilities, not
            schedule — without the label they read as "a Reel exists", which is
            the opposite of what they mean. */}
        <div className="flex flex-wrap items-center gap-1">
          {!unusable && (
            <span className="text-[10px] text-stone-400">usable as</span>
          )}
          {unusable ? (
            <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">
              wrong shape for any format
            </span>
          ) : (
            asset.suitableFormats.map((f) => (
              <span
                key={f}
                className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600"
              >
                {f}
              </span>
            ))
          )}
          {asset.describedFrom === "VIDEO_FRAME" && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
              one frame only
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The result is a data URL; the server wants only the payload after the comma.
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
