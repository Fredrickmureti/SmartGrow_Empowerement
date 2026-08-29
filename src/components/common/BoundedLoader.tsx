/**
 * BoundedLoader
 *
 * A loader that REFUSES to spin forever. After `timeoutMs` it renders the
 * `recovery` slot (typically a recovery card with "Refresh / Sign out /
 * Contact support" actions) instead of leaving the user staring at an
 * indefinite spinner.
 *
 * Used by InstitutionRoute, /select-organization, and the
 * onboarding handoff to /home — the three places where a stuck loader
 * historically translated into "the app is broken" support tickets.
 */
import { ReactNode, useEffect, useState } from "react";
import { BrandedLoader } from "@/components/common/BrandedLoader";

interface BoundedLoaderProps {
  message?: string;
  /** ms before escalating to the recovery slot. Default 12s. */
  timeoutMs?: number;
  /** What to show when the timeout fires. */
  recovery: ReactNode;
}

export function BoundedLoader({
  message = "Loading...",
  timeoutMs = 12_000,
  recovery,
}: BoundedLoaderProps) {
  const [escalated, setEscalated] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setEscalated(true), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  if (escalated) return <>{recovery}</>;
  return <BrandedLoader message={message} />;
}
