/**
 * useCameraDecoder — THE camera decode engine for the whole app.
 *
 * Every camera-based barcode/QR decode in this repo goes through this hook:
 * the phone cockpit's pairing repair overlay, the handheld local-scan
 * overlay, and anything added later. It owns the engine ladder
 * (native `BarcodeDetector` → `@zxing/browser` fallback), the MediaStream
 * lifecycle, the visibility pause, the torch, and the per-device repeat
 * dedupe.
 *
 * Guarded by `src/test/architecture/scanner-single-camera-engine.test.ts`:
 * no other module may call `getUserMedia`, touch `BarcodeDetector`, or
 * import `@zxing/*`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseCameraDecoderOptions {
  /** Start/stop the camera. */
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  /**
   * Symbologies to look for. Defaults to the retail/logistics pack.
   * Pass `["qr_code"]` for pairing QRs.
   */
  formats?: string[];
  /** Called for every accepted decode (after the dedupe window). */
  onDecode: (raw: string) => void;
  /** Stop the camera after the first accepted decode. Default false. */
  stopOnFirst?: boolean;
  /** Same-code suppression window in ms. Default 900. */
  dedupeMs?: number;
}

export const DEFAULT_SCAN_FORMATS = [
  "qr_code",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "code_93",
  "itf",
  "codabar",
  "data_matrix",
  "pdf417",
  "aztec",
];

export interface UseCameraDecoderResult {
  /** True once frames are flowing. */
  scanning: boolean;
  error: string | null;
  /** True when the active track exposes a torch capability. */
  torchAvailable: boolean;
  torchOn: boolean;
  toggleTorch: () => void;
  /** Manual teardown (the hook also tears down on disable/unmount). */
  stop: () => void;
}

export function useCameraDecoder({
  enabled,
  videoRef,
  formats = DEFAULT_SCAN_FORMATS,
  onDecode,
  stopOnFirst = false,
  dedupeMs = 900,
}: UseCameraDecoderOptions): UseCameraDecoderResult {
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const zxingRef = useRef<{ stop: () => void } | null>(null);
  const doneRef = useRef(false);
  const lastHitRef = useRef<{ code: string; at: number } | null>(null);

  const onDecodeRef = useRef(onDecode);
  useEffect(() => { onDecodeRef.current = onDecode; }, [onDecode]);
  // Format list identity must not restart the camera on every render.
  const formatsKey = formats.join(",");

  const stop = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (zxingRef.current) { try { zxingRef.current.stop(); } catch { /* ignore */ } zxingRef.current = null; }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    setScanning(false);
    setTorchAvailable(false);
    setTorchOn(false);
  }, []);

  const toggleTorch = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      void (track as MediaStreamTrack & {
        applyConstraints: (c: unknown) => Promise<void>;
      }).applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch {
      /* torch unsupported on this track */
    }
  }, [torchOn]);

  useEffect(() => {
    if (!enabled) { stop(); return; }
    let disposed = false;
    doneRef.current = false;
    lastHitRef.current = null;

    const handleHit = (raw: string) => {
      const code = (raw ?? "").trim();
      if (!code || doneRef.current) return;
      const now = Date.now();
      const last = lastHitRef.current;
      if (last && last.code === code && now - last.at < dedupeMs) return;
      lastHitRef.current = { code, at: now };
      if (stopOnFirst) {
        doneRef.current = true;
        stop();
      }
      onDecodeRef.current(code);
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (disposed) { for (const t of stream.getTracks()) t.stop(); return; }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        try {
          const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
          setTorchAvailable(Boolean(caps.torch));
        } catch { /* capabilities unsupported */ }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        const markReady = () => { if (!disposed) setScanning(true); };
        if (video.readyState >= 2) markReady();
        else video.addEventListener("loadedmetadata", markReady, { once: true });
        video.play().catch(() => undefined);
        setError(null);

        const BD = (window as unknown as { BarcodeDetector?: new (o?: unknown) => {
          detect: (src: unknown) => Promise<Array<{ rawValue?: string }>>;
        } }).BarcodeDetector;
        if (BD) {
          let detector: { detect: (src: unknown) => Promise<Array<{ rawValue?: string }>> };
          try { detector = new BD({ formats: formatsKey.split(",") }); }
          catch { detector = new BD(); }
          const tick = async () => {
            if (disposed || doneRef.current || !videoRef.current) return;
            try {
              const results = await detector.detect(videoRef.current);
              for (const r of results || []) {
                if (r.rawValue) handleHit(r.rawValue);
              }
            } catch { /* frame not ready */ }
            if (!doneRef.current && !disposed) rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, video, (result) => {
          if (result) handleHit(result.getText());
        });
        zxingRef.current = controls as unknown as { stop: () => void };
      } catch (err: unknown) {
        if (disposed) return;
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Unable to access the camera. Grant camera permission.",
        );
        setScanning(false);
      }
    })();

    return () => { disposed = true; stop(); };
  }, [enabled, videoRef, stop, formatsKey, stopOnFirst, dedupeMs]);

  return { scanning, error, torchAvailable, torchOn, toggleTorch, stop };
}
