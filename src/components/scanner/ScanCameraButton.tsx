/**
 * ScanCameraButton — the "use this device's camera" affordance.
 *
 * Rendered only in handheld mode (see `deviceMode`). On a workstation the
 * scanner is a gun or a paired phone and this button would be noise.
 *
 * It never decodes anything itself: it focuses/arms the caller's target
 * (so `scanRouter` has somewhere to deliver) and opens the one global
 * viewfinder.
 */
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";
import { feedbackTones } from "@/services/scanner/feedbackTones";

interface Props {
  /** Header text in the viewfinder — e.g. "Scan destination bin". */
  label?: string;
  /** Keep scanning after each hit (receiving, counting). */
  continuous?: boolean;
  /** Runs before the camera opens — focus the field so it wins the router. */
  onBeforeOpen?: () => void;
  /** Fired when the viewfinder closes, with the number of accepted scans. */
  onClose?: (count: number) => void;
  disabled?: boolean;
  className?: string;
  /** Render as a full-width button with a text label. */
  withText?: boolean;
}

export function ScanCameraButton({
  label,
  continuous,
  onBeforeOpen,
  onClose,
  disabled,
  className,
  withText,
}: Props) {
  const { handheld, scan } = useLocalScan();
  if (!handheld) return null;

  const open = () => {
    // iOS: unlock WebAudio inside this gesture so the decode can beep.
    feedbackTones.unlock();
    onBeforeOpen?.();
    scan({ label, continuous, onClose });
  };

  if (withText) {
    return (
      <Button type="button" variant="secondary" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={open} className={cn("gap-2", className)}>
        <Camera className="h-4 w-4" /> Scan with camera
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Scan with this device's camera"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={open}
      className={cn("h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground", className)}
    >
      <Camera className="h-4 w-4" />
    </Button>
  );
}
