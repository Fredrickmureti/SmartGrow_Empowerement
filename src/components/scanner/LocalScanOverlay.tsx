/**
 * LocalScanOverlay — the device-local viewfinder (handheld mode).
 *
 * Mounted ONCE for the authenticated app. Opened by `openLocalScan(...)`
 * from any scan field or task screen. Decodes with `useCameraDecoder`,
 * beeps via `feedbackTones`, then hands the code to `scanBus` through
 * `localScanService.emitDecoded` so `scanRouter` delivers it to the
 * active target — identical to a wedge scan.
 *
 * If no target consumed the scan we say so instead of silently dropping
 * it: an operator staring at a viewfinder that "works" while nothing is
 * captured is the worst possible failure mode on a warehouse floor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Zap, ZapOff, ScanLine, Loader2, Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { scanRouter } from "@/services/pos/scanRouter";
import { beepForScan } from "@/services/scanner/scanBeep";
import { useCameraDecoder } from "@/services/scanner/camera/useCameraDecoder";
import {
  localScanService,
  type LocalScanRequest,
} from "@/services/scanner/camera/localScanService";

interface Hit {
  code: string;
  accepted: boolean;
  at: number;
}

export function LocalScanOverlay() {
  const [request, setRequest] = useState<LocalScanRequest | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const acceptedRef = useRef(0);

  useEffect(() => localScanService.subscribe(setRequest), []);

  useEffect(() => {
    if (request) {
      setHits([]);
      acceptedRef.current = 0;
    }
  }, [request]);

  const continuous = request?.continuous === true;

  const onDecode = useCallback(
    (raw: string) => {
      const event = localScanService.emitDecoded(raw);
      const accepted = scanRouter.wasConsumed(event);
      if (accepted) acceptedRef.current += 1;
      // Deduped: if the target produces a verdict, that ack beeps instead
      // (and may escalate to duplicate/invalid).
      beepForScan(event.code, accepted ? "ok" : "invalid");
      setHits((prev) => [{ code: event.code, accepted, at: event.at }, ...prev].slice(0, 6));
      if (accepted && !continuous) {
        // Let the tone start before the overlay tears the camera down.
        setTimeout(() => localScanService.close(acceptedRef.current), 120);
      }
    },
    [continuous],
  );

  const { scanning, error, torchAvailable, torchOn, toggleTorch } = useCameraDecoder({
    enabled: request !== null,
    videoRef,
    formats: request?.formats,
    onDecode,
  });

  // Background the tab → release the camera. Matches the phone cockpit.
  useEffect(() => {
    if (!request) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") localScanService.close(acceptedRef.current);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [request]);

  if (!request) return null;

  const last = hits[0];

  return (
    <div className="fixed inset-0 z-[120] flex flex-col bg-black/95">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <div className="flex min-w-0 items-center gap-2">
          <ScanLine className="h-5 w-5 shrink-0" />
          <span className="truncate font-medium">{request.label ?? "Scan"}</span>
        </div>
        <div className="flex items-center gap-1">
          {torchAvailable && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTorch}
              aria-label={torchOn ? "Turn torch off" : "Turn torch on"}
              className="text-white hover:bg-white/10"
            >
              {torchOn ? <Zap className="h-5 w-5" /> : <ZapOff className="h-5 w-5" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close scanner"
            onClick={() => localScanService.close(acceptedRef.current)}
            className="text-white hover:bg-white/10"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={cn(
              "h-40 w-[80%] max-w-sm rounded-lg border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]",
              last ? (last.accepted ? "border-emerald-400" : "border-red-400") : "border-white/80",
            )}
          />
        </div>
        {!scanning && !error && (
          <div className="absolute inset-x-0 bottom-12 flex items-center justify-center gap-2 text-sm text-white/90">
            <Loader2 className="h-4 w-4 animate-spin" /> Starting camera…
          </div>
        )}
      </div>

      <div className="space-y-2 px-4 pb-6 pt-3 text-sm text-white/85">
        {error ? (
          <Alert variant="destructive" className="text-left">
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        ) : last ? (
          <div
            className={cn(
              "flex items-center gap-2 font-mono text-xs",
              last.accepted ? "text-emerald-300" : "text-red-300",
            )}
          >
            {last.accepted ? (
              <Check className="h-4 w-4 shrink-0" />
            ) : (
              <TriangleAlert className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{last.code}</span>
            <span className="ml-auto shrink-0 font-sans">
              {last.accepted ? "captured" : "no field is listening"}
            </span>
          </div>
        ) : (
          <div className="text-center text-white/70">Point the camera at the barcode.</div>
        )}
        {continuous && (
          <div className="flex items-center justify-between text-xs text-white/70">
            <span>{acceptedRef.current} scanned</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => localScanService.close(acceptedRef.current)}
            >
              Done
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
