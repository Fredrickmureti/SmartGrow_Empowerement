/**
 * AuthenticatedShell
 * Wraps all authenticated content with inactivity monitoring and the
 * BodyPointerEventsGuard recovery net (clears stuck `pointer-events: none`
 * left behind by Radix overlays unmounted while open).
 * On timeout: performs full sign-out (no client-side lock screen).
 */

import { ReactNode } from 'react';
import { useInactivityMonitor } from '@/hooks/security/useInactivityMonitor';
import { BodyPointerEventsGuard } from '@/components/common/BodyPointerEventsGuard';
import { useScanCapture } from '@/hooks/pos/useScanCapture';
import { ScannerWorkspaceProvider } from '@/contexts/ScannerWorkspaceContext';
import { LocalScanOverlay } from '@/components/scanner/LocalScanOverlay';
import { ScanFeedbackTonePlayer } from '@/components/scanner/ScanFeedbackTonePlayer';


interface AuthenticatedShellProps {
  children: ReactNode;
}

export function AuthenticatedShell({ children }: AuthenticatedShellProps) {
  // Monitor inactivity — on timeout, calls signOut() and redirects to /login
  useInactivityMonitor();
  // Global keyboard-wedge barcode kernel. Mounted once for the whole
  // authenticated app so any BarcodeInputField (Products, Inventory, etc.)
  // can receive scans regardless of which page is open.
  useScanCapture({ enabled: true });

  return (
    <>
      <BodyPointerEventsGuard />
      {/* Workspace-scoped phone-scanner session. Owns ONE scanner_session
          for the active business+branch so onboarding/inventory/POS forms
          all share one paired phone. Pairing dialog is rendered inside. */}
      <ScannerWorkspaceProvider>
        {children}
        {/* Handheld mode: this device's own camera feeds the focused scan
            target in this same tab — no pairing, no second device. */}
        <LocalScanOverlay />
        {/* Audible scan feedback for every module that emits a verdict. */}
        <ScanFeedbackTonePlayer />
      </ScannerWorkspaceProvider>
    </>
  );
}

