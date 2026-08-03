/**
 * useQrRepairScan — camera QR scan used by the phone's "Pair again"
 * overlay and by `InAppQrScanner` to re-claim a pairing token IN-PAGE.
 *
 * Thin wrapper over the single camera engine (`useCameraDecoder`) with
 * `formats: ["qr_code"]` plus pairing-URL parsing. No camera code of its
 * own — see `src/services/scanner/camera/useCameraDecoder.ts`.
 */

import { useCallback, useEffect, useRef } from "react";
import { parsePairingUrl } from "@/services/scanner/parsePairingUrl";
import { useCameraDecoder } from "@/services/scanner/camera/useCameraDecoder";

interface Options {
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  onToken: (token: string) => void;
}

export function useQrRepairScan({ enabled, videoRef, onToken }: Options) {
  const onTokenRef = useRef(onToken);
  useEffect(() => { onTokenRef.current = onToken; }, [onToken]);
  const foundRef = useRef(false);

  useEffect(() => {
    if (!enabled) foundRef.current = false;
  }, [enabled]);

  const onDecode = useCallback((raw: string) => {
    if (foundRef.current) return;
    const token = parsePairingUrl(raw);
    if (!token) return;
    foundRef.current = true;
    onTokenRef.current(token);
  }, []);

  const { scanning, error, stop } = useCameraDecoder({
    enabled,
    videoRef,
    formats: ["qr_code"],
    onDecode,
  });

  return { scanning, error, stop };
}
