/**
 * PreviewPanel — WYSIWYG document/table preview for localization-pack
 * templates. Renders a paper-styled approximation of the final PDF for
 * block-based certificate/payslip templates, and a tabular sample for
 * columnar statutory-return templates. No JSON, and no raw dotted
 * token paths, are ever shown to the authoring user.
 *
 * Token resolution layers (country-agnostic by design):
 *   1. SYNTHETIC_CTX — neutral placeholder values for the country-
 *      agnostic core token registry only (names, generic run/contract
 *      totals, organization profile). Contains NO country-specific
 *      identifier keys or rule codes.
 *   2. pack_token_registry.sample_value — every pack-defined token
 *      (KE NSSF number, UK NI number, ZA UIF number, etc.) carries
 *      its own sample value, which this panel reads via the registry
 *      fallback. Authors see country-specific tokens populated only
 *      when a pack is installed and selected.
 *   3. Genuine miss → flagged red only when the token isn't in the
 *      registry at all (i.e. a typo or deleted token).
 */
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eye } from "lucide-react";
import { useTokenRegistry } from "../hooks";
import { humanizeToken } from "../lib/humanizeToken";
import type { PackToken } from "../types";

const SYNTHETIC_CTX: Record<string, any> = {
  employee: {
    first_name: "Jane",
    last_name: "Doe",
    full_name: "Jane Doe",
    employee_number: "EMP-001",
    email: "jane.doe@example.com",
    hire_date: "2022-01-15",
    age: 32,
    dependants: 2,
    marital_status: "single",
  },
  contract: {
    basic_salary: 80000,
    wage: 80000,
    hours_per_week: 40,
    structure_code: "STD",
    payment_frequency: "monthly",
    currency: "—",
    allowances: { housing: 15000, transport: 5000 },
  },
  run: {
    gross_pay: 100000,
    taxable_pay: 95000,
    net_pay: 70250,
    basic_pay: 80000,
    allowances_total: 20000,
    benefits_total: 0,
    relief_total: 2400,
    employer_contributions_total: 4320,
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    period_label: "May 2026",
    payroll_run_id: "preview-run-id",
  },
  organization: {
    name: "Acme Holdings Ltd",
    address: "123 Example Street",
    phone: "+00 000 000 000",
  },
  system: {
    now: new Date().toISOString().slice(0, 10),
    tax_year: new Date().getFullYear(),
  },
  sum_employee_amount: 18250,
  sum_employer_amount: 4320,
  sum_gross_amount: 100000,
  sum_taxable_amount: 95000,
};

const SYNTHETIC_CTX_2: Record<string, any> = {
  ...SYNTHETIC_CTX,
  employee: {
    ...SYNTHETIC_CTX.employee,
    first_name: "John",
    last_name: "Smith",
    full_name: "John Smith",
    employee_number: "EMP-002",
  },
  sum_employee_amount: 14500,
  sum_employer_amount: 3260,
  sum_taxable_amount: 78000,
};

function resolvePath(ctx: any, path: string): unknown {
  const parts = path.split(".");
  let cur: any = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Layer pack_token_registry sample_value into a deep-merge fallback. */
function buildRegistryFallback(tokens: PackToken[] | undefined) {
  const fallback: Record<string, any> = {};
  for (const t of tokens ?? []) {
    if (t.sample_value === undefined || t.sample_value === null) continue;
    const parts = t.token_path.split(".");
    let cur: Record<string, any> = fallback;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] ?? {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = t.sample_value;
  }
  return fallback;
}

type SegmentStatus = "ok" | "sample_pending" | "unknown";
interface RenderedSegment {
  kind: "text" | "token";
  value: string;
  status?: SegmentStatus;
  path?: string;
  label?: string;
}

interface ResolveOptions {
  registryFallback?: Record<string, any>;
  registryByPath?: Map<string, PackToken>;
}

export function renderSegments(
  body: string,
  ctx: any = SYNTHETIC_CTX,
  opts: ResolveOptions = {},
): { segments: RenderedSegment[]; unknown: string[]; samplePending: string[] } {
  const segments: RenderedSegment[] = [];
  const unknown: string[] = [];
  const samplePending: string[] = [];
  const regex = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ kind: "text", value: body.slice(lastIndex, m.index) });
    }
    const path = m[1];
    let v = resolvePath(ctx, path);
    if (v === undefined || v === null) {
      v = resolvePath(opts.registryFallback ?? {}, path);
    }
    const token = opts.registryByPath?.get(path);
    if (v !== undefined && v !== null) {
      segments.push({ kind: "text", value: String(v) });
    } else if (token) {
      samplePending.push(path);
      segments.push({
        kind: "token",
        value: String(v ?? ""),
        status: "sample_pending",
        path,
        label: humanizeToken(path, token.description),
      });
    } else {
      unknown.push(path);
      segments.push({
        kind: "token",
        value: "",
        status: "unknown",
        path,
        label: humanizeToken(path, null),
      });
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < body.length) segments.push({ kind: "text", value: body.slice(lastIndex) });
  return { segments, unknown, samplePending };
}

