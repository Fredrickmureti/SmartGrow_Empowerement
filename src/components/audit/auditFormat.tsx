/**
 * Shared formatting helpers for audit-log surfaces.
 *
 * Converts machine identifiers and raw JSON payloads into human-readable
 * labels, value pills and diff rows so audit views never look like a
 * stringified blob.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ACRONYMS = new Set(["id", "url", "ip", "api", "sso", "kyc", "vat", "tax", "pos", "hr", "ai", "sms", "otp", "rls"]);

/** "admin_user_id" → "Admin user", "targetEntityType" → "Target entity type" */
export function humanizeKey(key: string): string {
  if (!key) return "";
  const cleaned = key
    .replace(/_id$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) return key;
  return cleaned
    .split(" ")
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (ACRONYMS.has(lw)) return lw.toUpperCase();
      return i === 0 ? lw.charAt(0).toUpperCase() + lw.slice(1) : lw;
    })
    .join(" ");
}

/** "user.created" / "USER_CREATED" → "User created" */
export function humanizeAction(action: string): string {
  if (!action) return "";
  return action
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") {
    if (UUID_RE.test(v)) return `#${v.slice(0, 8)}`;
    if (ISO_RE.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toLocaleString();
    }
    return v.length > 80 ? v.slice(0, 80) + "…" : v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    if (v.length <= 3) return v.map(formatValue).join(", ");
    return `${v.length} items`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return "—";
    return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }
  return String(v);
}

function flatten(obj: unknown, prefix = ""): Array<[string, unknown]> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [[prefix || "value", obj]];
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 4) {
      out.push(...flatten(v, path));
    } else {
      out.push([path, v]);
    }
  }
  return out;
}

interface AuditDetailsProps {
  details: unknown;
  className?: string;
  /** Cap shown rows; remaining count rendered as "+N more". */
  max?: number;
}

/** Tidy key/value rendering of an arbitrary JSON details payload. */
export function AuditDetails({ details, className, max = 6 }: AuditDetailsProps) {
  if (!details || (typeof details === "object" && Object.keys(details as object).length === 0)) {
    return <span className="text-xs text-muted-foreground">No additional details</span>;
  }
  const rows = flatten(details);
  const shown = rows.slice(0, max);
  const remaining = rows.length - shown.length;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {shown.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
        >
          <span className="text-muted-foreground">{humanizeKey(k)}</span>
          <span className="font-medium text-foreground">{formatValue(v)}</span>
        </span>
      ))}
      {remaining > 0 && (
        <Badge variant="outline" className="text-[10px]">+{remaining} more</Badge>
      )}
    </div>
  );
}

interface AuditDiffProps {
  oldValue: unknown;
  newValue: unknown;
  className?: string;
}

/** Renders a per-field "old → new" diff. */
export function AuditDiff({ oldValue, newValue, className }: AuditDiffProps) {
  const o = oldValue && typeof oldValue === "object" && !Array.isArray(oldValue)
    ? (oldValue as Record<string, unknown>)
    : { value: oldValue };
  const n = newValue && typeof newValue === "object" && !Array.isArray(newValue)
    ? (newValue as Record<string, unknown>)
    : { value: newValue };
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)]));
  const changed = keys
    .map((k) => ({ k, ov: o[k], nv: n[k] }))
    .filter(({ ov, nv }) => JSON.stringify(ov) !== JSON.stringify(nv));

  if (changed.length === 0) {
    return <span className="text-xs text-muted-foreground">No field-level changes recorded</span>;
  }

  return (
    <div className={cn("space-y-1", className)}>
      {changed.map(({ k, ov, nv }) => (
        <div key={k} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground min-w-[7rem]">{humanizeKey(k)}</span>
          <span className="rounded bg-destructive/10 text-destructive px-1.5 py-0.5 line-through decoration-destructive/40">
            {formatValue(ov)}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 font-medium">
            {formatValue(nv)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Pick a Badge variant from an action string (e.g., delete → destructive). */
export function actionVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  const a = action.toLowerCase();
  if (/(delete|remove|revoke|disable|ban|suspend)/.test(a)) return "destructive";
  if (/(create|insert|add|grant|enable|publish|approve)/.test(a)) return "default";
  if (/(update|edit|change|modify|patch|rotate)/.test(a)) return "secondary";
  return "outline";
}
