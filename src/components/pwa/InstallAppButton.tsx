/**
 * InstallAppButton
 *
 * Persistent, always-available entry point for installing the PWA.
 *
 * Behavior:
 * - Hidden if the app is already installed (no point showing it).
 * - If a native `beforeinstallprompt` event is currently deferred, clicking
 *   triggers the native browser install flow.
 * - Otherwise (event never fired, already consumed, throttled by Chrome,
 *   or iOS Safari which doesn't support the API), clicking navigates to
 *   `/install` — a dedicated page with platform-specific manual
 *   instructions and a QR code for cross-device installs.
 *
 * This is the safety net that guarantees users ALWAYS have a way to
 * install the app, even after dismissing the browser's native prompt.
 */

import { useNavigate } from "react-router-dom";
import { Download } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { usePWAInstall } from "@/hooks/usePWAInstall";
import { cn } from "@/lib/utils";

interface InstallAppButtonProps extends Omit<ButtonProps, "onClick"> {
  /** Optional custom label. Defaults to "Install App". */
  label?: string;
  /** If true, render only the icon (compact mobile/header use). */
  iconOnly?: boolean;
}

export function InstallAppButton({
  label = "Install App",
  iconOnly = false,
  className,
  variant = "outline",
  size,
  ...rest
}: InstallAppButtonProps) {
  const navigate = useNavigate();
  const {
    isInstalled,
    hasNativePrompt,
    promptInstall,
    isPrompting,
    canShowInstallUI,
  } = usePWAInstall();

  // Already installed — nothing to do.
  if (isInstalled || !canShowInstallUI) return null;

  const handleClick = async () => {
    if (hasNativePrompt) {
      const accepted = await promptInstall();
      // If the user declined the native prompt, fall through to the
      // dedicated install page so they can try again later or see
      // platform-specific instructions. Without this fallback, the
      // BeforeInstallPromptEvent is consumed and the next click would
      // no-op until the browser decides to re-fire it (often weeks).
      if (!accepted) {
        navigate("/install");
      }
    } else {
      navigate("/install");
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={iconOnly ? "icon" : size}
      onClick={handleClick}
      disabled={isPrompting}
      aria-label={label}
      title={label}
      className={cn("gap-2", className)}
      {...rest}
    >
      <Download className="h-4 w-4" />
      {!iconOnly && <span>{label}</span>}
    </Button>
  );
}

export default InstallAppButton;