// Legacy export — back-compat for any older caller.
export function renderTokensClient(body: string, ctx: any = SYNTHETIC_CTX) {
  const { segments, unknown } = renderSegments(body, ctx);
  return {
    rendered: segments
      .map((s) => (s.kind === "text" ? s.value : `‹unresolved: ${s.path}›`))
      .join(""),
    missing: unknown,
  };
}

function Segments({
  text,
  registryFallback,
  registryByPath,
}: {
  text: string;
  registryFallback: Record<string, any>;
  registryByPath: Map<string, PackToken>;
}) {
  const { segments } = renderSegments(text, SYNTHETIC_CTX, { registryFallback, registryByPath });
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === "text") return <span key={i}>{s.value}</span>;
        if (s.status === "sample_pending") {
          return (
            <span
              key={i}
              className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-sm bg-muted text-muted-foreground text-[10px] font-medium border border-border"
              title={`Live data will appear here for ${s.path}. Pack has no sample value yet.`}
            >
              Sample pending — {s.label}
            </span>
          );
        }
        return (
          <span
            key={i}
            className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-sm bg-destructive/10 text-destructive text-[10px] font-medium border border-destructive/30"
            title={`Unknown field "${s.path}" — not found in the token registry`}
          >
            Unknown field — {s.label}
          </span>
        );
      })}
    </>
  );
}

// ─── Block-based body extraction (matches renderTemplateBody.ts) ───
type Block = { id?: string; kind?: string; title?: string; content?: string };

function extractBlocks(body: any): Block[] {
  if (!body) return [];
  if (Array.isArray(body.blocks)) return body.blocks as Block[];
  if (typeof body === "string" && body.length > 0)
    return [{ id: "body", kind: "body", title: "Body", content: body }];
  if (typeof body === "object" && !Array.isArray(body)) {
    return Object.entries(body)
      .filter(([, v]) => typeof v === "string" && v.length > 0)
      .map(([k, v]) => ({ id: k, kind: k, title: k, content: v as string }));
  }
  return [];
}

function collectStatuses(
  blocks: Block[],
  registryFallback: Record<string, any>,
  registryByPath: Map<string, PackToken>,
) {
  const unknownSet = new Set<string>();
  const samplePendingSet = new Set<string>();
  for (const b of blocks) {
    const { unknown, samplePending } = renderSegments(
      typeof b.content === "string" ? b.content : "",
      SYNTHETIC_CTX,
      { registryFallback, registryByPath },
    );
    unknown.forEach((u) => unknownSet.add(u));
    samplePending.forEach((s) => samplePendingSet.add(s));
  }
  return { unknown: [...unknownSet], samplePending: [...samplePendingSet] };
}

// ─── Return-template column-body detection ───
type ReturnColumn = { key: string; source: string; label?: string; format?: string };
type ReturnBody = {
  columns?: ReturnColumn[];
  totals?: string[];
  filters?: { rule_codes?: string[] };
};

function isReturnTemplateBody(body: any): body is ReturnBody {
  return body && typeof body === "object" && Array.isArray(body.columns) && body.columns.length > 0;
}

function formatValue(v: unknown, format?: string): string {
  if (v === undefined || v === null) return "—";
  if (format === "currency" && typeof v === "number") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "KES",
      maximumFractionDigits: 2,
    }).format(v);
  }
  if (format === "number" && typeof v === "number") return new Intl.NumberFormat().format(v);
  if (format === "date") return String(v);
  return String(v);
}

