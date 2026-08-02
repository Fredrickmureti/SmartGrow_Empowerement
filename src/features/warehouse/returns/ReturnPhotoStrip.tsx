/**
 * ReturnPhotoStrip — condition evidence for one return line.
 *
 * Damage and defect claims are only defensible with photographic evidence
 * captured at the dock, so this sits directly inside the inspection dialog:
 * the operator photographs the unit while it is in their hands, not later.
 *
 * Capture goes through `useUploadReturnPhoto` (storage + `wms_return_photos`
 * pointer + line photo_count). Viewing uses short-lived signed URLs — return
 * evidence is never public.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Camera, ImageOff, Loader2 } from "lucide-react";
import { returnPhotoUrl, useReturnPhotos, useUploadReturnPhoto } from "./useReturnPhotos";
import type { ReturnLine, ReturnOrder } from "./returnsModel";

export interface ReturnPhotoStripProps {
  order: ReturnOrder;
  line: ReturnLine;
  /** Evidence class recorded against the photo row. */
  kind?: string;
  readOnly?: boolean;
}

export function ReturnPhotoStrip({ order, line, kind = "condition", readOnly = false }: ReturnPhotoStripProps) {
  const { data: photos, isLoading } = useReturnPhotos(order.id);
  const upload = useUploadReturnPhoto();
  const [urls, setUrls] = useState<Record<string, string>>({});

  const linePhotos = (photos ?? []).filter((p) => p.return_line_id === line.id);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const p of linePhotos) {
        if (urls[p.id]) continue;
        const url = await returnPhotoUrl(p);
        if (url) next[p.id] = url;
      }
      if (!cancelled && Object.keys(next).length) setUrls((u) => ({ ...u, ...next }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linePhotos.map((p) => p.id).join(",")]);

  const onPick = (file: File | undefined) => {
    if (!file) return;
    upload.mutate(
      {
        organizationId: order.organization_id,
        businessId: order.business_id,
        returnId: order.id,
        lineId: line.id,
        file,
        kind,
      },
      {
        onSuccess: () => toast.success("Evidence attached"),
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Upload failed"),
      },
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          Evidence{" "}
          <span className="text-muted-foreground tabular-nums">({linePhotos.length})</span>
        </span>
        {!readOnly && (
          <label className="inline-flex">
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                onPick(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
            <Button asChild size="sm" variant="outline" disabled={upload.isPending}>
              <span>
                {upload.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Camera className="mr-1.5 h-3.5 w-3.5" />
                )}
                Add photo
              </span>
            </Button>
          </label>
        )}
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading evidence…</p>
      ) : linePhotos.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageOff className="h-3.5 w-3.5" /> No photos captured for this line.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {linePhotos.map((p) => (
            <a
              key={p.id}
              href={urls[p.id] ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="block h-16 w-16 overflow-hidden rounded-md border bg-muted"
              title={p.caption ?? p.kind}
            >
              {urls[p.id] ? (
                <img
                  src={urls[p.id]}
                  alt={p.caption ?? `Return evidence (${p.kind})`}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
                  …
                </span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
