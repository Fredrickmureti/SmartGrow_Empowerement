/**
 * useBusinessModules — which HR-family modules are installed for the
 * current business. Drives module-aware UI gating so an
 * Attendance-only customer never sees payroll-specific tabs, fields,
 * or readiness panels.
 *
 * Thin wrapper over `useInstalledApps` (org-level today; will become
 * business-level when app installs are scoped to business).
 */
import { useInstalledApps } from "@/hooks/useInstalledApps";

export interface BusinessModules {
  isReady: boolean;
  hr: boolean;
  payroll: boolean;
  attendance: boolean;
  timesheets: boolean;
  benefits: boolean;
  // Convenience: true if any payroll-adjacent module is installed.
  anyHR: boolean;
}

export function useBusinessModules(): BusinessModules {
  const { isInstalled, isReady } = useInstalledApps();
  const hr = isInstalled("hr");
  const payroll = isInstalled("payroll");
  const attendance = isInstalled("attendance");
  const timesheets = isInstalled("timesheets");
  const benefits = isInstalled("benefits");
  return {
    isReady,
    hr,
    payroll,
    attendance,
    timesheets,
    benefits,
    anyHR: hr || payroll || attendance || timesheets || benefits,
  };
}
