/**
 * Mobile warehouse layout — top bar, scrollable body, no sidebar.
 * Locked to portrait CSS width; used by every /wm/* route.
 */
import { ReactNode, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Home, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueueIndicator } from "./QueueIndicator";
import { startDrainLoop } from "./offlineQueue";
import { useScanFeedbackBridge } from "@/features/warehouse/scanning/useScanFeedback";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";

interface Props {
  title: string;
  back?: string;
  children: ReactNode;
  bottomBar?: ReactNode;
  /**
   * Handheld mode: label for the floating camera-scan button. Omit to hide
   * it (screens with nothing to scan). The decode is delivered to whichever
   * WMS scan intent this screen has registered — no field focus required.
   */
  scanLabel?: string;
  /** Keep the viewfinder open between decodes (counting, receiving). */
  scanContinuous?: boolean;
}

export function MobileWarehouseLayout({ title, back, children, bottomBar, scanLabel, scanContinuous }: Props) {
  const nav = useNavigate();
  // Subscribes once for the whole /wm/* surface: the offline queue emits a
  // scan outcome, this renders the tone + haptic + colour flash.
  const { Flash, muted, setMuted } = useScanFeedbackBridge();
  useEffect(() => {
    startDrainLoop();
  }, []);
  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <Flash />
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {back ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => nav(back)}
              className="h-9 w-9 p-0"
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          ) : (
            <Button size="sm" variant="ghost" asChild className="h-9 w-9 p-0" aria-label="Home">
              <Link to="/wm"><Home className="h-5 w-5" /></Link>
            </Button>
          )}
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">warehouse</div>
            <div className="font-semibold truncate">{title}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-9 w-9 p-0"
            aria-label={muted ? "Unmute scan sounds" : "Mute scan sounds"}
            aria-pressed={muted}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </Button>
          <QueueIndicator />
        </div>
      </header>
      <main className="relative flex-1 overflow-y-auto p-3">
        {children}
        {scanLabel && (
          <ScanCameraButton
            label={scanLabel}
            continuous={scanContinuous}
            withText
            className="fixed bottom-24 right-4 z-40 h-12 rounded-full shadow-lg"
          />
        )}
      </main>
      {bottomBar && (
        <div className="border-t bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {bottomBar}
        </div>
      )}
    </div>
  );
}
