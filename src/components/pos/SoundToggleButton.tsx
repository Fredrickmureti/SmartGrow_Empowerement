import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePOSSound } from "@/hooks/pos/usePOSSound";

/**
 * Header quick-toggle for POS sound effects.
 * Persists per-device via localStorage.
 */
export function SoundToggleButton({
  size = "sm",
  showLabel = false,
}: {
  size?: "sm" | "icon";
  showLabel?: boolean;
}) {
  const { enabled, toggle } = usePOSSound();
  const Icon = enabled ? Volume2 : VolumeX;
  const label = enabled ? "Mute sounds" : "Unmute sounds";

  if (size === "icon") {
    return (
      <Button
        variant={enabled ? "ghost" : "secondary"}
        size="icon"
        className="h-8 w-8"
        onClick={toggle}
        aria-label={label}
        title={label}
      >
        <Icon className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Button
      variant={enabled ? "ghost" : "secondary"}
      size="sm"
      className="px-2 sm:px-3"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      <Icon className="h-4 w-4 sm:mr-2" />
      {showLabel && (
        <span className="hidden md:inline">{enabled ? "Sound" : "Muted"}</span>
      )}
    </Button>
  );
}