interface Props {
  body: any;
  packId?: string | null;
  title?: string;
  /** Optional subtitle, e.g. "Recipient view — Jane Doe, May 2026". */
  subtitle?: string;
}

export function PreviewPanel({ body, packId, title = "Document preview", subtitle }: Props) {
  const { data: tokens } = useTokenRegistry(packId ?? null);
  const registryByPath = useMemo(
    () => new Map((tokens ?? []).map((t) => [t.token_path, t] as const)),
    [tokens],
  );
  const registryFallback = useMemo(() => buildRegistryFallback(tokens), [tokens]);

  // ── Tabular preview for return templates ──
  if (isReturnTemplateBody(body)) {
    const cols = body.columns ?? [];
    const totals = new Set(body.totals ?? []);
    const rowCtxs = [SYNTHETIC_CTX, SYNTHETIC_CTX_2];
    const rowValues = rowCtxs.map((ctx) =>
      cols.map((c) => {
        const v = resolvePath(ctx, c.source);
        return v !== undefined && v !== null ? v : resolvePath(registryFallback, c.source);
      }),
    );
    const totalRow = cols.map((c) => {
      if (!totals.has(c.key)) return null;
      const nums = rowValues
        .map((r) => r[cols.indexOf(c)])
        .filter((v) => typeof v === "number") as number[];
      if (nums.length === 0) return null;
      return nums.reduce((a, b) => a + b, 0);
    });

    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Eye className="h-4 w-4" />
            {title}
            <Badge variant="secondary" className="ml-2 text-[10px]">
              Sample data
            </Badge>
          </CardTitle>
          {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-card p-4 overflow-x-auto">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Statutory Return
                </div>
                <div className="text-base font-semibold">{SYNTHETIC_CTX.organization.name}</div>
                <div className="text-xs text-muted-foreground">
                  Period: {SYNTHETIC_CTX.run.period_label}
                </div>
              </div>
              {body.filters?.rule_codes?.length ? (
                <div className="text-xs text-muted-foreground">
                  Rules: {body.filters.rule_codes.join(", ")}
                </div>
              ) : null}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {cols.map((c) => (
                    <TableHead
                      key={c.key}
                      className={c.format === "currency" || c.format === "number" ? "text-right" : ""}
                    >
                      {c.label || c.key}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rowValues.map((row, i) => (
                  <TableRow key={i}>
                    {row.map((v, j) => (
                      <TableCell
                        key={j}
                        className={
                          cols[j].format === "currency" || cols[j].format === "number"
                            ? "text-right tabular-nums"
                            : ""
                        }
                      >
                        {formatValue(v, cols[j].format)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {totals.size > 0 && (
                  <TableRow className="font-semibold border-t-2">
                    {totalRow.map((v, j) => (
                      <TableCell
                        key={j}
                        className={
                          cols[j].format === "currency" || cols[j].format === "number"
                            ? "text-right tabular-nums"
                            : ""
                        }
                      >
                        {j === 0 && v === null ? "Total" : v === null ? "" : formatValue(v, cols[j].format)}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <div className="mt-4 text-[10px] text-muted-foreground text-center">
              Preview generated with sample employee data — actual return uses live payroll figures.
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Document preview for block-based templates ──
  const blocks = extractBlocks(body);
  const { unknown, samplePending } = collectStatuses(blocks, registryFallback, registryByPath);

  const headerBlocks = blocks.filter((b) => b.kind === "header");
  const bodyBlocks = blocks.filter((b) => b.kind === "body");
  const totalsBlocks = blocks.filter((b) => b.kind === "totals");
  const sigBlocks = blocks.filter((b) => b.kind === "signature");
  const footerBlocks = blocks.filter((b) => b.kind === "footer");
  const customBlocks = blocks.filter(
    (b) => !["header", "body", "totals", "signature", "footer"].includes(b.kind ?? ""),
  );

  const renderInline = (text: string) => (
    <Segments text={text} registryFallback={registryFallback} registryByPath={registryByPath} />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Eye className="h-4 w-4" />
          {title}
          {unknown.length > 0 && (
            <Badge variant="destructive" className="ml-2">
              {unknown.length} unknown field{unknown.length === 1 ? "" : "s"}
            </Badge>
          )}
          {samplePending.length > 0 && unknown.length === 0 && (
            <Badge variant="secondary" className="ml-2">
              {samplePending.length} sample pending
            </Badge>
          )}
        </CardTitle>
        <div className="text-xs text-muted-foreground">
          {subtitle ?? `Recipient view — ${SYNTHETIC_CTX.employee.full_name}, ${SYNTHETIC_CTX.run.period_label}`}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {unknown.length > 0 && (
          <div className="text-xs text-destructive">
            Fields not in the token registry:{" "}
            {unknown.map((u) => (
              <span key={u} className="mx-1 font-medium" title={u}>
                {humanizeToken(u, null)}
              </span>
            ))}
          </div>
        )}

        {/* Paper-styled document surface */}
        <div className="rounded-md border bg-card shadow-sm mx-auto p-8 max-w-3xl space-y-4 text-sm leading-relaxed overflow-x-auto">
          {blocks.length === 0 && (
            <div className="text-center text-muted-foreground py-8 text-xs">
              Add blocks above to see the document preview.
            </div>
          )}

          {headerBlocks.length > 0 && (
            <div className="text-center space-y-1 border-b pb-3">
              {headerBlocks.map((b) => (
                <div
                  key={b.id ?? b.title}
                  className="text-base font-semibold whitespace-pre"
                >
                  {renderInline(b.content ?? "")}
                </div>
              ))}
            </div>
          )}

          {bodyBlocks.length > 0 && (
            <div className="space-y-2">
              {bodyBlocks.map((b) => (
                <p key={b.id ?? b.title} className="whitespace-pre">
                  {renderInline(b.content ?? "")}
                </p>
              ))}
            </div>
          )}

          {blocks.length > 0 && (
            <div className="rounded border overflow-hidden my-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Earnings</TableHead>
                    <TableHead className="text-right">Deductions</TableHead>
                    <TableHead className="text-right">Net Pay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>May 2026</TableCell>
                    <TableCell className="text-right tabular-nums">100,000.00</TableCell>
                    <TableCell className="text-right tabular-nums">29,750.00</TableCell>
                    <TableCell className="text-right tabular-nums">70,250.00</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Apr 2026</TableCell>
                    <TableCell className="text-right tabular-nums">100,000.00</TableCell>
                    <TableCell className="text-right tabular-nums">29,750.00</TableCell>
                    <TableCell className="text-right tabular-nums">70,250.00</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          {totalsBlocks.length > 0 && (
            <div className="flex justify-end">
              <div className="text-right space-y-1 min-w-[200px]">
                {totalsBlocks.map((b) => (
                  <div key={b.id ?? b.title} className="whitespace-pre font-medium">
                    {renderInline(b.content ?? "")}
                  </div>
                ))}
              </div>
            </div>
          )}

          {customBlocks.length > 0 && (
            <div className="space-y-2 text-sm border-t pt-3">
              {customBlocks.map((b) => (
                <div key={b.id ?? b.title} className="whitespace-pre">
                  {renderInline(b.content ?? "")}
                </div>
              ))}
            </div>
          )}

          {sigBlocks.length > 0 && (
            <div className="text-center text-xs text-muted-foreground pt-6 border-t mt-6">
              {sigBlocks.map((b) => (
                <div key={b.id ?? b.title} className="whitespace-pre">
                  {renderInline(b.content ?? "")}
                </div>
              ))}
            </div>
          )}

          {footerBlocks.length > 0 && (
            <div className="text-center text-[10px] text-muted-foreground pt-4">
              {footerBlocks.map((b) => (
                <div key={b.id ?? b.title} className="whitespace-pre">
                  {renderInline(b.content ?? "")}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="text-[10px] text-muted-foreground text-center">
          Sample employee · {SYNTHETIC_CTX.organization.name} · {SYNTHETIC_CTX.run.period_label}
        </div>
      </CardContent>
    </Card>
  );
}

export const __SYNTHETIC_CTX = SYNTHETIC_CTX;
