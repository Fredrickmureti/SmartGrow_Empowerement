/**
 * DeviceModeChoice — the fork every scan surface used to be missing.
 *
 * Before this, "use phone as scanner" only ever meant *pair a second
 * device*: the operator holding a phone had to find a PC, pair to it, and
 * then the phone became a dumb gun. On a handheld the ERP and the camera
 * live in the same tab, so the honest first question is:
 *
 *   - "Scan with THIS device" → handheld mode, no pairing, no network hop.
 *   - "Pair another phone"    → companion mode (the QR flow below).
 *
 * The choice is persisted through `scannerDeviceMode` so the operator is
 * asked once per device, not once per screen.
 */
import { Camera, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";

interface Props {
  label: string;
  /** Called after the local viewfinder is opened so the dialog can close. */
  onUseThisDevice: () => void;
}

function hasCamera(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

export function DeviceModeChoice({ label, onUseThisDevice }: Props) {
  const { handheld, setPreference, scan } = useLocalScan();
  if (!hasCamera()) return null;

  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <Camera className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Scan with this device</p>
          <p className="text-xs text-muted-foreground">
            {handheld
              ? "You are already in handheld mode — the camera feeds this screen directly."
              : "Skip pairing: use this device's camera and keep working in the same window."}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            // Explicit operator intent beats the UA heuristic.
            setPreference("handheld");
            scan({ label });
            onUseThisDevice();
          }}
        >
          Use camera
        </Button>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Smartphone className="h-3.5 w-3.5" /> Or pair a separate phone below — it becomes a
        dedicated gun for this workspace.
      </p>
    </div>
  );
}
