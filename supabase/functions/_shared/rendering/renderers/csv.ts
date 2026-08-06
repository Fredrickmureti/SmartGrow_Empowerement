/**
 * CSV medium renderer — an export is a disposition of the canonical
 * document, so it renders from the same frozen snapshot as the PDF.
 *
 * RFC 4180: CRLF separators, `"` doubling, UTF-8 BOM so Excel and Numbers
 * detect the encoding without an import wizard.
 */

import type { AstBlock, RenderContext, ResolvedTemplate } from "../types.ts";
import { snapshotToTable } from "../../exports/snapshotToTable.ts";

const CRLF = "\r\n";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: Array<unknown>): string {
  return cells.map(csvCell).join(",");
}

export function renderAstToCsv(args: {
  template: ResolvedTemplate;
  context: RenderContext;
  blocks: AstBlock[];
}): { bytes: Uint8Array; metadata: Record<string, unknown> } {
  const table = snapshotToTable(args.context);
  const lines: string[] = [csvRow([table.title])];

  for (const section of table.sections) {
    lines.push("");
    if (section.caption) lines.push(csvRow([section.caption]));
    if (section.headers) lines.push(csvRow(section.headers));
    for (const row of section.rows) lines.push(csvRow(row));
  }

  const body = "\uFEFF" + lines.join(CRLF) + CRLF;
  return {
    bytes: new TextEncoder().encode(body),
    metadata: {
      export_format: "csv",
      section_count: table.sections.length,
    },
  };
}
