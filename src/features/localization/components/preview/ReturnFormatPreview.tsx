/**
 * ReturnFormatPreview — thin adapter that (1) derives the effective
 * submission format from template metadata, (2) builds the tabular
 * `SpreadsheetPreviewProps` for spreadsheet-family formats, and (3)
 * hands off to the shared `resolveReturnRenderer` descriptor.
 *
 * All renderer selection lives in `lib/preview/rendererRegistry` — this
 * component only prepares inputs and delegates.
 */
import { useEffect, useMemo, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FileWarning } from "lucide-react";
import {
  SpreadsheetPreviewColumn,
  type SpreadsheetPreviewProps,
} from "./SpreadsheetPreviewPane";
import {
  resolveReturnRenderer,
  describeReturnFormat,
  type ReturnFormatKind,
} from "../../lib/preview/rendererRegistry";
import {
  SAMPLE_PAYROLL_ROWS,
  resolveSamplePath,
} from "../../lib/preview/samplePayload";

export type ReturnSubmissionFormatKind = ReturnFormatKind;
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
}

interface OutputEntry {
  format: string;
  role?: string;
  label?: string | null;
  filename?: string | null;
}

interface Meta {
  legal_reference?: string | null;
  regulation_citation?: string | null;
  authority_name?: string | null;
  submission_format?: ReturnSubmissionFormatSpec | null;
  outputs?: OutputEntry[] | null;
}

interface Props {
  templateCode: string;
  displayName?: string | null;
  body: ReturnBodyLike;
  meta?: Meta | null;
  packId?: string | null;
}

function isNumericFormat(f?: string) {
  return f === "currency" || f === "number";
}

function buildSpreadsheetProps(
  body: ReturnBodyLike,
  meta: Meta | null | undefined,
  formatKind: ReturnFormatKind,
): SpreadsheetPreviewProps {
  const cols: SpreadsheetPreviewColumn[] = (body.columns ?? []).map((c) => ({
    header: c.label || c.key,
    token: c.source,
    numeric: isNumericFormat(c.format),
    width: c.width,
    format: c.format ?? null,
  }));
  const rows = SAMPLE_PAYROLL_ROWS.map((ctx) =>
    (body.columns ?? []).map((c) => {
      const v = resolveSamplePath(ctx, c.source);
      if (v === undefined || v === null) return "";
      return v as string | number;
    }),
  );

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
  const encoding =
    typeof opts.encoding === "string" ? opts.encoding : formatKind === "csv" ? "utf-8" : undefined;
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

const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(["csv", "xlsx", "xml", "json", "pdf"]);

/**
 * Derive the effective renderable formats from `meta.outputs[]`
 * (ground truth per ADR 0063). Falls back to `meta.submission_format`
 * or the implicit CSV/PDF split for legacy rows.
 */
function resolveFormats(meta: Meta | null | undefined): ReturnFormatKind[] {
  const outputs = (meta?.outputs ?? []).filter((o) => SUPPORTED_FORMATS.has(o.format));
  if (outputs.length) {
    // Preserve author order; deduplicate.
    const seen = new Set<string>();
    const list: ReturnFormatKind[] = [];
    for (const o of outputs) {
      if (seen.has(o.format)) continue;
      seen.add(o.format);
      list.push(o.format as ReturnFormatKind);
    }
    return list;
  }
  const declared = meta?.submission_format?.kind ?? null;
  return [declared ?? "csv"];
}

function renderSingle(
  formatKind: ReturnFormatKind,
  { templateCode, displayName, body, meta, packId }: Props,
) {
  const descriptor = resolveReturnRenderer(formatKind);
  const spreadsheetProps =
    formatKind === "csv" || formatKind === "xlsx"
      ? buildSpreadsheetProps(body, meta, formatKind)
      : undefined;
  return descriptor.render({
    templateCode,
    displayName,
    body,
    meta,
    packId,
    spreadsheetProps,
  });
}

function tabStorageKey(templateCode: string) {
  return `lz.preview.return.tab.${templateCode}`;
}

export function ReturnFormatPreview(props: Props) {
  const { templateCode, body, meta } = props;
  const formats = useMemo(() => resolveFormats(meta), [meta]);

  const declaredNothing =
    (!meta?.outputs || meta.outputs.length === 0) && !meta?.submission_format?.kind;

  // Persist the selected tab per (templateCode) so a publisher who
  // returns to the editor lands on the same output they inspected last.
  const [active, setActive] = useState<string>(() => {
    if (typeof window === "undefined") return formats[0];
    try {
      const stored = window.localStorage.getItem(tabStorageKey(templateCode));
      if (stored && formats.includes(stored as ReturnFormatKind)) return stored;
    } catch { /* ignore */ }
    return formats[0];
  });
  useEffect(() => {
    if (!formats.includes(active as ReturnFormatKind)) setActive(formats[0]);
  }, [formats, active]);
  useEffect(() => {
    try { window.localStorage.setItem(tabStorageKey(templateCode), active); } catch { /* ignore */ }
  }, [templateCode, active]);

  if (declaredNothing) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <Alert className="max-w-md">
          <FileWarning className="h-4 w-4" />
          <AlertTitle>No output format declared</AlertTitle>
          <AlertDescription className="text-xs">
            Add at least one output in the <em>Outputs</em> section — the
            preview will render the primary output. CSV/XLSX show a
            spreadsheet, XML/JSON show a serialised payload, PDF
            renders through the shared paged pipeline.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (formats.length === 1) {
    return <>{renderSingle(formats[0], props)}</>;
  }

  return (
    <Tabs value={active} onValueChange={setActive} className="flex h-full min-h-0 flex-col">
      <TabsList className="mx-4 mt-3 self-start">
        {formats.map((f) => (
          <TabsTrigger key={f} value={f} className="text-xs">
            {describeReturnFormat(f)}
          </TabsTrigger>
        ))}
      </TabsList>
      {formats.map((f) => (
        <TabsContent key={f} value={f} className="min-h-0 flex-1 outline-none">
          {renderSingle(f, props)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export default ReturnFormatPreview;
