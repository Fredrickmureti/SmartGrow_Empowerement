// @ts-nocheck — Deno runtime
/**
 * Certificate Engine v3 — payload resolver.
 *
 * Resolves `Value` (literal or binding) against a `CertificatePayload`,
 * applies formatting, and records unresolved paths so the caller can
 * emit `payroll_diagnostics` entries just like the v1/v2 renderers.
 */
import type { Binding, CertificatePayload, Value, ValueFormat } from "./types.ts";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export interface ResolveContext {
  payload: CertificatePayload;
  currency?: string;
  locale?: string;
  /** Populated with dotted paths that resolved to null/undefined. */
  unresolved: Set<string>;
}

export function createContext(
  payload: CertificatePayload,
  opts: { currency?: string; locale?: string } = {},
): ResolveContext {
  return {
    payload,
    currency: opts.currency,
    locale: opts.locale ?? "en-US",
    unresolved: new Set(),
  };
}

/** Dotted-path read with array-index support (`rows.0.employee_amount`). */
export function readPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function resolveValue(v: Value | undefined, ctx: ResolveContext): string {
  if (!v) return "";
  if (v.kind === "literal") return v.value == null ? "" : String(v.value);
  return resolveBinding(v, ctx);
}

export function resolveBinding(b: Binding, ctx: ResolveContext): string {
  const raw = readPath(ctx.payload, b.path);
  if (raw == null || raw === "") {
    ctx.unresolved.add(b.path);
    return b.fallback ?? "";
  }
  return formatValue(raw, b.format ?? "text", ctx);
}

export function readRows(path: string, ctx: ResolveContext): Array<Record<string, unknown>> {
  const raw = readPath(ctx.payload, path);
  if (!Array.isArray(raw)) {
    if (raw != null) ctx.unresolved.add(path);
    return [];
  }
  return raw as Array<Record<string, unknown>>;
}

export function formatValue(raw: unknown, fmt: ValueFormat, ctx: ResolveContext): string {
  switch (fmt) {
    case "number":
      return formatNumber(raw, 2, ctx.locale);
    case "currency": {
      const n = formatNumber(raw, 2, ctx.locale);
      return ctx.currency ? `${ctx.currency} ${n}` : n;
    }
    case "percent": {
      const num = Number(raw);
      if (!Number.isFinite(num)) return "";
      return `${(num * 100).toFixed(2)}%`;
    }
    case "date":
      return formatDate(raw);
    case "month_short": {
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 1 || idx > 12) return String(raw);
      return MONTHS_SHORT[idx - 1];
    }
    case "text":
    default:
      return String(raw);
  }
}

function formatNumber(raw: unknown, digits: number, locale: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDate(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === "string") return raw.slice(0, 10);
  return String(raw ?? "");
}

/** Sum a numeric column from `rows` — used by MatrixFooter. */
export function sumColumn(
  rows: Array<Record<string, unknown>>,
  key: string,
): number {
  let total = 0;
  for (const r of rows) {
    const v = Number(r[key]);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}
