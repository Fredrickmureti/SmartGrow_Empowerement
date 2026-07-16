/**
 * ReturnFormatPreview — routes the statutory-return live preview to the
 * renderer that matches the template's declared submission format.
 *
 *   - csv / xlsx  → SpreadsheetPreviewPane (columns + sample rows,
 *                   with a delimiter/encoding/extension footer strip)
 *   - xml / json  → serialised sample output in a scrollable code block
 *   - pdf         → v2 section PDF (ReturnPreviewPane) when the template
 *                   opted in, otherwise the tabular PreviewPanel fallback
 *
 * When no submission format is set we default to the tabular spreadsheet
 * view rather than a PDF (a return template with only `columns[]` is a
 * CSV/XLSX artefact — the empty PDF that publishers saw for e.g.
 * `P10 (iTax CSV)` was the wrong default).
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Code2 } from "lucide-react";
import { PreviewPanel } from "../PreviewPanel";
import { ReturnPreviewPane } from "../ReturnPreviewPane";
import {
  SpreadsheetPreviewPane,
  type SpreadsheetPreviewColumn,
  type SpreadsheetPreviewProps,
} from "./SpreadsheetPreviewPane";

export type ReturnSubmissionFormatKind = "csv" | "xlsx" | "xml" | "json" | "pdf";
export interface ReturnSubmissionFormatSpec {
  kind?: ReturnSubmissionFormatKind;
  options?: Record<string, any>;
}

interface ReturnColumn {
  key: string;
  source: string;
  label?: string;
  format?: string;
  width?: number;
}

interface ReturnBodyLike {
  columns?: ReturnColumn[];
  totals?: string[];
  filters?: { rule_codes?: string[] };
  renderer?: string | null;
  sections?: unknown[];
}

interface Meta {
  legal_reference?: string | null;
  regulation_citation?: string | null;
  authority_name?: string | null;
  submission_format?: ReturnSubmissionFormatSpec | null;
}

interface Props {
  templateCode: string;
  displayName?: string | null;
  body: ReturnBodyLike;
  meta?: Meta | null;
  packId?: string | null;
}

// ── Synthetic sample rows (country-agnostic) ─────────────────────────
const SAMPLE_ROWS = [
  {
    employee: { full_name: "Jane Doe",   tax_pin: "A012345678W", national_id: "12345678", employee_number: "EMP-001" },
    sum_employee_amount: 45200, sum_employer_amount: 2160,
    sum_gross_amount: 100000, sum_taxable_amount: 95000, sum_total_amount: 47360, count_payslips: 1,
  },
  {
    employee: { full_name: "John Smith", tax_pin: "A023456789X", national_id: "22345678", employee_number: "EMP-002" },
    sum_employee_amount: 32450, sum_employer_amount: 2160,
    sum_gross_amount: 82000,  sum_taxable_amount: 78000, sum_total_amount: 34610, count_payslips: 1,
  },
  {
    employee: { full_name: "Amina Hassan", tax_pin: "A034567890Y", national_id: "32345678", employee_number: "EMP-003" },
    sum_employee_amount: 27100, sum_employer_amount: 2160,
    sum_gross_amount: 71000,  sum_taxable_amount: 68000, sum_total_amount: 29260, count_payslips: 1,
  },
];

function resolvePath(ctx: any, path: string): unknown {
  const parts = path.split(".");
  let cur: any = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function isNumericFormat(f?: string) {
  return f === "currency" || f === "number";
}

function buildSpreadsheetProps(
  body: ReturnBodyLike,
  meta: Meta | null | undefined,
  formatKind: ReturnSubmissionFormatKind,
): SpreadsheetPreviewProps {
  const cols: SpreadsheetPreviewColumn[] = (body.columns ?? []).map((c) => ({
    header: c.label || c.key,
    token: c.source,
    numeric: isNumericFormat(c.format),
    width: c.width,
    format: c.format ?? null,
  }));
  const rows = SAMPLE_ROWS.map((ctx) =>
    (body.columns ?? []).map((c) => {
      const v = resolvePath(ctx, c.source);
      if (v === undefined || v === null) return "";
      return v as string | number;
    }),
  );

  // Totals row
  const totals = new Set(body.totals ?? []);
  if (totals.size) {
    const totalRow = (body.columns ?? []).map((c, i) => {
      if (!totals.has(c.key)) return i === 0 ? "TOTAL" : "";
      const nums = rows.map((r) => r[i]).filter((v) => typeof v === "number") as number[];
      return nums.reduce((a, b) => a + b, 0);
    });
    rows.push(totalRow);
  }

  const opts = meta?.submission_format?.options ?? {};
  const delimiter =
    formatKind === "csv"
      ? typeof opts.delimiter === "string" ? opts.delimiter : ","
      : formatKind === "xlsx" ? "cell" : undefined;
  const encoding = typeof opts.encoding === "string" ? opts.encoding : formatKind === "csv" ? "utf-8" : undefined;
  const ext = formatKind === "csv" ? "csv" : formatKind === "xlsx" ? "xlsx" : undefined;

  const formatLabel =
    formatKind === "csv" ? "CSV — column export"
    : formatKind === "xlsx" ? "Excel workbook (.xlsx)"
    : formatKind === "xml" ? "XML payload"
    : formatKind === "json" ? "JSON payload"
    : undefined;

  return {
    title: "Live preview",
    formatLabel,
    columns: cols,
    rows,
    delimiter,
    encoding,
    fileExtension: ext,
    footnote:
      meta?.regulation_citation ||
      meta?.legal_reference ||
      "Sample rows — actual return uses live payroll figures.",
  };
}

function toSerialisedRows(body: ReturnBodyLike) {
  return SAMPLE_ROWS.map((ctx) => {
    const row: Record<string, unknown> = {};
    for (const c of body.columns ?? []) {
      row[c.key] = resolvePath(ctx, c.source) ?? null;
    }
    return row;
  });
}

function XmlJsonPreview({
  body,
  meta,
  kind,
}: {
  body: ReturnBodyLike;
  meta: Meta | null | undefined;
  kind: "xml" | "json";
}) {
  const rows = toSerialisedRows(body);
  const totalsKeys = body.totals ?? [];
  const totals: Record<string, number> = {};
  for (const k of totalsKeys) {
    totals[k] = rows.reduce((s, r) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  }

  let text: string;
  if (kind === "json") {
    text = JSON.stringify(
      {
        template: undefined,
        period: { start: "2026-05-01", end: "2026-05-31", label: "May 2026" },
        rows,
        totals,
      },
      null,
      2,
    );
  } else {
    const esc = (v: unknown) => String(v ?? "").replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m] as string));
    const rowXml = rows
      .map(
        (r) =>
          `  <Row>\n` +
          (body.columns ?? []).map((c) => `    <${c.key}>${esc(r[c.key])}</${c.key}>`).join("\n") +
          `\n  </Row>`,
      )
      .join("\n");
    const totalsXml = Object.entries(totals)
      .map(([k, v]) => `  <Total field="${esc(k)}">${esc(v)}</Total>`)
      .join("\n");
    text = `<?xml version="1.0" encoding="UTF-8"?>\n<Return>\n${rowXml}${totalsXml ? "\n" + totalsXml : ""}\n</Return>`;
  }

  return (
    <Card className="flex h-full min-h-0 w-full flex-col overflow-hidden border-0 shadow-none">
      <CardHeader className="shrink-0 pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Code2 className="h-4 w-4" /> Live preview
          <Badge variant="outline" className="text-[10px]">
            {kind.toUpperCase()} payload
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-2">
        <pre className="h-full min-h-0 w-full overflow-auto rounded border bg-muted/20 p-3 font-mono text-[11px] leading-relaxed">
          {text}
        </pre>
        {(meta?.regulation_citation || meta?.legal_reference) && (
          <div className="pt-2 text-[10px] text-muted-foreground">
            {meta?.regulation_citation ?? meta?.legal_reference}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ReturnFormatPreview({ templateCode, displayName, body, meta, packId }: Props) {
  const declared = meta?.submission_format?.kind ?? null;
  const hasV2 = body.renderer === "v2-returns" && Array.isArray(body.sections);
  // Inferred kind: declared > v2 renderer forces PDF > default to CSV
  // whenever the body only defines `columns[]` (that's a tabular export,
  // NOT a PDF — publishers saw an empty PDF here before this route).
  const kind: ReturnSubmissionFormatKind = declared ?? (hasV2 ? "pdf" : "csv");

  if (kind === "pdf") {
    if (hasV2) {
      return (
        <ReturnPreviewPane
          templateCode={templateCode}
          displayName={displayName ?? templateCode}
          body={body}
          meta={meta as any}
        />
      );
    }
    // PDF was requested but the template has no v2 sections — fall back
    // to the tabular PreviewPanel so the publisher at least sees the
    // columns they configured (still better than a blank PDF).
    return (
      <PreviewPanel
        body={body}
        packId={packId ?? null}
        title="Statutory return preview (PDF format — no v2 sections yet)"
      />
    );
  }

  if (kind === "xml" || kind === "json") {
    return <XmlJsonPreview body={body} meta={meta} kind={kind} />;
  }

  return <SpreadsheetPreviewPane {...buildSpreadsheetProps(body, meta, kind)} />;
}

export default ReturnFormatPreview;
