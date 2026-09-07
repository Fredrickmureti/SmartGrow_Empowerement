/**
 * Audit-log presentation helpers — pure functions, no UI.
 *
 * The `audit_logs` table stores raw table names (`payroll_runs`), raw past-
 * tense verbs (`posted`), and full-row JSON snapshots. Everything the user
 * sees on `/settings/audit-logs` flows through here so the page reads as
 * English instead of database identifiers and JSON dumps.
 */
import { format as formatDate, isValid, parseISO } from "date-fns";

// ---------- Entity type ---------------------------------------------------

const ENTITY_TYPE_OVERRIDES: Record<string, string> = {
  bills: "Bill",
  bill_items: "Bill line",
  payments: "Payment",
  payment_allocations: "Payment allocation",
  journal_entries: "Journal entry",
  journal_entry_lines: "Journal entry line",
  employees: "Employee",
  purchase_orders: "Purchase order",
  purchase_order_items: "Purchase order line",
  contacts: "Contact",
  users: "User",
  user_roles: "User role",
  organizations: "Organization",
  businesses: "Business",
  branches: "Branch",
  bank_accounts: "Bank account",
  bank_reconciliation_sessions: "Bank reconciliation",
  bank_transactions: "Bank transaction",
  credit_notes: "Credit note",
  vendor_credit_notes: "Vendor credit note",
  expenses: "Expense",
  expense_categories: "Expense category",
  fixed_assets: "Fixed asset",
  accounts: "GL account",
  approval_requests: "Approval request",
  audit_logs: "Audit entry",
};

export function humanizeEntityType(type: string | null | undefined): string {
  if (!type) return "Record";
  const key = type.trim().toLowerCase();
  if (ENTITY_TYPE_OVERRIDES[key]) return ENTITY_TYPE_OVERRIDES[key];
  const parts = key.split("_").filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  const joined = parts.join(" ");
  // Singularize trailing s (naive)
  return joined.endsWith("ies")
    ? joined.slice(0, -3) + "y"
    : joined.endsWith("s") && !joined.endsWith("ss")
      ? joined.slice(0, -1)
      : joined;
}

// ---------- Action --------------------------------------------------------

export type ActionTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

interface ActionMeta {
  label: string;
  tone: ActionTone;
}

const ACTION_MAP: Record<string, ActionMeta> = {
  created: { label: "Created", tone: "success" },
  create: { label: "Created", tone: "success" },
  updated: { label: "Updated", tone: "info" },
  update: { label: "Updated", tone: "info" },
  deleted: { label: "Deleted", tone: "danger" },
  delete: { label: "Deleted", tone: "danger" },
  posted: { label: "Posted", tone: "success" },
  reversed: { label: "Reversed", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  refunded: { label: "Refunded", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  submitted: { label: "Submitted", tone: "info" },
  voided: { label: "Voided", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "warning" },
  canceled: { label: "Cancelled", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" },
  reopened: { label: "Reopened", tone: "info" },
  sent: { label: "Sent", tone: "info" },
  received: { label: "Received", tone: "info" },
  assigned: { label: "Assigned", tone: "info" },
  unassigned: { label: "Unassigned", tone: "neutral" },
  logged_in: { label: "Signed in", tone: "neutral" },
  logged_out: { label: "Signed out", tone: "neutral" },
  exported: { label: "Exported", tone: "neutral" },
  imported: { label: "Imported", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
  restored: { label: "Restored", tone: "info" },
};

export function humanizeAction(action: string | null | undefined): ActionMeta {
  if (!action) return { label: "Changed", tone: "neutral" };
  const key = action.trim().toLowerCase();
  if (ACTION_MAP[key]) return ACTION_MAP[key];
  const label = key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
  return { label: label || "Changed", tone: "neutral" };
}

// ---------- Sentence ------------------------------------------------------

export function humanizeSentence(input: {
  action: string | null | undefined;
  entityType: string | null | undefined;
  entityName?: string | null;
}): string {
  const entity = humanizeEntityType(input.entityType);
  const verb = humanizeAction(input.action).label.toLowerCase();
  const name = input.entityName?.trim();
  return name ? `${entity} ${name} ${verb}` : `${entity} ${verb}`;
}

// ---------- Field name / value formatting --------------------------------

export function formatFieldName(key: string): string {
  return key
    .replace(/_id$/i, " ID")
    .split("_")
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

const MONEY_SUFFIXES = /(_amount|_total|_subtotal|_balance|_price|_cost|_paid|_due|_tax)$/i;
const DATE_KEY = /(_at|_on|_date|date_)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/;

export function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (MONEY_SUFFIXES.test(key)) {
      return value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    return value.toLocaleString();
  }
  if (typeof value === "string") {
    if (UUID_RE.test(value)) return value.slice(0, 8) + "…";
    if (ISO_RE.test(value)) {
      const d = parseISO(value);
      if (isValid(d)) return formatDate(d, "MMM d, yyyy HH:mm");
    }
    if (DATE_KEY.test(key) && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = parseISO(value);
      if (isValid(d)) return formatDate(d, "MMM d, yyyy");
    }
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------- Diff ----------------------------------------------------------

export const NOISE_KEYS = new Set<string>([
  "id",
  "created_at",
  "updated_at",
  "organization_id",
  "business_id",
  "search_vector",
  "tsv",
  "metadata",
  "_row_version",
  "version",
]);

export interface DiffEntry {
  key: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed";
}

function isSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function diffValues(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  { includeNoise = false }: { includeNoise?: boolean } = {},
): DiffEntry[] {
  const keys = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  const out: DiffEntry[] = [];
  for (const key of keys) {
    if (!includeNoise && NOISE_KEYS.has(key)) continue;
    const b = before?.[key];
    const a = after?.[key];
    if (isSame(b, a)) continue;
    let kind: DiffEntry["kind"] = "changed";
    if (b === undefined || b === null) kind = "added";
    else if (a === undefined || a === null) kind = "removed";
    out.push({ key, before: b, after: a, kind });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}
