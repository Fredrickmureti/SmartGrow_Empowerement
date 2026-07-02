/**
 * Legacy `?section=` deep-link redirect map.
 *
 * Wave G consolidated the Employee profile sidebar from 17 to 12 items by
 * folding Loans / Benefits / Assets into a single "Benefits & assets"
 * section with sub-tabs, and moving Compensation history under Contracts.
 * HR Settings moved off the sidebar entirely (into the header overflow
 * menu).
 *
 * External links (emails, automations, dashboards) used the previous
 * section keys. This map normalizes them so no link rots. It is consumed
 * by `EmployeeProfile.tsx` *and* asserted by an architecture test, so any
 * future rename of these keys must update the map.
 */
export const LEGACY_SECTION_REDIRECTS: Record<
  string,
  { section: string; tab?: string }
> = {
  loans: { section: "benefits", tab: "loans" },
  assets: { section: "benefits", tab: "assets" },
  compensation: { section: "contracts", tab: "history" },
  // HR Settings is now reachable from the header overflow menu, but the
  // legacy deep link still lands on a sensible pane (admin Activity log)
  // for users with the permission. Tests assert this key is mapped.
  hr_settings: { section: "history" },
};

export type CanonicalSection =
  | "overview"
  | "work"
  | "private"
  | "contracts"
  | "leave"
  | "attendance"
  | "timesheets"
  | "payroll"
  | "benefits"
  | "documents"
  | "onboarding"
  | "exit"
  | "history";

/** The 12 canonical sections shown in the sidebar. */
export const CANONICAL_SECTIONS: readonly CanonicalSection[] = [
  "overview",
  "work",
  "private",
  "contracts",
  "leave",
  "attendance",
  "timesheets",
  "payroll",
  "benefits",
  "documents",
  "onboarding",
  "exit",
  "history",
] as const;
