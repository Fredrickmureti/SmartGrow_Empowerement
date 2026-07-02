/**
 * SelfServiceContext
 *
 * A lightweight switch that tells shared HR pages (LeaveDashboard,
 * Timesheets, Attendance) they are being rendered inside the employee
 * self-service shell (`/me/*`) instead of the admin shell (`/hr/*`).
 *
 * Pages should:
 *   - hide admin-only filters (employee picker, branch picker)
 *   - hide admin actions (approve/reject queues, run depreciation, etc.)
 *   - force the data scope to the current user's own employee record
 *
 * This avoids prop-drilling a `mode` flag through every shared component
 * and prevents admin widgets from leaking into self-service surfaces.
 */
import { createContext, useContext, ReactNode } from "react";

interface SelfServiceContextValue {
  /** True when rendered inside `/me/*`. */
  isSelfService: boolean;
}

const SelfServiceContext = createContext<SelfServiceContextValue>({
  isSelfService: false,
});

export function SelfServiceProvider({ children }: { children: ReactNode }) {
  return (
    <SelfServiceContext.Provider value={{ isSelfService: true }}>
      {children}
    </SelfServiceContext.Provider>
  );
}

/**
 * Hook for shared HR pages to detect self-service mode and adapt UI.
 * Returns `{ isSelfService: false }` outside the provider, so existing
 * admin usages are unaffected.
 */
export function useSelfService(): SelfServiceContextValue {
  return useContext(SelfServiceContext);
}
