/**
 * Mobile warehouse layout — top bar, scrollable body, no sidebar.
 * Locked to portrait CSS width; used by every /wm/* route.
 *
 * Owns the whole RF surface's scan affordances (Phase 4.2 / 4.5):
 *  - the operator guidance bar (what to scan now, what just happened),
 *  - the camera button, which is the handheld-mode entry to the one
 *    viewfinder,
 *  - the visible single / continuous mode switch. Screens declare their
 *    sensible default via `scanContinuous`; the operator can override it
 *    without leaving the task.
 */
import { ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Home, Volume2, VolumeX, Repeat, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueueIndicator } from "./QueueIndicator";
import { startDrainLoop } from "./offlineQueue";
import { useScanFeedbackBridge } from "@/features/warehouse/scanning/useScanFeedback";
import { ScanGuidance } from "@/features/warehouse/scanning/ScanGuidance";
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
  /** Default for the mode switch: keep the viewfinder open between decodes. */
  scanContinuous?: boolean;
}

export function MobileWarehouseLayout({ title, back, children, bottomBar, scanLabel, scanContinuous }: Props) {
  const nav = useNavigate();
  // Subscribes once for the whole /wm/* surface: the offline queue emits a
  // scan outcome, this renders the tone + haptic + colour flash.
  const { Flash, muted, setMuted } = useScanFeedbackBridge();
  const [continuous, setContinuous] = useState(!!scanContinuous);
  useEffect(() => setContinuous(!!scanContinuous), [scanContinuous]);
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
          {scanLabel && (
            <Button
              size="sm"
              variant="ghost"
              className="h-9 w-9 p-0"
              aria-label={continuous ? "Switch to single scan" : "Switch to continuous scan"}
              aria-pressed={continuous}
              title={continuous ? "Continuous scanning" : "Single scan"}
              onClick={() => setContinuous((c) => !c)}
            >
              {continuous ? <Repeat className="h-5 w-5" /> : <Target className="h-5 w-5" />}
            </Button>
          )}
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
      {/* One guidance bar for the whole RF app: it reads the mounted scan
          intent from the router, so screens never restate their prompt. */}
      <ScanGuidance variant="bar" className="mx-3 mt-2" />
      <main className="relative flex-1 overflow-y-auto p-3">
        {children}
        {scanLabel && (
          <ScanCameraButton
            label={`${scanLabel}${continuous ? " · continuous" : ""}`}
            continuous={continuous}
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
