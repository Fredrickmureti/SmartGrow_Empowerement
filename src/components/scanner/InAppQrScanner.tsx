/**
 * InAppQrScanner — full-bleed camera viewfinder for scanning a desk-side
 * scanner-pairing QR from within the ERP, without leaving the app for the
 * OS camera. Pure UI shell on top of `useQrRepairScan`, which already owns
 * the BarcodeDetector / ZXing engine ladder and parses every pairing-URL
 * variant via `parsePairingUrl`.
 *
 * On a successful decode it navigates to `/scan/<token>` so the regular
 * `MobileScannerPage` claim flow takes over — single code path, no
 * duplicate pairing logic.
 */

import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { X, Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useQrRepairScan } from "@/hooks/scanner/useQrRepairScan";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function InAppQrScanner({ open, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const navigate = useNavigate();

  const onToken = useCallback((token: string) => {
    onClose();
    navigate(`/scan/${token}`);
  }, [onClose, navigate]);

  const { scanning, error } = useQrRepairScan({
    enabled: open,
    videoRef,
    onToken,
  });

  // Release the camera if the tab is backgrounded mid-scan (mirrors
  // MobileScannerPage). useQrRepairScan handles full teardown on unmount,
  // but a paused stream while hidden is a quick win for battery.
  useEffect(() => {
    if (!open) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") onClose();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Camera className="h-5 w-5" />
          <span className="font-medium">Scan pairing QR</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="text-white hover:bg-white/10">
          <X className="h-5 w-5" />
        </Button>
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
          <div className="h-64 w-64 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
        </div>
        {!scanning && !error && (
          <div className="absolute inset-x-0 bottom-12 flex items-center justify-center gap-2 text-white/90 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Starting camera…
          </div>
        )}
      </div>
      <div className="px-4 pb-6 pt-3 text-center text-sm text-white/80">
        {error ? (
          <Alert variant="destructive" className="text-left">
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        ) : (
          "Point the camera at the QR shown on the other device."
        )}
      </div>
    </div>
  );
}