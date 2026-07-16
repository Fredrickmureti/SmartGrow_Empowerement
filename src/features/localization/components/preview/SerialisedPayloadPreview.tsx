/**
 * SerialisedPayloadPreview — renders the sample statutory-return
 * payload as XML or JSON. Extracted from `ReturnFormatPreview` as part
 * of Phase B (renderer registry) so both the split-pane preview and
 * the pop-out window can mount it through the same descriptor.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Code2 } from "lucide-react";
import {
  SAMPLE_PAYROLL_ROWS,
  SAMPLE_PERIOD,
  resolveSamplePath,
} from "../../lib/preview/samplePayload";

interface ReturnColumnLike {
  key: string;
  source: string;
}
interface ReturnBodyLike {
  columns?: ReturnColumnLike[];
  totals?: string[];
}
interface MetaLike {
  legal_reference?: string | null;
  regulation_citation?: string | null;
}

export interface SerialisedPayloadPreviewProps {
  body: ReturnBodyLike;
  meta?: MetaLike | null;
  kind: "xml" | "json";
}

function toRows(body: ReturnBodyLike) {
  return SAMPLE_PAYROLL_ROWS.map((ctx) => {
    const row: Record<string, unknown> = {};
    for (const c of body.columns ?? []) {
      row[c.key] = resolveSamplePath(ctx, c.source) ?? null;
    }
    return row;
  });
}

export function SerialisedPayloadPreview({ body, meta, kind }: SerialisedPayloadPreviewProps) {
  const rows = toRows(body);
  const totalsKeys = body.totals ?? [];
  const totals: Record<string, number> = {};
  for (const k of totalsKeys) {
    totals[k] = rows.reduce(
      (s, r) => s + (typeof r[k] === "number" ? (r[k] as number) : 0),
      0,
    );
  }

  let text: string;
  if (kind === "json") {
    text = JSON.stringify(
      {
        period: SAMPLE_PERIOD,
        rows,
        totals,
      },
      null,
      2,
    );
  } else {
    const esc = (v: unknown) =>
      String(v ?? "").replace(
        /[<>&]/g,
        (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m] as string),
      );
    const rowXml = rows
      .map(
        (r) =>
          `  <Row>\n` +
          (body.columns ?? [])
            .map((c) => `    <${c.key}>${esc(r[c.key])}</${c.key}>`)
            .join("\n") +
          `\n  </Row>`,
      )
      .join("\n");
    const totalsXml = Object.entries(totals)
      .map(([k, v]) => `  <Total field="${esc(k)}">${esc(v)}</Total>`)
      .join("\n");
    text =
      `<?xml version="1.0" encoding="UTF-8"?>\n<Return>\n${rowXml}` +
      `${totalsXml ? "\n" + totalsXml : ""}\n</Return>`;
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

export default SerialisedPayloadPreview;
