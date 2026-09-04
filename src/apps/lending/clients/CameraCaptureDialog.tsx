/**
 * In-app camera capture.
 *
 * Opens the device camera (rear camera on phones for documents, front for a
 * client portrait), shows a live viewfinder with a framing guide, and hands
 * back a JPEG blob. Falls back to a clear message when the camera is
 * unavailable so the caller can offer file upload instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, SwitchCamera, Check, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CaptureFrame = "portrait" | "card";

interface CameraCaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  frame: CaptureFrame;
  onCapture: (blob: Blob) => void;
}

const MAX_EDGE = 1600;

export function CameraCaptureDialog({
  open,
  onOpenChange,
  title,
  frame,
  onCapture,
}: CameraCaptureDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">(
    frame === "portrait" ? "user" : "environment",
  );
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [ready, setReady] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  const start = useCallback(async () => {
    stop();
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This device or browser does not expose a camera. Upload a photo instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setReady(true);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "Camera access was blocked. Allow the camera in your browser, or upload a photo instead."
          : "Could not start the camera. Upload a photo instead.",
      );
    }
  }, [facing, stop]);

  useEffect(() => {
    if (!open) {
      stop();
      if (shot) URL.revokeObjectURL(shot.url);
      setShot(null);
      return;
    }
    void start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, facing]);

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (facing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setShot({ blob, url: URL.createObjectURL(blob) });
        stop();
      },
      "image/jpeg",
      0.9,
    );
  };

  const retake = () => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    void start();
  };

  const usePhoto = () => {
    if (!shot) return;
    onCapture(shot.blob);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3 p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {frame === "portrait"
              ? "Centre the face inside the oval, with good light and a plain background."
              : "Lay the card flat, fill the frame, and avoid glare on the print."}
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-foreground/90">
          {shot ? (
            <img src={shot.url} alt="Captured" className="h-full w-full object-contain" />
          ) : (
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className={cn(
                "h-full w-full object-cover",
                facing === "user" && "-scale-x-100",
              )}
            />
          )}

          {!shot && ready && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={cn(
                  "border-2 border-dashed border-background/80 shadow-[0_0_0_9999px_hsl(var(--foreground)/0.35)]",
                  frame === "portrait"
                    ? "h-[78%] w-[54%] rounded-[50%]"
                    : "aspect-[1.586] w-[82%] rounded-lg",
                )}
              />
            </div>
          )}

          {!shot && !ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-background/80">
              Starting camera…
            </div>
          )}

          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-background">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          {shot ? (
            <>
              <Button variant="outline" onClick={retake}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retake
              </Button>
              <Button onClick={usePhoto}>
                <Check className="mr-2 h-4 w-4" />
                Use photo
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
                disabled={!ready}
              >
                <SwitchCamera className="mr-2 h-4 w-4" />
                Flip
              </Button>
              <Button
                size="lg"
                className="h-12 w-12 rounded-full p-0"
                onClick={takePhoto}
                disabled={!ready}
                aria-label="Take photo"
              >
                <Camera className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
