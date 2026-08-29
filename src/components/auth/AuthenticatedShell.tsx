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


interface AuthenticatedShellProps {
  children: ReactNode;
}

export function AuthenticatedShell({ children }: AuthenticatedShellProps) {
  // Monitor inactivity — on timeout, calls signOut() and redirects to /login
  useInactivityMonitor();

  return (
    <>
      <BodyPointerEventsGuard />
      {children}

    </>
  );
}

