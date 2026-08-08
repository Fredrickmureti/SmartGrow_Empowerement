/**
 * LocalScanOverlay — the device-local viewfinder (handheld mode).
 *
 * Mounted ONCE for the authenticated app. Opened by `openLocalScan(...)`
 * from any scan field or task screen. Decodes with `useCameraDecoder`,
 * then hands the code to `scanBus` through `localScanService.emitDecoded`
 * so `scanRouter` delivers it to the active target — identical to a wedge
 * scan.
 *
 * Outcome truthfulness (the important part): `scanRouter.wasConsumed()`
 * only says a target RECEIVED the code — it says nothing about whether the
 * code resolved to a product. Reporting that as success is how an operator
 * ends up with a green tick, a happy beep, a closed camera, and no line on
 * the document. So a routed scan starts as PENDING and waits for a real
 * business verdict on `scanFeedbackBus` (matched / unknown / failed)
 * before it beeps, counts, or closes the viewfinder.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Zap, ZapOff, ScanLine, Loader2, Check, TriangleAlert, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { scanRouter } from "@/services/pos/scanRouter";
import { beepForScan } from "@/services/scanner/scanBeep";
import { scanFeedbackBus } from "@/services/scanner";
import { useCameraDecoder } from "@/services/scanner/camera/useCameraDecoder";
import {
  localScanService,
  type LocalScanRequest,
} from "@/services/scanner/camera/localScanService";

/** How long we wait for a downstream verdict before assuming plain capture. */
const VERDICT_TIMEOUT_MS = 2000;

type HitState = "pending" | "matched" | "unknown" | "failed" | "dropped";

interface Hit {
  id: string;
  code: string;
  state: HitState;
  detail?: string;
  at: number;
}

const STATE_COPY: Record<HitState, string> = {
  pending: "checking…",
  matched: "captured",
  unknown: "not recognised",
  failed: "lookup failed",
  dropped: "no field is listening",
};

export function LocalScanOverlay() {
  const [request, setRequest] = useState<LocalScanRequest | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const acceptedRef = useRef(0);
  const continuousRef = useRef(false);
  const timersRef = useRef<Map<string, number>>(new Map());
  const seqRef = useRef(0);

  useEffect(() => localScanService.subscribe(setRequest), []);

  useEffect(() => {
    if (request) {
      setHits([]);
      acceptedRef.current = 0;
    }
  }, [request]);

  const continuous = request?.continuous === true;
  continuousRef.current = continuous;

  // Clear any outstanding verdict timers on unmount / close.
  useEffect(() => {
    if (request) return;
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current.clear();
  }, [request]);

  const settle = useCallback((code: string, state: Exclude<HitState, "pending">, detail?: string) => {
    setHits((prev) => {
      let changed = false;
      const next = prev.map((h) => {
        if (changed || h.state !== "pending" || h.code !== code) return h;
        changed = true;
        return { ...h, state, detail };
      });
      if (!changed) return prev;
      return next;
    });
    const timer = timersRef.current.get(code);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(code);
    }
    if (state === "matched") {
      acceptedRef.current += 1;
      beepForScan(code, "ok");
      if (!continuousRef.current) {
        // Let the tone start before the camera tears down.
        window.setTimeout(() => localScanService.close(acceptedRef.current), 140);
      }
      return;
    }
    // Anything else keeps the viewfinder OPEN so the operator sees why.
    beepForScan(code, "invalid");
  }, []);

  // Downstream verdicts. Consumers (SalesScanContext, WMS intents, POS
  // cart, BarcodeInputField) already publish here — we just stop guessing.
  useEffect(() => {
    if (!request) return;
    return scanFeedbackBus.on((f) => {
      const code = (f.raw || "").trim();
      if (!code) return;
      if (f.kind === "pending") return;
      if (f.kind === "unknown") return settle(code, "unknown", f.detail);
      if (f.kind === "error") return settle(code, "failed", f.detail);
      settle(code, "matched", f.detail);
    });
  }, [request, settle]);

  const onDecode = useCallback(
    (raw: string) => {
      const event = localScanService.emitDecoded(raw);
      const routed = scanRouter.wasConsumed(event);
      const id = `hit-${++seqRef.current}`;
      setHits((prev) =>
        [
          { id, code: event.code, state: routed ? ("pending" as const) : ("dropped" as const), at: event.at },
          ...prev,
        ].slice(0, 6),
      );
      if (!routed) {
        beepForScan(event.code, "invalid");
        return;
      }
      // No verdict within the window → the target was a plain capture
      // field (identity/bin/serial), which is a legitimate success.
      const timer = window.setTimeout(
        () => settle(event.code, "matched", "captured"),
        VERDICT_TIMEOUT_MS,
      );
      timersRef.current.set(event.code, timer);
    },
    [settle],
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
  const reticleTone =
    last?.state === "matched"
      ? "border-emerald-400"
      : last?.state === "pending"
        ? "border-amber-300"
        : last
          ? "border-red-400"
          : "border-white/80";

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
              reticleTone,
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
              last.state === "matched"
                ? "text-emerald-300"
                : last.state === "pending"
                  ? "text-amber-200"
                  : "text-red-300",
            )}
          >
            {last.state === "matched" ? (
              <Check className="h-4 w-4 shrink-0" />
            ) : last.state === "pending" ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            ) : last.state === "unknown" ? (
              <HelpCircle className="h-4 w-4 shrink-0" />
            ) : (
              <TriangleAlert className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{last.code}</span>
            <span className="ml-auto shrink-0 truncate pl-2 font-sans">
              {last.detail ?? STATE_COPY[last.state]}
            </span>
          </div>
        ) : (
          <div className="text-center text-white/70">Point the camera at the barcode.</div>
        )}
        {continuous && (
          <div className="flex items-center justify-between text-xs text-white/70">
            <span>{acceptedRef.current} captured</span>
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
