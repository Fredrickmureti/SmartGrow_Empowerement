/**
 * XLSX medium renderer — same frozen snapshot as the PDF and the CSV,
 * flattened onto a single worksheet.
 *
 * The sections are stacked with the widest header row driving the sheet
 * width, so a statement's masthead, transactions and aging all land in one
 * tab in the order a reader expects.
 */

import type { AstBlock, RenderContext, ResolvedTemplate } from "../types.ts";
import { snapshotToTable } from "../../exports/snapshotToTable.ts";
import { writeXlsx } from "../../xlsxWriter.ts";

export async function renderAstToXlsx(args: {
  template: ResolvedTemplate;
  context: RenderContext;
  blocks: AstBlock[];
}): Promise<{ bytes: Uint8Array; metadata: Record<string, unknown> }> {
  const table = snapshotToTable(args.context);

  const width = Math.max(
    1,
    ...table.sections.map((s) =>
      Math.max(s.headers?.length ?? 0, ...s.rows.map((r) => r.length), 0),
    ),
  );
  const pad = (row: Array<string | number | null>) => {
    const out: Array<string | number | null> = [...row];
    while (out.length < width) out.push(null);
    return out;
  };

  const rows: Array<Array<string | number | null>> = [];
  for (const section of table.sections) {
    if (rows.length) rows.push(pad([]));
    if (section.caption) rows.push(pad([section.caption]));
    if (section.headers) rows.push(pad(section.headers));
    for (const row of section.rows) rows.push(pad(row));
  }

  // Sheet names are capped at 31 chars and may not contain []:*?/\
  const sheetName = table.title.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Document";

  const bytes = await writeXlsx({
    name: sheetName,
    headers: pad([table.title]).map((v) => (v === null ? "" : String(v))),
    rows,
  });

  return {
    bytes,
    metadata: { export_format: "xlsx", section_count: table.sections.length },
  };
}
