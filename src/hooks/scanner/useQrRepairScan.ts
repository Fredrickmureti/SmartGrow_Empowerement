/**
 * useQrRepairScan — minimal camera-based QR scanner used by the phone's
 * "Pair again" overlay to re-claim a fresh pairing token IN-PAGE,
 * without forcing the operator to close the tab and re-scan from the OS
 * camera.
 *
 * Uses the same engine ladder as the main cockpit: native
 * `BarcodeDetector` (Chrome/Edge/iOS 17+) with ZXing fallback. Only
 * looks for `qr_code` symbology. On first valid pairing-URL hit it
 * calls `onToken(token)` and stops.
 *
 * This hook does NOT touch the live scanner channel/socket — it expects
 * the caller to have already torn the camera down (e.g. via the
 * existing `stopCameraInternal()` on `revoked`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { parsePairingUrl } from "@/services/scanner/parsePairingUrl";

interface Options {
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  onToken: (token: string) => void;
}

export function useQrRepairScan({ enabled, videoRef, onToken }: Options) {
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const zxingRef = useRef<{ stop: () => void } | null>(null);
  const foundRef = useRef(false);
  const onTokenRef = useRef(onToken);
  useEffect(() => { onTokenRef.current = onToken; }, [onToken]);

  const stop = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (zxingRef.current) { try { zxingRef.current.stop(); } catch { /* ignore */ } zxingRef.current = null; }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    setScanning(false);
  }, []);

  useEffect(() => {
    if (!enabled) { stop(); return; }
    let disposed = false;
    foundRef.current = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (disposed) { for (const t of stream.getTracks()) t.stop(); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        const markReady = () => { if (!disposed) setScanning(true); };
        if (video.readyState >= 2) markReady();
        else video.addEventListener("loadedmetadata", markReady, { once: true });
        video.play().catch(() => undefined);
        setError(null);

        const handleHit = (raw: string) => {
          if (foundRef.current) return;
          const token = parsePairingUrl(raw);
          if (!token) return;
          foundRef.current = true;
          stop();
          onTokenRef.current(token);
        };

        const BD = (window as any).BarcodeDetector;
        if (BD) {
          let detector: any;
          try { detector = new BD({ formats: ["qr_code"] }); }
          catch { detector = new BD(); }
          const tick = async () => {
            if (disposed || foundRef.current || !videoRef.current) return;
            try {
              const results = await detector.detect(videoRef.current);
              for (const r of results || []) {
                if (r.rawValue) handleHit(r.rawValue);
              }
            } catch { /* frame not ready */ }
            if (!foundRef.current) rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        // Fallback: ZXing (already used by the main scanner)
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, video, (result) => {
          if (result) handleHit(result.getText());
        });
        zxingRef.current = controls as unknown as { stop: () => void };
      } catch (err: any) {
        if (disposed) return;
        setError(err?.message || "Unable to access the camera. Grant camera permission.");
        setScanning(false);
      }
    })();

    return () => { disposed = true; stop(); };
  }, [enabled, videoRef, stop]);

  return { scanning, error, stop };
}
