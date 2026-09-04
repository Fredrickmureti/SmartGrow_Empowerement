/**
 * One KYC image slot: client portrait or an ID card side.
 *
 * Shows the stored image (signed URL) or a freshly captured preview, and
 * offers two equal paths — take a photo in-app or pick one from the device.
 * The slot only holds the pending change; the form uploads on save.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ImagePlus, Trash2, User, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useKycImageUrl } from "@/hooks/useMfClients";
import { CameraCaptureDialog, type CaptureFrame } from "./CameraCaptureDialog";

/** `undefined` = untouched, `null` = remove stored image, Blob = new image. */
export type KycPending = Blob | null | undefined;

interface KycCaptureFieldProps {
  label: string;
  hint?: string;
  frame: CaptureFrame;
  storedPath: string | null;
  pending: KycPending;
  onChange: (next: KycPending) => void;
  optional?: boolean;
  className?: string;
}

const MAX_EDGE = 1600;

/** Re-encode any picked image as a bounded JPEG so uploads stay small. */
async function normaliseImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.88),
  );
}

export function KycCaptureField({
  label,
  hint,
  frame,
  storedPath,
  pending,
  onChange,
  optional,
  className,
}: KycCaptureFieldProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const { data: storedUrl } = useKycImageUrl(pending === undefined ? storedPath : null);

  const pendingUrl = useMemo(
    () => (pending instanceof Blob ? URL.createObjectURL(pending) : null),
    [pending],
  );
  useEffect(() => () => {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
  }, [pendingUrl]);

  const src = pendingUrl ?? (pending === undefined ? storedUrl ?? null : null);
  const hasImage = !!src;
  const Placeholder = frame === "portrait" ? User : CreditCard;

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    onChange(await normaliseImage(file));
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium leading-none">
          {label}
          {optional && <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>}
        </span>
        {hasImage && (
          <button
            type="button"
            onClick={() => onChange(storedPath ? null : undefined)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
            Remove
          </button>
        )}
      </div>

      <div
        className={cn(
          "group relative overflow-hidden rounded-xl border bg-muted/40 transition-colors",
          !hasImage && "border-dashed hover:border-primary/50 hover:bg-muted/70",
          frame === "portrait" ? "aspect-[3/4]" : "aspect-[1.586]",
        )}
      >
        {hasImage ? (
          <img src={src!} alt={label} className="h-full w-full object-cover" />
        ) : (
          <button
            type="button"
            onClick={() => setCameraOpen(true)}
            className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground"
          >
            <span className="rounded-full bg-background p-3 shadow-sm ring-1 ring-border">
              <Placeholder className="h-5 w-5" />
            </span>
            <span className="text-xs leading-snug">{hint ?? "Tap to take a photo"}</span>
          </button>
        )}

        {hasImage && (
          <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1.5 bg-gradient-to-t from-foreground/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={() => setCameraOpen(true)}>
              <Camera className="mr-1 h-3.5 w-3.5" />
              Retake
            </Button>
            <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={() => fileRef.current?.click()}>
              <ImagePlus className="mr-1 h-3.5 w-3.5" />
              Replace
            </Button>
          </div>
        )}
      </div>

      {!hasImage && (
        <div className="grid grid-cols-2 gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={() => setCameraOpen(true)}>
            <Camera className="mr-1.5 h-3.5 w-3.5" />
            Camera
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
            Upload
          </Button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pickFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <CameraCaptureDialog
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        title={label}
        frame={frame}
        onCapture={(blob) => onChange(blob)}
      />
    </div>
  );
}
