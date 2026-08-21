/**
 * Working context — what the user is *looking at* right now.
 *
 * This is deliberately separate from conversation scope (which tenant /
 * business / branch a thread belongs to). Working context is presentation
 * grounding for the prompt: it never widens or narrows authorization, which is
 * derived server-side from the caller's JWT.
 */

export type ScopeMode = "branch" | "company";

export interface WorkingContext {
  path: string;
  appKey: string;
  moduleKey: string | null;
  recordType?: string;
  recordId?: string;
}

/** Ordered longest-prefix-first so `/hr/payroll` wins over `/hr`. */
const APP_PREFIXES: Array<[string, string]> = [
  ["/hr/payroll", "payroll"],
  ["/hr", "hr"],
  ["/banking", "banking"],
  ["/inventory", "inventory"],
  ["/wms", "wms"],
  ["/pos", "pos"],
  ["/sales", "sales"],
  ["/purchases", "purchases"],
  ["/procurement", "purchases"],
  ["/accounting", "accounting"],
  ["/finance", "accounting"],
  ["/reports", "reports"],
  ["/projects", "projects"],
  ["/crm", "crm"],
  ["/contacts", "contacts"],
  ["/settings", "settings"],
  ["/admin-management", "platform_admin"],
  ["/dashboard", "dashboard"],
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derives the app / module / record the user is on from the route path.
 * Unknown paths fall back to the `global` app so a conversation still has a
 * stable, non-null key.
 */
export function deriveWorkingContext(pathname: string): WorkingContext {
  const path = (pathname || "/").split("?")[0].split("#")[0];
  const match = APP_PREFIXES.find(
    ([prefix]) => path === prefix || path.startsWith(prefix + "/"),
  );
  const appKey = match ? match[1] : "global";
  const prefix = match ? match[0] : "";

  const rest = path.slice(prefix.length).split("/").filter(Boolean);
  const moduleKey = rest.length > 0 && !UUID_RE.test(rest[0]) ? rest[0] : null;

  const recordId = rest.find((segment) => UUID_RE.test(segment));
  const recordType = recordId
    ? rest[Math.max(0, rest.indexOf(recordId) - 1)] || moduleKey || appKey
    : undefined;

  return {
    path,
    appKey,
    moduleKey,
    ...(recordId ? { recordType: recordType ?? undefined, recordId } : {}),
  };
}
